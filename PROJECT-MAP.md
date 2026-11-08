# PROJECT-MAP — карта кода TarNet / Synapse

**Назначение.** Где что лежит и что чем вызывается. Отвечает на вопрос «в какой файл идти»,
а не «что работает» (это `MANIFEST.v3.4-UNIFIED.md`) и не «как мы сюда пришли»
(это `PROJECT-HISTORY.md`).

**Сверено с кодом:** 2026-11-08 00:45, сборка `2.23.3-prompt-integrity`. Карта описывает **файлы**,
поэтому устаревает медленнее манифеста — но при добавлении/удалении модуля правится в тот же день.

---

## 1. Точка входа и запуск

| Что | Где |
| :--- | :--- |
| Точка входа | `server.js` (`package.json` → `main`, `scripts.start`) |
| Команда | `npm start` → `node server.js`; порт `3001` |
| Приёмка | `node test-dpouw.js --test` — поднимает изолированный сервер на `mktemp`-БД |
| Прод | systemd `tarnet.service`, каталог `/opt/tarnet/backend-api`, БД `/var/lib/tarnet` |
| Мост к libp2p | systemd `p2p-bridge.service` (юнит в `deploy/systemd/p2p-bridge.service`), ключ узла `/var/lib/tarnet/p2p/peer-id.bin`, порт `4001` |
| Проверка снаружи | `https://v1107336.hosted-by-vdsina.com/health` и `/p2p/bootstrap` (за **Caddy** на `443`; порт `3001` наружу **закрыт** — не судить о доступности по нему) |
| Соседи P2P | `GET /p2p/status` → блок `bridge` (`connections`, `connected_peers`, `tasks.framesIn`) — **по нему считается готовность P1.1**; плюс `nodes`/`client` демо-меша и `registry` (реестр публичных адресов, критерием **не является**) |
| Счётчики трафика | `p2p-node/task-protocol.js` → `createTaskClient().stats()` → `{framesIn, framesOut, rejected, channels}`; наружу — через `GET /p2p/status → bridge.tasks` |
| Деплой | `scripts/deploy.sh` — **коммит + пуш + раскатка без `--dry-run`** (см. §8) |

---

## 2. Ядро экономики (читать в этом порядке)

| Модуль | Строк | Роль |
| :--- | --: | :--- |
| `config.js` | 257 | **Единственный источник констант.** `PRICE_USD_PER_1M_TOKENS`, `USD_PER_TAR`, `TIER_WEIGHTS`, `PROTOCOL_FEE_RATE`, `TIER6.*`, `FAUCET.*` |
| `ledger.js` | 336 | `CumulativeLedger` — накопительные чеки, `debit()`/`credit()`, двойная запись, ключи at rest AES-256-GCM |
| `economics.js` | 255 | CWU, `√stake × reputation`, эмиссия с непрерывным затуханием, ставка `TAR_UTILITY` (единственное место — строки 115-116). С `2.23.3`: `verifyQuality` принимает `promptHashVerified` и различает три состояния; `spotCheckDecision` — 5% выборочная проверка (seed из содержимого работы, не из идентификаторов клиента) |
| `dag-chain.js` | 185 | SHA-256-сцепка чеков: `prevReceiptHash` / `receiptHash`, `payloadVersion: 2` |

**Цепочка расчёта чека:** `POST /work` → `economics.js` (CWU, fee, block reward) →
`ledger.js` (запись, `decorate()`) → `dag-chain.js` (хеш-сцепка) → подпись Ed25519.

---

## 3. Сеть и транспорт

