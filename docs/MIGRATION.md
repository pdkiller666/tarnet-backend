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

### 1.0 Сначала почистить хост — иначе мусор останется мусором

В архив едет не весь диск, а 27 отобранных файлов, поэтому `chs` и `piitest` в него не попадут. Но чистка всё равно обязательна: она освобождает место на старом хосте и убирает процессы, которые продолжают жрать RAM в момент снятия снимка.

```bash
# 1. Лимит журнала: без него он растёт ~20 МБ/день (за 29 дней было 587 МБ)
sudo sed -i 's/^#\?SystemMaxUse=.*/SystemMaxUse=500M/' /etc/systemd/journald.conf
sudo systemctl restart systemd-journald
journalctl --disk-usage          # было 587M, станет ~476M (лимит не сжимает задним числом)

# 2. Зомби-браузер: висел 20 дней вне systemd, слушал 127.0.0.1:9222
sudo pkill -f chrome-headless-shell
sudo ss -lntp | grep 9222 || echo '9222 свободен'

# 3. Тестовый мусор и кэш
sudo rm -rf /root/chs /opt/piitest
sudo npm cache clean --force

df -h /                          # замер 23.11.2026: 6.6G → 5.2G (18% → 14%)
```

Проверено 23.11.2026 на проде: чистка освободила **1.4 ГБ** (397 МБ `chs` + 651 МБ `piitest` + 392 МБ кэша npm). Но **размер архива от неё не меняется** — в архиве никогда не было ни одного из этих каталогов. Не жди, что `bytes` уменьшится: он даже вырос (1245307 → 1253467), потому что вырос снимок БД.

### 1.1 Снять бэкап

```bash
ssh -i ~/.openclaw/ssh/tarnet_vps root@195.63.131.172
cd /opt/tarnet/backend-api
sudo ./scripts/backup.sh
```

Ожидаемый вывод — одна строка JSON (это реальный прогон 23.11.2026 19:00 MSK):

```json
{"ok":true,"archive":"/var/backups/tarnet/tarnet-2026-11-23T19-00-27.tar.gz",
 "bytes":1253467,"sha256":"9c969ffa3391a234d727425a9210b7f3a6f18733c4d2fd7145c35185c7bfcdf6",
 "db_bytes":2338816,"files":27,"commit":"31cb52b82b3b...","ts":"2026-11-23T19:00:29+03:00"}
```

Размер (`bytes`) у каждого прогона свой: он зависит от размера БД и от того, насколько хорошо сжался снимок. Сверять надо не «сколько байт», а `files: 27` и `sha256`, который печатается здесь и попадает в `MANIFEST.txt`.

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
scp root@195.63.131.172:/var/backups/tarnet/tarnet-2026-11-23T19-00-27.tar.gz ./

# с локальной машины на новый хост
scp tarnet-2026-11-23T19-00-27.tar.gz root@NEW_HOST:/root/
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
# на новом — ОБЯЗАТЕЛЬНО -b main
# без него: "warning: remote HEAD refers to nonexistent ref, unable to checkout",
# дерево остаётся пустым, и следующий `git rev-parse --short HEAD` печатает
# fatal: Needed a single revision
# (проверено 23.11.2026 на migration/tarnet-repo.bundle)
git clone -b main /tmp/tarnet.bundle /opt/tarnet/backend-api
```

Флаг `--repo=<путь к бандлу>` у `bootstrap.sh` для этого **не годится**: он делает
`git clone` без `-b` и умирает на проверке `[ -f "$DIR/server.js" ]`. Рабочий путь без
GitHub — клонировать бандл самому (как выше), затем запускать `bootstrap.sh` из этого
каталога: он увидит готовый `$DIR/.git` и сделает `fetch --all` + `reset --hard origin/main`.

---

## 4. Развёртывание (5–8 минут)

```bash
ssh root@NEW_HOST
cd /opt/tarnet/backend-api
sudo ./scripts/bootstrap.sh --domain=tarnet.example.com \
     --restore=/root/tarnet-2026-11-23T19-00-27.tar.gz
```

Скрипт идёт по шагам и печатает `[01]…[12]` (двенадцать, не одиннадцать:
`проверки окружения`, `swap`, `пакеты`, `каталоги`, `код`, `зависимости`,
`восстановление данных`, `systemd`, `caddy`, `firewall`, `запуск`, `проверка`).

**Шесть боевых сервисов должны подняться**, не четыре:

| Сервис | Порт | Зачем |
|---|---|---|
| `tarnet.service` | 3001 (локально) | HTTP API за Caddy |
| `p2p-bridge.service` | 4001 | libp2p-мост, discovery для воркеров |
| `tarnet-seed2.service` | 4002 | второй сид; без него один узел = единая точка отказа |
| `litestream-tarnet.service` | — | непрерывная репликация БД в S3 |
| `caddy.service` | 80, 443 | TLS и reverse-proxy |
| `fail2ban.service` | — | бан по SSH после 3 попыток |

Плюс `tarnet-prune-distill.timer` — `oneshot` по расписанию, не сервис.

Если в `systemctl is-active` меньше шести строк `active` — переезд не закончен,
даже если `/health` вернул 200. Самое коварное: без `p2p-bridge` и `tarnet-seed2`
сервер здоров, API отвечает, а воркеры не находят узел (`found: 0`), и это
выглядит как поломка discovery, а не как незапущенный юнит.

Что должно быть в конце:

```
[12] проверка
     ✅ локально /health 200, buildVersion <совпадает с package.json>
     ✅ снаружи https://tarnet.example.com/health → 200

