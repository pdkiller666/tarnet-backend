# MIGRATION — переезд TarNet на другой хост

**Цель:** рабочая копия на новом хосте за 10–15 минут.
**Предусловие:** у нового хоста есть домен, A-запись которого указывает на него. Без этого TLS не выпустится (Caddy ждёт DNS), и внешняя проверка упадёт — хотя сервер будет работать.

Два скрипта: `scripts/backup.sh` (снять состояние) и `scripts/bootstrap.sh` (поднять на новом месте).

---

## 0. Почему переезд вообще нужен

Замер, не мнение: 11.11.2026 20:2x MSK, `check-host.net`, 12 узлов, `GET https://v1107336.hosted-by-vdsina.com/health`.

| Узлы | Результат |
|---|---|
| de2, fr2, hu1, id1, il2, ir4, ir7, rs1, us1, us2, us5 — 11 шт. | HTTP 200, 0.039–0.694 с |
| **ru2 (Россия)** | **Connection timed out, 18.2 с** |

Из России прод недоступен, из остального мира — доступен. Плюс домен — поддомен `hosted-by-vdsina.com`: A-запись в чужой зоне не отредактировать, значит переезд требует **своего** домена.

---

## 1. Бэкап на старом хосте (1–2 минуты)

```bash
ssh -i ~/.openclaw/ssh/tarnet_vps root@195.63.131.172
cd /opt/tarnet/backend-api
sudo ./scripts/backup.sh
```

Ожидаемый вывод — одна строка JSON:

```json
{"ok":true,"archive":"/var/backups/tarnet/tarnet-2026-11-11T20-24-25.tar.gz",
 "bytes":1100271,"sha256":"1e2f04f7...","db_bytes":2310144,"files":27,
 "commit":"6559b6704c...","ts":"2026-11-11T20:24:26+03:00"}
```

Что делать, если `ok:false`:

| Ошибка | Причина | Что делать |
|---|---|---|
| `нужен root` | запущено не от root | `sudo` |
| `нет БД: ...` | `TARNET_DB` не тот | `TARNET_DB=/var/lib/tarnet/tarnet.db sudo -E ./scripts/backup.sh` |
| `snapshot не удался` | БД занята/битая | `journalctl -u tarnet -n 30`; проверить `node scripts/sqlite-tool.js verify /var/lib/tarnet/tarnet.db` |
| `в архиве нет ...` | архив собран неполно | архив **удаляется автоматически** — непроверенный не оставляется на диске |

В архиве 27 файлов: БД, два ключа, `rclone.conf`, `litestream-tarnet.yml`, `peer-id.bin` ×2, allowlist, шесть systemd-юнитов + три drop-in'а, `Caddyfile`, пять канонических документов, `MANIFEST.txt` с sha256 каждого файла.

**Чего в архиве нет и почему:** `node_modules` (839 МБ без GPU, 567 МБ с `ONNXRUNTIME_NODE_INSTALL=skip` — ставится на месте), `storage/experience` (датасеты, не нужны для старта), старые `backups/*.db` (исторические снимки).

---

## 2. Перенос архива (10 секунд)

```bash
# со старого хоста на локальную машину
scp root@195.63.131.172:/var/backups/tarnet/tarnet-2026-11-11T20-24-25.tar.gz ./

# с локальной машины на новый хост
scp tarnet-2026-11-11T20-24-25.tar.gz root@NEW_HOST:/root/
```

Проверка целостности после переноса — обе суммы должны совпасть:

```bash
sha256sum tarnet-*.tar.gz
# сверь с полем "sha256" из вывода backup.sh
```

---

## 3. Код на новый хост (30 секунд)

```bash
ssh root@NEW_HOST
git clone https://github.com/pdkiller666/tarnet-backend.git /opt/tarnet/backend-api
cd /opt/tarnet/backend-api && git rev-parse --short HEAD
```

Ожидаемо: тот же коммит, что в поле `commit` бэкапа. Если новее — не страшно, но тогда `buildVersion` после старта будет другим, и это надо понимать заранее.

Если GitHub недоступен с нового хоста — перенеси `git bundle`:

```bash
# на старом хосте
cd /opt/tarnet/backend-api && git bundle create /tmp/tarnet.bundle --tags main
scp /tmp/tarnet.bundle root@NEW_HOST:/tmp/
# на новом
git clone /tmp/tarnet.bundle /opt/tarnet/backend-api
```

---

## 4. Развёртывание (5–8 минут)

```bash
ssh root@NEW_HOST
cd /opt/tarnet/backend-api
sudo ./scripts/bootstrap.sh --domain=tarnet.example.com \
     --restore=/root/tarnet-2026-11-11T20-24-25.tar.gz
```

Скрипт идёт по шагам и печатает `[01]…[11]`. Что должно быть в конце:

```
[11] проверка
     ✅ локально /health 200, buildVersion <совпадает с package.json>
     ✅ снаружи https://tarnet.example.com/health → 200

{"ok":true,"domain":"tarnet.example.com","commit":"<SHA этого коммита>","buildVersion":"<из /health>",
 "health_local":"200","health_external":"200"}
```

На что смотреть по шагам:

| Шаг | Признак проблемы |
|---|---|
| `[02] swap` | `RAM 1024 МБ — создан swap 2 ГБ` — норма для 1–2 ГБ; **с 1 ГБ swap установка падает** на распаковке `onnxruntime` (`code 137`) |
| `[03] пакеты` | `node v18…` → скрипт сам поставит NodeSource 22 (в Debian 12 apt даёт 18, а нужен `node:sqlite`) |
| `[05] код` | `git clone` упал → переноси bundle (см. шаг 3) |
| `[06] зависимости` | `npm ci` в `p2p-node` — **отдельный** lock; корневой его не покрывает. `onnxruntime-node не грузится` → нет `libstdc++` или не тот arch |
| `[07] восстановление` | `нет secrets/master.key` → БД нерасшифровываема, архив неполный, пересобери бэкап |
| `[09] systemd` | `systemd не видит TARNET_PUBLIC_URL` → drop-in не применился, `daemon-reload` не прошёл |
| `[11] проверка` | `снаружи → 000` → A-запись ещё не указывает на новый хост |

---

## 5. DNS (5 минут + ожидание TTL)

```bash
dig +short tarnet.example.com
# должен вернуть IP нового хоста
```

Порядок важен: **сначала** A-запись, **потом** ждать. Caddy выпустит сертификат сам, как только домен начнёт резолвиться сюда. Если поменять DNS после `bootstrap.sh` — внешняя проверка упадёт на шаге `[11]`, это ожидаемо, повтори:

```bash
curl -I https://tarnet.example.com/health
systemctl reload caddy
```

**Старый домен не переиспользовать.** `v1107336.hosted-by-vdsina.com` — поддомен зоны VDSina; A-запись в чужой зоне не редактируется.

---

## 6. Проверка после переезда

```bash
# 1. сервисы
systemctl is-active tarnet p2p-bridge tarnet-seed2 caddy

# 2. версия из живого ответа, не из package.json
curl -s https://tarnet.example.com/health | node -pe 'JSON.parse(require("fs").readFileSync(0)).buildVersion'

# 3. данные на месте — сверь с бэкапом
curl -s https://tarnet.example.com/summary | node -pe 'JSON.parse(require("fs").readFileSync(0)).receipts'

# 4. порты
ss -tlnp | grep -E ':(3001|4001|4002|443)'

# 5. peer-id перенёсся (узел не сменил личность)
ls -la /var/lib/tarnet/p2p/peer-id.bin

# 6. тесты
cd /opt/tarnet/backend-api && node test-dpouw.js | tail -3
```

`receipts` после переезда должен совпасть с тем, что было на старом хосте (806 на момент снятия инвентаря), плюс всё, что пришло за время переезда.

---

## 7. Что НЕ переезжает и почему

| Что | Почему |
|---|---|
| Воркер | Это ПК владельца, не сервер. Он придёт по DHT сам, когда поднимется `p2p-bridge`. `active_p2p_workers: 0` сразу после переезда — не дефект |
| `node_modules` | 567 МБ (без CUDA) или 839 МБ (с `--with-cuda`), ставится `npm ci` на месте |
| Caddy-сертификаты | Выпускаются заново под новый домен |
| `storage/experience` | Датасеты Knowledge Loop; для старта не нужны |
| `backups/*.db` | Исторические снимки, остаются на старом хосте в бэкапе |

**Про воркер отдельно:** после переезда воркер найдёт новый адрес через DHT только если узнает seed. Если он был привязан к старому `multiaddr` — потребуется перезапуск воркера у владельца с новым `P2P_SEED_PEERS`. Это ручной шаг, и его нельзя забыть: иначе `found: 0` будет выглядеть как «discovery сломался».

---

## 8. Откат

Старый хост не выключать, пока новый не проверен. Откат = вернуть DNS на старый IP:

```bash
# старый хост продолжает работать всё время переезда
systemctl is-active tarnet   # на старом: активен
```

Если новый хост не поднялся — ничего не потеряно: старый работает, бэкап лежит. `bootstrap.sh` не трогает старую машину (он работает только на том хосте, где запущен).

---

## 9. Чего этот документ не обещает

- **Времени «10 минут» на всё.** 10–15 минут — это шаги 1, 2, 4 при готовом DNS. Выпуск сертификата и распространение DNS идут своим темпом.
- **Что переезд решает доступность из РФ.** Он решает её только если новый хост сам доступен из РФ — это отдельная проверка (`docs/HOSTING-CHECKLIST.md`).
- **Что `bootstrap.sh` проверен на чистом хосте.** На 11.11.2026 полного прогона на чистой машине не было: на gateway нет docker/podman, на проде нет `debootstrap`, покупка VPS требует владельца. Проверено замером: синтаксис, подстановка домена, `caddy validate`, `npm ci` на копии без `node_modules` (три прогона: без swap → `code 137` OOM, с 1 ГБ swap → `code 137`, с 2 ГБ → `RC=0`, с `ONNXRUNTIME_NODE_INSTALL=skip` → `RC=0`), живой прогон `backup.sh`. Не проверено: старт systemd-юнитов на чистой ОС, выпуск TLS, `--restore` на живой системе. Полная таблица — `docs/STAGE-PORTABILITY.md`.