| Модуль | Строк | Роль | Статус |
| :--- | --: | :--- | :--- |
| `ws-inbound.js` | 601 | Входящий WS для воркеров: Ed25519-хендшейк, nonce, TOFU, кадры `TASK`/`CANCEL` | ✅ работает |
| `worker-demo.js` | 1630 | Воркер на ПК владельца: опрос/WS, `fetchAbortable`, `askOllama`/`askCloud`, `MAX_EARLY_CANCELS = 200`, `startLinkListener` — ввод кода привязки в окне воркера, `--self-check`. С 2.22.1: `runTask(task, via)` печатает `[WS]`/`[HTTP]` в строке приёма — видно транспорт получения, а не только отправки ответа. С 2.22.2: `startP2pExecutor()` — локальный вход `127.0.0.1` с токеном для p2p-процесса (libp2p в сборку не влезает). С 2.22.5: `loadOrCreateSeed` пишет seed из env в файл при его отсутствии; обработчики `/p2p/execute` и `/p2p/cancel`. С 2.22.6: флаг `--p2p` / `TARNET_P2P=1` (`P2P_WANTED`) — `startP2pChild()` поднимает `p2p-node/p2p-worker.js` через `spawn` (`stdio:'inherit'`) ПОСЛЕ `bindKey`; `SIGINT` гасит ребёнка; `findP2pWorker()` без `p2p-node` → `null` и честный текст. С 2.22.9: `linkState.pendingCode` + `retryPendingLink()` — отказ `DEVICE_KEY_UNKNOWN` НЕ теряет код привязки: он откладывается и гасится повторно после `AUTH_OK` (`connectWs`), ровно один раз; успех или иной код очищают ожидание | ✅ работает |
| `p2p-node/p2p-worker.js` | 462 | Воркер-клиент: bootstrap → `dial` → удержание соединения, поток `TASK_PROTOCOL`. С 2.22.2: `handleTask` принимает кадр `task` и проксирует его локальному исполнителю через `~/.tarnet/p2p-exec.json`, печатает `[p2p-worker] задача … → локальный исполнитель`. С 2.22.5: `waitForWorkerIdentity()` вместо одного чтения (`P2P_KEY_WAIT_MS`), `proxyCancelToLocalExecutor` → `POST /p2p/cancel` | ✅ сквозной проход и CANCEL доказаны `scripts/test-p2p-e2e.js` (`via:p2p`) |
| `p2p-channel-pick.js` | 83 | **Правило «кому доставить задачу» — одно на WS и P2P.** `pickChannel(channels,{preferAddress,excludeSet})` → `{channel,reason}`; `pickSwarmPair(wsOrdered,p2pAddresses)` → 0–2 уникальных адреса. С 2.22.12: вынесено из `server.js` после **двух** одинаковых дефектов подряд (`taskClient.send` → `dispatchTaskOverP2p`), оба — «берём первый живой вместо адресата». Чистые функции, проверяются обычным `node` без моста и libp2p | ✅ 61.1–61.9 |
| `p2p-bridge-client.js` | 225 | Клиент моста для server.js без зависимостей. `send`, `announceOnStartup`, `startAnnounceLoop`, `nodeIdentity`. С 2.22.2: `task(payload)` — задача воркеру через мост. С 2.22.5: `cancel({taskId,address,reason})` → `{ok,cancelled[],channels}` | ✅ работает |
| `worker-box.js` | 132 | `openFromWorker` / `sealToWorker`: `sessionKey` шифруется на ключ воркера. **Локальная зависимость воркера** — вшивается сборкой, отдельно не качается | ✅ работает |
| `build-worker.js` | 188 | Сборщик одного файла: `maskComments`, `localRequireNames`, `stripShebang`; `require('./x')` → `__localRequire('x')` | ✅ работает |
| `dist/tarnet-worker.js` | — | Готовая сборка, её отдаёт `/download/worker.js`. В `.gitignore`; **пересобирается автоматически, если старше `worker-demo.js` / `worker-box.js` / `build-worker.js`**. С 2.21.5: проверка «файл есть» не считалась свежестью — старая сборка жила вечно | 🏗 артефакт |
| `p2p-transport.js` | 611 | WS между узлами, `wildcardBind`, `P2P_PUBLIC_URL → P2P_ADVERTISE_IP` | ⚠️ настроен только на `127.0.0.1` |
| `onion.js` | 289 | Onion Routing: RSA-2048-OAEP-SHA256 оборачивает 32-байтный AES, нагрузка AES-256-GCM | ✅ работает (`hops: 3`) |
| `p2p-demo.js` | 129 | Демонстрация P2P | демо |
| `p2p-node/bridge.js` | 493 | Отдельный процесс. Unix-socket `/tmp/tarnet-p2p-bridge.sock` (0600), JSON Lines, `announce`/`status`/`peers`/`ping`/`task`/`cancel`. С 2.21.4 принимает поток `/tarnet/task/1.0.0` от воркеров. С 2.22.5: `cancel(msg)` → `taskClient.cancel()`. Action **`channels`** добавляется с 2.22.x (список авторизованных живых каналов) — если его нет в ответе, мост на старом коде | ✅ работает на проде (`p2p-bridge.service`) |
| `p2p-node/task-protocol.js` | 328 | Кадры задачи поверх libp2p-потока: один JSON на строку, `createTaskClient` (мост) / `serveTaskStream` (воркер). Без `stream.source`/`sink` — в libp2p 3.5.1 поток итерируется сам, запись через `stream.send` + ожидание `drain` своим `waitEvent` (без пакета `p-event`: тот приходил транзитивно и исчез бы при обновлении libp2p). С 2.22.5: `CONTROL_FRAME='cancel'`, `isControlFrame`, `cancel()`; управление читается **вне** цепочки задач, иначе отмена ждала бы ответа модели | ✅ 52.7–52.12 |
| `p2p-node/peer-auth.js` | 168 | **Проверка права на поток задач:** `verifyHello` (Ed25519 тем же ключом, что в WS), `loadAllowlist` — формат `{updatedAt,peers}`, нет файла/битый JSON = запрет; префикс `TARNET_P2P_HELLO`, окно 120 с | ✅ 11 проверок в 51.1–51.11 |
| `p2p-node/peer-hello.js` | 153 | Сторона воркера: `loadWorkerIdentity` (env → `~/.tarnet/*.json`), `buildHello` — подпись PKCS8-обёрткой seed, тот же префикс, что в `worker-demo.js`. С 2.22.5: `workerKeyFile({home,env})` (`P2P_WORKER_KEY_FILE`), `waitForWorkerIdentity({timeoutMs,pollMs})` — ключ может появиться позже. **`verifyHello` здесь НЕТ** — он в `peer-auth.js` | ✅ без сети, обычным `node` |
| `p2p-node/peer-id-store.js` | 81 | Генерация/чтение ключа узла: `/var/lib/tarnet/p2p/peer-id.bin`, права `0600` | ✅ `peerId` стабилен между рестартами |
| `p2p-node/public-addr.js` | 144 | Разбор публичного адреса **без зависимостей** (вынесено, чтобы проверять логику обычным `node`, не ставя libp2p 115 МБ): `P2P_PUBLIC_URL` → `/dns4|dns6|ip4|ip6/…/tcp/<port>/p2p/<peerId>`. Экспорт **именованный** (пакет `"type": "module"`) — `module.exports` падает `ReferenceError`. **`Listen` и `WAN` — разные вопросы:** `Listen` = где открыт порт, `WAN` = как найдут снаружи; при `P2P_PUBLIC_URL` + `P2P_HOST=127.0.0.1` печатаются оба и предупреждение «снаружи недостижим» | ✅ проверяется без сети |
| `p2p-node/index.js` | 96 | PoC libp2p: tcp+noise+yamux+identify, kad-dht `clientMode` | ✅ поднимается, DHT не опрашивает |
| `scripts/archive-transcripts.js` | 286 | Архивация транскриптов агента: gzip → проверка обратным чтением → `DELETE` партиями → `incremental_vacuum`. **Потоковая** (2026-11-05): `Readable.from` + `createGzip` + `readline` вместо `.all()`/`gunzipSync` — первая версия убивалась OOM. `--exclude-session=<id>` исключает живую сессию. `PRAGMA busy_timeout=8000` + повтор транзакции на `database is locked`. По умолчанию сухой прогон. **С 06.11 удаляет только `seq <> 0`**: заголовок сессии — самая старая строка и раньше удалялся вместе с историей, после чего рантайм отказывался читать транскрипт (`Persisted legacy session transcripts require doctor/import migration`). Финальная проверка `HAVING SUM(seq=0)=0` валит прогон с кодом `1` | ✅ 05.11: 54106 строк → 21 МБ архива, база 597→542 МБ, но **свободное место не выросло** (677→676 МБ) — см. `docs/PROJECT-MEMORY.md` §12.1 |

