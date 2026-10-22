#!/bin/sh
# Проверка: не блокирует ли /batch-test event loop.
# Пока идёт пакетный прогон, /health должен отвечать быстро и стабильно.
set -u
BASE=${BASE:-http://localhost:3001}
OUT=/tmp/conc-result.txt
: > "$OUT"

echo "=== старт прогона 5000 начислений ===" >> "$OUT"
curl -s --max-time 600 -X POST "$BASE/batch-test" \
  -H 'Content-Type: application/json' \
  -d '{"numWorkers":6,"iterations":5000}' -o /tmp/conc-batch.json &
BPID=$!

sleep 1
echo "=== опрос /health во время прогона ===" >> "$OUT"
OK=0; FAIL=0; MAX=0; SUM=0; N=0
for i in $(seq 1 20); do
  T0=$(date +%s%N)
  C=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$BASE/health")
  T1=$(date +%s%N)
  MS=$(( (T1 - T0) / 1000000 ))
  N=$((N + 1)); SUM=$((SUM + MS))
  [ "$MS" -gt "$MAX" ] && MAX=$MS
  if [ "$C" = "200" ]; then OK=$((OK + 1)); else FAIL=$((FAIL + 1)); fi
  echo "  проба $i: http=$C ${MS}ms" >> "$OUT"
  # прогон может закончиться раньше — тогда прекращаем опрос
  kill -0 "$BPID" 2>/dev/null || { echo "  (прогон завершился на пробе $i)" >> "$OUT"; break; }
  sleep 0.5
done

wait "$BPID" 2>/dev/null
echo "=== итог ===" >> "$OUT"
AVG=$((SUM / N))
echo "проб: $N | успешных: $OK | неудачных: $FAIL" >> "$OUT"
echo "латентность /health: avg ${AVG}ms, max ${MAX}ms" >> "$OUT"
if [ "$FAIL" -eq 0 ]; then echo "РЕЗУЛЬТАТ: event loop НЕ блокируется" >> "$OUT"
else echo "РЕЗУЛЬТАТ: ПРОВАЛ — $FAIL проб не прошли" >> "$OUT"; fi

echo "=== ответ batch ===" >> "$OUT"
node -e '
try{
  const j=JSON.parse(require("fs").readFileSync("/tmp/conc-batch.json","utf8"));
  console.log("запрошено:",j.requested,"| выполнено:",j.completed);
  console.log("начислено:",Number(j.totalRewardTar).toFixed(6),"TAR | сожжено:",Number(j.totalBurnedTar).toFixed(6));
  console.log("среднее начисление:",Number(j.meanRewardTar).toFixed(6),"TAR | нулевых:",j.zeroRewardCount);
}catch(e){console.log("RAW:",require("fs").readFileSync("/tmp/conc-batch.json","utf8").slice(0,300));}
' >> "$OUT" 2>&1