{"ok":true,"domain":"tarnet.example.com","commit":"<SHA этого коммита>","buildVersion":"<из /health>",
 "health_local":"200","health_external":"200"}
```

На что смотреть по шагам:

| Шаг | Признак проблемы |
|---|---|
| `[02] swap` | `RAM 1024 МБ — создан swap 2 ГБ` — норма для 1–2 ГБ; **с 1 ГБ swap установка падает** на распаковке `onnxruntime` (`code 137`) |
| `[03] пакеты` | `node v18…` → скрипт сам поставит NodeSource 22 (в Debian 12 apt даёт 18, а нужен `node:sqlite`). Здесь же ставится лимит журнала (`SystemMaxUse=500M`), бинарь `litestream` и jail `fail2ban`. Если видишь `litestream не скачался` — репликация в S3 будет выключена, но хост поднимется |
| `[05] код` | `git clone` упал → переноси bundle (см. шаг 3) |
| `[06] зависимости` | `npm ci` в `p2p-node` — **отдельный** lock; корневой его не покрывает. `onnxruntime-node не грузится` → нет `libstdc++` или не тот arch |
| `[07] восстановление` | `нет secrets/master.key` → БД нерасшифровываема, архив неполный, пересобери бэкап |
| `[08] systemd` | `systemd не видит TARNET_PUBLIC_URL` → drop-in не применился, `daemon-reload` не прошёл. `нет .../deploy/systemd/litestream-tarnet.service` → файл юнита не доехал, проверь `git status` |
| `[09] caddy` | `caddy validate` не прошёл или сертификат не выпущен — смотри A-запись и `journalctl -u caddy` |
| `[12] проверка` | `снаружи → 000` → A-запись ещё не указывает на новый хост |

`ok:true` в финальном JSON **не значит**, что снаружи всё хорошо: внешняя проверка
только предупреждает (`warn`), а не падает. Смотри отдельное поле `health_external` —
при проблемах с DNS там будет `000`, и это единственное место, где это видно.

---

## 5. DNS (5 минут + ожидание TTL)

```bash
dig +short tarnet.example.com
# должен вернуть IP нового хоста
```

Порядок важен: **сначала** A-запись, **потом** ждать. Caddy выпустит сертификат сам, как только домен начнёт резолвиться сюда. Если поменять DNS после `bootstrap.sh` — внешняя проверка упадёт на шаге `[12]`, это ожидаемо, повтори:

```bash
curl -I https://tarnet.example.com/health
systemctl reload caddy
```

**Старый домен не переиспользовать.** `v1107336.hosted-by-vdsina.com` — поддомен зоны VDSina; A-запись в чужой зоне не редактируется.

---

## 6. Проверка после переезда

```bash
# 1. сервисы — должно быть шесть active
systemctl is-active tarnet p2p-bridge tarnet-seed2 litestream-tarnet caddy fail2ban

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

`receipts` после переезда должен совпасть с тем, что было на старом хосте (**808** на 23.11.2026 19:00 MSK, при `totalRewardTar` 176.481981), плюс всё, что пришло за время переезда.

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
- **Что `bootstrap.sh` проверен на чистом хосте.** На 23.11.2026 полного прогона на чистой машине всё ещё не было: на gateway нет docker/podman, на проде нет `debootstrap`, покупка VPS требует владельца. Проверено замером: синтаксис (`bash -n`), подстановка домена, `caddy validate`, `npm ci` на копии без `node_modules` (три прогона: без swap → `code 137` OOM, с 1 ГБ swap → `code 137`, с 2 ГБ → `RC=0`, с `ONNXRUNTIME_NODE_INSTALL=skip` → `RC=0`), живой прогон `backup.sh`.
- **Что восстановление архива — теория.** 23.11.2026 архив `tarnet-2026-11-23T19-00-27.tar.gz` распакован и проверен по-настоящему: 27 файлов, 26/26 sha256 из `MANIFEST.txt` сошлись (`MANIFEST.txt` сам себя не хэширует), `PRAGMA integrity_check` → `ok`, 46 таблиц, 157 узлов, 106 кошельков (81 зашифрован), `master.key` расшифровал 5 из 5 выбранных кошельков в валидный PEM, сервер поднят на архивной БД → `/health` 200, `buildVersion 2.29.25`, а `/summary` совпал с продом по всем содержательным полям (808 чеков, 176.481981 TAR, `delta 0` в обоих аудитах). Различались только четыре P2P-поля (`active_p2p_workers`, `p2p_worker_records`, `p2p_model_families`, `p2p_transport_known`) — ровно потому, что рядом не было моста.
- **Зато не проверено:** старт systemd-юнитов на чистой ОС, выпуск TLS через ACME, работа `--restore` на живой системе с уже запущенным сервисом. Полная таблица — `docs/STAGE-PORTABILITY.md`.