**Важно:** воркер держит **исходящее** соединение и не открывает портов, поэтому
`registry.total: 0` — это корректное состояние, а не поломка.

---

## 4. Инференс и роутинг

| Модуль | Строк | Роль |
| :--- | --: | :--- |
| `llm-adapter.js` | 574 | Zero-Disk адаптер: облачные провайдеры, `STRUCTURED_PATTERNS` (PII-гейт, строки 40-56), `endpointFor()` (замена адреса только на loopback) |
| `model-router.js` | 166 | `classifyDomain` + `selectModel`. **Только это** — `Planner`/`MapReduce` здесь нет |
| `swarm-synthesis.js` | 251 | Выбор лучшего из двух ответов: сначала проверка синтаксиса кода, потом Dice ≥ 0.8, потом длина |
| `pii-classifier.js` | 291 | Regex-ветка + ONNX NER за `TARNET_PII_ONNX=1` (по умолчанию `ready: false`) |

---

## 5. Идентичность и клиент

| Модуль | Строк | Роль |
| :--- | --: | :--- |
| `identity.js` | 232 | TarNet ID: детерминированный вывод ключей из мастер-энтропии |
| `jcs.js` | 74 | RFC 8785. **Применяется только в Device Linking** (`server.js:4108`), не в подписи `/work` |
| `app/app.js` | 3082 | PWA-клиент: чат, кошелёк, агенты, `CryptoKey` с `extractable: false` в IndexedDB |
| `app/agents.js` | 811 | Агенты в браузере, вендорный `noble-ed25519` (`app/vendor/ed25519.js`) |
| `app/sw.js` | 212 | Service worker, кэш `tarnet-app-v35` |
| `app/index.html` | 740 | Разметка чата, инструкция привязки: код вводится в окне воркера |
| `install/install.bat.tpl` | 386 | Установщик Windows: `start.cmd` запускает `node` в видимом окне (не `start /min`), чистый ASCII. **С 2.22.7** качает `/download/p2p-node.zip`, распаковывает в `%LOCALAPPDATA%\TarNet\p2p-node`, ставит зависимости `npm ci --omit=dev`, проверяет `import('libp2p')` и только тогда добавляет `--p2p` в лаунчер (`P2P_OK=1`). Любой отказ p2p — `WARNING` и работа на WS, а не падение установки. **С 2.22.10** кладёт ярлык `TarNet Worker.lnk` в Startup (только Windows) через `GetFolderPath('Startup')`, цель — `start.cmd`, сбой ведёт в `:autostart_failed` |
| `install/install.command.tpl` | 289 | Установщик macOS/Linux: то же для p2p (распаковка `unzip`, фолбэк `ditto` на macOS без CLT); `start.sh` получает `--p2p` только при `P2P_OK=1` |
| `p2p-bundle.js` | 254 | **Новое в 2.22.7.** Сборка ZIP с `p2p-node` для установщика своим писателем на `node:zlib`: `buildZip`, `crc32` (свой — `zlib.crc32` только с Node 22.2), `buildP2pArchive`, `getP2pArchive` (кеш по mtime). Явный список `BUNDLED_FILES`: забытый модуль — ошибка сборки, а не `ERR_MODULE_NOT_FOUND` у человека. `data/` (ключ узла) и `node_modules` не входят никогда |
| `app/styles.css` | 2067 | Стили |
| `ui/console.html`, `ui/index.html` | — | Отдельная консоль оператора |

