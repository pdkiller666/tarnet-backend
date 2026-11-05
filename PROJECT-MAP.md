# PROJECT-MAP — карта кода TarNet / Synapse

**Назначение.** Где что лежит и что чем вызывается. Отвечает на вопрос «в какой файл идти»,
а не «что работает» (это `MANIFEST.v3.4-UNIFIED.md`) и не «как мы сюда пришли»
(это `PROJECT-HISTORY.md`).

**Сверено с кодом:** 2026-11-05, сборка `2.19.2-p0-p1-security`. Карта описывает **файлы**,
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
| Деплой | `scripts/deploy.sh` — **коммит + пуш + раскатка без `--dry-run`** (см. §8) |

---

## 2. Ядро экономики (читать в этом порядке)

| Модуль | Строк | Роль |
| :--- | --: | :--- |
| `config.js` | 257 | **Единственный источник констант.** `PRICE_USD_PER_1M_TOKENS`, `USD_PER_TAR`, `TIER_WEIGHTS`, `PROTOCOL_FEE_RATE`, `TIER6.*`, `FAUCET.*` |
| `ledger.js` | 336 | `CumulativeLedger` — накопительные чеки, `debit()`/`credit()`, двойная запись, ключи at rest AES-256-GCM |
| `economics.js` | 232 | CWU, `√stake × reputation`, эмиссия с непрерывным затуханием, ставка `TAR_UTILITY` (единственное место — строки 115-116) |
| `dag-chain.js` | 185 | SHA-256-сцепка чеков: `prevReceiptHash` / `receiptHash`, `payloadVersion: 2` |

**Цепочка расчёта чека:** `POST /work` → `economics.js` (CWU, fee, block reward) →
`ledger.js` (запись, `decorate()`) → `dag-chain.js` (хеш-сцепка) → подпись Ed25519.

---

## 3. Сеть и транспорт

| Модуль | Строк | Роль | Статус |
| :--- | --: | :--- | :--- |
| `ws-inbound.js` | 601 | Входящий WS для воркеров: Ed25519-хендшейк, nonce, TOFU, кадры `TASK`/`CANCEL` | ✅ работает |
| `worker-demo.js` | 1569 | Воркер на ПК владельца: опрос/WS, `fetchAbortable`, `askOllama`/`askCloud`, `MAX_EARLY_CANCELS = 200`, `startLinkListener` — ввод кода привязки в окне воркера, `--self-check`. С 2.22.1: `runTask(task, via)` печатает `[WS]`/`[HTTP]` в строке приёма — видно транспорт получения, а не только отправки ответа. С 2.22.2: `startP2pExecutor()` — локальный вход `127.0.0.1` с токеном для p2p-процесса (libp2p в сборку не влезает) | ✅ работает |
| `p2p-node/p2p-worker.js` | 392 | Воркер-клиент: bootstrap → `dial` → удержание соединения, поток `TASK_PROTOCOL`. С 2.22.2: `handleTask` принимает кадр `task` и проксирует его локальному исполнителю через `~/.tarnet/p2p-exec.json`, печатает `[p2p-worker] задача … → локальный исполнитель` | ✅ сквозной проход доказан `scripts/test-p2p-e2e.js` (`via:p2p`) |
| `p2p-bridge-client.js` | 193 | Клиент моста для server.js без зависимостей. `send`, `announceOnStartup`, `startAnnounceLoop`, `nodeIdentity`. С 2.22.2: `task(payload)` — задача воркеру через мост | ✅ работает |
| `worker-box.js` | 132 | `openFromWorker` / `sealToWorker`: `sessionKey` шифруется на ключ воркера. **Локальная зависимость воркера** — вшивается сборкой, отдельно не качается | ✅ работает |
| `build-worker.js` | 188 | Сборщик одного файла: `maskComments`, `localRequireNames`, `stripShebang`; `require('./x')` → `__localRequire('x')` | ✅ работает |
| `dist/tarnet-worker.js` | — | Готовая сборка, её отдаёт `/download/worker.js`. В `.gitignore`; **пересобирается автоматически, если старше `worker-demo.js` / `worker-box.js` / `build-worker.js`**. С 2.21.5: проверка «файл есть» не считалась свежестью — старая сборка жила вечно | 🏗 артефакт |
| `p2p-transport.js` | 611 | WS между узлами, `wildcardBind`, `P2P_PUBLIC_URL → P2P_ADVERTISE_IP` | ⚠️ настроен только на `127.0.0.1` |
| `onion.js` | 289 | Onion Routing: RSA-2048-OAEP-SHA256 оборачивает 32-байтный AES, нагрузка AES-256-GCM | ✅ работает (`hops: 3`) |
| `p2p-demo.js` | 129 | Демонстрация P2P | демо |
| `p2p-node/bridge.js` | 438 | Отдельный процесс. Unix-socket `/tmp/tarnet-p2p-bridge.sock` (0600), JSON Lines, `announce`/`status`/`peers`/`ping`/`task`. С 2.21.4 принимает поток `/tarnet/task/1.0.0` от воркеров | ✅ работает на проде (`p2p-bridge.service`) |
| `p2p-node/task-protocol.js` | 221 | Кадры задачи поверх libp2p-потока: один JSON на строку, `createTaskClient` (мост) / `serveTaskStream` (воркер). Без `stream.source`/`sink` — в libp2p 3.5.1 поток итерируется сам, запись через `stream.send` + ожидание `drain` своим `waitEvent` (без пакета `p-event`: тот приходил транзитивно и исчез бы при обновлении libp2p) | ✅ ping→pong за 1–2 мс |
| `p2p-node/peer-auth.js` | 168 | **Проверка права на поток задач:** `verifyHello` (Ed25519 тем же ключом, что в WS), `loadAllowlist` — формат `{updatedAt,peers}`, нет файла/битый JSON = запрет; префикс `TARNET_P2P_HELLO`, окно 120 с | ✅ 11 проверок в 51.1–51.11 |
| `p2p-node/peer-hello.js` | 106 | Сторона воркера: `loadWorkerIdentity` (env → `~/.tarnet/*.json`), `buildHello` — подпись PKCS8-обёрткой seed, тот же префикс, что в `worker-demo.js` | ✅ без сети, обычным `node` |
| `p2p-node/peer-id-store.js` | 81 | Генерация/чтение ключа узла: `/var/lib/tarnet/p2p/peer-id.bin`, права `0600` | ✅ `peerId` стабилен между рестартами |
| `p2p-node/index.js` | 96 | PoC libp2p: tcp+noise+yamux+identify, kad-dht `clientMode` | ✅ поднимается, DHT не опрашивает |
| `scripts/archive-transcripts.js` | 225 | Архивация транскриптов агента: gzip → проверка обратным чтением → `DELETE` партиями → `incremental_vacuum`. По умолчанию сухой прогон | ✅ 13431 строка → 9 МБ архива, база 628→605 МБ |

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
| `install/install.bat.tpl` | 252 | Установщик Windows: `start.cmd` запускает `node` в видимом окне (не `start /min`), чистый ASCII |
| `app/styles.css` | 2067 | Стили |
| `ui/console.html`, `ui/index.html` | — | Отдельная консоль оператора |