---

## 6. Агенты, знания, синхронизация

| Модуль | Строк | Роль |
| :--- | --: | :--- |
| `agent-runtime.js` | 285 | Бюджеты агента в токенах, вызовы инструментов |
| `knowledge-loop.js` | 626 | Сжатие Micro-LoRA (Trim 80% → INT8 → CSR), шлюз валидации. С `2.23.3`: `selectPairs` расшифровывает `promptText`/`response` через `decryptText` — без этого сборка датасета после шифрования вернула бы `DECRYPT_UNAVAILABLE`. Обратная сторона шифрования: в JSONL должен попасть **открытый** текст, а не `enc:v1` |
| `benchmark-gate.js` | 206 | Benchmark Gate / Proof-of-Learning (Фаза 3) |
| `chat-sync.js` | 310 | Оффлайн-история: LWW-Element-Set + векторные часы |
| `seed.js` | 112 | Начальные данные (3 фикстуры адаптеров) |

---

## 7. Тесты и стенды

| Файл | Строк | Проверок | Что покрывает |
| :--- | --: | --: | :--- |
| `test-dpouw.js` | 10534 | **1191** | Основная приёмка: экономика, леджер, чеки, API, Private Swarm |
| `test-mesh.js` | 459 | **25** | Onion, mesh, многоузловой путь |
| `proof-treasury-gate.js` | 188 | **13** | Казна и гейт |
| `proof-agent-key.js` | 352 | 57 | Ключ агента: `exportKey` → `InvalidAccessError` |
| `proof-onion-inference.js` | 125 | — | Onion-инференс |
| `proof-onion-restart.js` | 161 | — | Переживание рестарта |
| `test-mesh-worker.js` | 50 | — | Воркер для mesh-теста |

**Итого приёмки: 1229** (1191 + 25 + 13), прогон 07.11 18:22, `RC=0` по трём файлам.
Гоняет `scripts/verify.sh`.

Тесты роя и отмены живут в `test-dpouw.js`: `47.4` (оплата победителю, не обоим),
`47.5` (проигравшая задача → `cancelled`), `47.5b` (воркер получил кадр `CANCEL` со
своим `taskId`), `47.5c` (победитель `CANCEL` не получил), `47.5d`
(`cancelledWorkers` содержит ровно адрес проигравшего), `47.6` (без флага `swarm` —
одна задача и `swarm: null`), `61.1–61.9` (`p2p-channel-pick.js`).
Прогон 07.11 18:07 подтвердил то же самое **в бою**, а не в тесте — см.
`MANIFEST` §Б.30: живой `CANCEL` оборвал 12-секундный запрос на 389 мс.

---

## 8. Скрипты (`scripts/`)

| Скрипт | Что делает | Осторожно |
| :--- | :--- | :--- |
| `deploy.sh` | **Коммит + пуш + раскатка.** `--dry-run` НЕТ | **Токен берётся из `$HOME/.openclaw/credentials/github/personal/*/hosts.yml`** (первый читаемый; override — `TARNET_GH_CREDS`), а **не** из `$GH_TOKEN` — env-токен мёртв и на деплой не влияет. Аргумент с `-` отклоняется (`EXIT=2`); повторный `/health` перед откатом. С 07.11 шаг **5b** перезапускает `p2p-bridge` (имя в `TARNET_BRIDGE_SERVICE`, по умолчанию `p2p-bridge`) — без этого шага мост остаётся на старом коде после подмены файла (случилось 07.11: двое суток без action `channels`) |
| `authorize-peer.js` | **Допуск воркера к P2P-задачам** (`2.22.11`): проверяет привязку ключа в `ws_worker_auth` и публикует `authorized-peers.json` **из базы** | Коды: 0 — опубликовано, 2 — плохой аргумент, 3 — нет привязки (адрес без ключа впустить нельзя), 4 — к адресу привязан другой ключ, 5 — сбой БД/записи. Дописывать файл руками **бесполезно**: backend-api перезаписывает его целиком при каждом handshake и при старте |
| `check-autostart.js` | **Проверка P1.2**: ждёт `active_workers ≥ 1` **и** `bridge.connections ≥ 1` в окне (600 с). `--url`, `--window`, `--interval`, `--json` | Проверяет **следствие**, а не причину: сервер не знает о перезагрузке ПК. Коды: 0 — узел в сети, 1 — таймаут (называет причину), 2 — плохой аргумент |
| `verify.sh` | Гоняет три набора + сверяет `/config` с `config.js` | Основной вход приёмки |
| `test-p2p-e2e.js` | **Сквозной P2P** (`2.22.3`): поднимает мост + `p2p-worker.js` + исполнитель во временном `HOME`, ждёт `via:'p2p'` | Свой сокет/порт/bootstrap-заглушка — боевой мост не трогает; проверен loopback, не боевая топология |
| `prune-archives.js` | **Очистка `.zst`** (`2.22.4`): удаляет архивы старше 7 дн. только при совпадении SHA-256 с `session_transcript_archives` | Dry-run по умолчанию; возраст из метки `.deleted.<ISO>` в имени, не из mtime. Прогон: 32 файла, 75.3 КБ |
| `backup-tarnet-s3.sh` | Бэкап в S3 | — |
| `make-icons.js` | Иконки PWA | — |
| `push-tag.js` | Тег | — |
| `sqlite-tool.js` | Работа с БД | Не на живой state-каталог OpenClaw |
| `tarnet-guard.sh` | Сторож сервиса | — |
| `tarnet-supervisor.sh` | Супервизор | — |
| `tarnet-tunnel*.sh` | Cloudflare-туннель | Эфемерный URL |
| `extract-session-summary.js` | **Выжимка сессии перед удалением** (только чтение, `2.20.0-session-archive`): запросы, решения, коммиты, версии, тесты, провалы; определяет форк | `--top N`, `--session <id>`, `--status failed`, `--json`, `--markdown`. Ничего не удаляет |