---

## 6. Агенты, знания, синхронизация

| Модуль | Строк | Роль |
| :--- | --: | :--- |
| `agent-runtime.js` | 285 | Бюджеты агента в токенах, вызовы инструментов |
| `knowledge-loop.js` | 573 | Сжатие Micro-LoRA (Trim 80% → INT8 → CSR), шлюз валидации |
| `benchmark-gate.js` | 206 | Benchmark Gate / Proof-of-Learning (Фаза 3) |
| `chat-sync.js` | 310 | Оффлайн-история: LWW-Element-Set + векторные часы |
| `seed.js` | 112 | Начальные данные (3 фикстуры адаптеров) |

---

## 7. Тесты и стенды

| Файл | Строк | Проверок | Что покрывает |
| :--- | --: | --: | :--- |
| `test-dpouw.js` | 8894 | **1086** | Основная приёмка: экономика, леджер, чеки, API, Private Swarm |
| `test-mesh.js` | 459 | **25** | Onion, mesh, многоузловой путь |
| `proof-treasury-gate.js` | 188 | **13** | Казна и гейт |
| `proof-agent-key.js` | 352 | 57 | Ключ агента: `exportKey` → `InvalidAccessError` |
| `proof-onion-inference.js` | 125 | — | Onion-инференс |
| `proof-onion-restart.js` | 161 | — | Переживание рестарта |
| `test-mesh-worker.js` | 50 | — | Воркер для mesh-теста |

**Итого приёмки: 1124** (1086 + 25 + 13), прогон 05.11 09:20, `RC=0`.
Гоняет `scripts/verify.sh`.

---

## 8. Скрипты (`scripts/`)

| Скрипт | Что делает | Осторожно |
| :--- | :--- | :--- |
| `deploy.sh` | **Коммит + пуш + раскатка.** `--dry-run` НЕТ | Аргумент с `-` отклоняется (`EXIT=2`); повторный `/health` перед откатом |
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

SQLite, `/var/lib/tarnet` на проде. 38 таблиц; группы по смыслу:

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

**`distillation_buffer` объявлена, но промпты туда не пишутся** — Фаза 2.5.

---

## 10. API — 64 маршрута

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
| `docs/NETWORK-CONTRACT-v1.md` | контракт воркера и API | при изменении API |
| `docs/PROJECT-MEMORY.md` | сводка по всем сессиям | по запросу |

**Правило одного источника:** факт о том, что работает, живёт в `MANIFEST`;
дата и причина — в `PROJECT-HISTORY`; расположение — здесь. Дублирование факта
в двух местах означает, что одно из них протухнет.

### 11.1. Раскладка папок (с 05.11.2026)

В корне `backend-api/` — **только четыре канонических документа и `README.md`**.
Всё остальное — в `docs/`. Перенос сделан 05.11.2026 (`git mv`, история сохранена).

| Где | Что |
| :--- | :--- |
| корень `backend-api/` | `MANIFEST.v3.4-UNIFIED.md`, `PROJECT-HISTORY.md`, `PROJECT-MAP.md`, `ROADMAP.md`, `README.md` |
| `docs/` — отчёты и планы | `docs/BACKLOG.md`, `docs/PLAN-WAVE2.md`, `docs/PLAN-AGENT-RUNTIME.md`, `docs/LEGAL-DISTILLATION-PIPELINE.md`, `docs/V2.17.*-REPORT.md`, `docs/V2.17.13-REPORT.md`, `docs/REALITY-CHECK-v2.17.7.md` |
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