---

## 9. База данных

SQLite, `/var/lib/tarnet` на проде. **45 таблиц** (проверено 07.11.2026 18:22 прямым чтением БД); группы по смыслу:

| Группа | Таблицы |
| :--- | :--- |
| Учёт работы | `work_receipts`, `pending_work`, `ledger_txs`, `balances`, `balance_migrations`, `epoch_state` |
| Узлы и воркеры | `nodes`, `node_attestations`, `worker_presence`, `worker_tasks`, `ws_worker_auth` |
| Экономика | `treasury_state`, `faucet_claims`, `onchain_settlements`, `tier6_*` (см. ниже) |
| Адаптеры | `adapters`, `adapter_versions`, `lora_submissions` |
| Tier 6 | `tier6_calls`, `tier6_receipts`, `tier6_reserves` |
| Идентичность | `tar_id`, `wallets`, `user_keys`, `user_consent`, `key_usage`, `key_limits` |
| Привязка устройств | `device_links`, `device_link_codes`, `device_link_challenges`, `device_link_nonces` |
| Агенты | `agent_registry`, `agent_wallets`, `agent_spend`, `agent_reservations`, `approvals` |
| Прочее | `inference`, `model_registry`, `tool_registry`, `benchmark_runs`, `distillation_buffer` |

**`distillation_buffer` — зашифрована с 07.11.2026 (`2.23.3`).** Прежняя
запись «промпты туда не пишутся» **неверна**: таблицу пишет
`POST /distill/record` после opt-in-гейта и PII-проверки. До `2.23.3`
`promptText` лежал **открытым текстом**; теперь `encryptSecret()` применяется
к `promptText` **и** `response` до `INSERT` (`server.js:5498-5518`), а
`migratePlaintextDistillation()` (`server.js:1629`, вызов на старте `1656`)
перешифровывает строки, записанные раньше. `promptHash` — SHA-256 **открытого**
текста, считается ДО шифрования (`server.js:5497`): после него хеш не пересчитать.
`usedInTraining` у всех строк `0`: до обучения ни один не дошёл. Подробности —
`MANIFEST` §3.1, доказательство — тест 62.5 (поиск байт промпта в файлах БД и WAL).

**8 из 45 таблиц пусты на 07.11.2026** (0 строк): `balance_migrations`,
`benchmark_runs`, `chat_sync_log`, `device_link_challenges`, `device_link_nonces`,
`key_limits`, `key_usage`, `user_keys`. Пустота — не дефект: `key_*` и `user_keys`
созданы как схема-первой для Фазы 2.5, `benchmark_runs` ждёт комитета (0 членов),
`device_link_*` — короткоживущие челленджи. Но при чтении «что работает» опираться
на наличие таблицы нельзя — только на число строк.

**Где читать правду о содержимом:** `node --input-type=commonjs -e` с `node:sqlite`
на VPS (`better-sqlite3` НЕ установлен — сервер на встроенном модуле).
`sede`/`sqlite3` CLI на VPS отсутствует.

---

## 10. API — 70 маршрутов (38 GET, 30 POST, 2 DELETE)

Разбивка по назначению (полный контракт — `docs/NETWORK-CONTRACT-v1.md`):

- **Работа:** `POST /work`, `POST /worker/submit`, `GET /worker/poll`, `GET /receipt/:worker`
- **Инференс:** `POST /inference`, `POST /inference/onion`, `GET /models`
- **Узлы:** `GET /nodes`, `POST /node`, `GET /p2p/status`
- **Экономика:** `GET /health`, `GET /summary`, `GET /config`, `GET /epoch`, `GET /ledger`, `GET /balances`
- **Кошелёк:** `POST /faucet/claim`
- **Tier 6:** `POST /tier6/*`
- **Устройства:** `/devices/link*`, `/devices/links/:owner`
- **Агенты:** `/agents/*`

**Правило Code-First:** маршрут существует = он есть в `server.js`. Отсутствие в
`docs/NETWORK-CONTRACT-v1.md` — дефект документа, а не признак отсутствия кода
(так было с `CANCEL` и `swarm`: в коде есть, в контракте не было).

---

## 11. Документы — кто за что отвечает

| Документ | Отвечает на вопрос | Обновляется |
| :--- | :--- | :--- |
| `PROJECT-MAP.md` (этот) | «в какой файл идти» | при изменении структуры |
| `MANIFEST.v3.4-UNIFIED.md` | «что работает сейчас» | при каждой вехе, снимок в Приложении Б |
| `PROJECT-HISTORY.md` | «как мы сюда пришли» | при каждой вехе |
| `ROADMAP.md` | «что дальше и в каком порядке» | при смене приоритетов |
| `docs/BACKLOG.md` | «что отложено и почему» | когда задачу откладывают |
| `docs/REALITY-CHECK-v3.md` | «что обещали и что имеем» — Gap Analysis Манифест vs Код по 4 категориям | при смене вехи; устаревает → заменяется v4, а не правится |
| `docs/NETWORK-CONTRACT-v1.md` | контракт воркера и API | при изменении API |
| `docs/PROJECT-MEMORY.md` | сводка по всем сессиям | по запросу |
| `docs/PROJECT-REPORT-2026-11-07.md` | **полный сводный отчёт**: идея, архитектура, карта кода, экономика, живой срез 18:25, что работает и чего нет | снимок; устаревает → заменяется датированным отчётом, а не правится |

**Правило одного источника:** факт о том, что работает, живёт в `MANIFEST`;
дата и причина — в `PROJECT-HISTORY`; расположение — здесь. Дублирование факта
в двух местах означает, что одно из них протухнет.

### 11.1. Раскладка папок (с 05.11.2026)

В корне `backend-api/` — **только четыре канонических документа и `README.md`**.
Всё остальное — в `docs/`. Перенос сделан 05.11.2026 (`git mv`, история сохранена).

| Где | Что |
| :--- | :--- |
| корень `backend-api/` | `MANIFEST.v3.4-UNIFIED.md`, `PROJECT-HISTORY.md`, `PROJECT-MAP.md`, `ROADMAP.md`, `README.md` |
| `docs/` — отчёты и планы | `docs/BACKLOG.md`, `docs/PLAN-WAVE2.md`, `docs/PLAN-AGENT-RUNTIME.md`, `docs/LEGAL-DISTILLATION-PIPELINE.md`, `docs/V2.17.*-REPORT.md`, `docs/V2.17.13-REPORT.md`, `docs/REALITY-CHECK-v2.17.7.md`, `docs/REALITY-CHECK-v3.md` |
| `docs/` — инвестору и демо | `docs/ONE-PAGER.md`, `docs/PITCH-DECK.md`, `docs/DEMO-SCRIPT.md`, `docs/DEMO-RUNBOOK.md`, `docs/EMAIL-TEMPLATE.md`, `docs/AUDIT-REALITY.md` |
| `docs/` — контракты и решения | `docs/NETWORK-CONTRACT-v1.md`, `docs/BYOK-PRICING.md`, `docs/PII-DECISION.md`, `docs/VISION-8-COMPONENTS.md`, `docs/PROJECT-MEMORY.md` |

**Корень workspace** (на уровень выше, вне git) держит **симлинки** на публичные документы.
Копий намеренно нет: копии разъезжались молча (29.10 `EMAIL-TEMPLATE` в корне был 8080 б
против 9207 в `docs/`). Проверяет `scripts/verify.sh` → шаг 3.8.

**Ссылки внутри документов указывают путь от `backend-api/`**, то есть на перемещённое —
через `docs/`: `docs/BACKLOG.md`, `docs/DEMO-RUNBOOK.md`. Голое имя теперь означает файл в корне.

---

## 12. Куда НЕ идти

| Путь | Почему |
| :--- | :--- |
| `archive/python-app/crypto.py` | `sign_message()` на SHA-256 — хеш-заглушка, **не Ed25519**. Не использовать |
| `archive/lottery-tests/` | Отозванная механика лотерей |
| `node_modules/` | Не читать, не грепать при аудите |
| `../archive/MANIFEST.md` (v3.1), `../archive/MANIFEST.v3.3.md` | Помечены «устарело», перенесены в `archive/` 2026-11-05. Побеждает v3.4-UNIFIED. В корне workspace остался только канон |
| `.model-cache/` | Модели ONNX; на проде отсутствует |
