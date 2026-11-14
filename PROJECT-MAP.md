# PROJECT-MAP — карта кода TarNet / Synapse

**Назначение.** Где что лежит и что чем вызывается. Отвечает на вопрос «в какой файл идти»,
а не «что работает» (это `MANIFEST.v3.4-UNIFIED.md`) и не «как мы сюда пришли»
(это `PROJECT-HISTORY.md`).

**Сверено с кодом:** 2026-11-14 05:3x MSK, на проде и локально `2.29.6` (`curl /health` → `buildVersion: 2.29.6`, VPS = GitHub = локальная копия), гейт **1323 ✅ / 0 ❌** +
`test-conversation.js` **30 ✅ / 0 ❌** = **1353** — `2.29.6` (P1.1c) не добавляет файлов: правка внесена
в `agent-runtime.js` (вызов `onToolCall` в цикле `runAgent` обёрнут в `try/catch`, ошибка
возвращается наблюдением `tool_executor_threw`) и в `test-dpouw.js` (серия P1.1c, 3 проверки).
Предыдущая сверка 2026-11-13 11:5x MSK, локально `2.29.4` (прод — `2.29.3`), гейт **1298 ✅ / 0 ❌** +
`test-conversation.js` **30 ✅ / 0 ❌** — `2.29.4` (P1.1b) не добавляет файлов, а расширяет существующие:
`agent-runtime.js` (`TOOL_SCHEMAS`, `toolSchemasFor`, `normalizeToolCalls`, `withTimeout`,
потолок `maxToolCalls` в `runAgent`), `config.js` (`AGENT_MAX_TOOL_CALLS_PER_RUN`,
`AGENT_TOOL_TIMEOUT_MS`), `server.js` (колонка `worker_tasks.toolCallsJson`, таблица
`agent_tool_calls`, `recordAgentToolCall`, `parseToolCallsJson`), `worker-demo.js`
(`tools` в теле Ollama/облака, `toolCalls` в `payload` результата). Предыдущая сверка 2026-11-13 05:4x MSK, на проде и локально `2.29.3`, гейт **1293 ✅ / 0 ❌** +
`test-conversation.js` **30 ✅ / 0 ❌** — `2.29.3` (P1.1a) не добавляет файлов, а наполняет
существующий `agent-runtime.js`: `evaluateExpression`, `ledgerQuery`, `runToolCall` —
инструменты реально исполняются (каталог 3 → 4, §Б.79). Предыдущая сверка 2026-11-11 21:5x MSK, локально `2.29.1`, гейт **1272 ✅ / 0 ❌** +
`test-conversation.js` **30 ✅ / 0 ❌** — `2.29.1` добавляет два файла: `conversation.js`
(память диалога, без зависимостей) и `test-conversation.js` (E2E памяти), см. `MANIFEST` §Б.76.
Предыдущая сверка 2026-11-11 10:5x MSK, локально `2.28.0`, гейт **1355 ✅ / 0 ❌** —
`2.28.0` не меняет состав файлов: правки текста в `worker-demo.js` (`--self-check` называет транспорт)
и `app/app.js` (`OLLAMA_NOT_RUNNING` называет `ollama list`), см. `MANIFEST` §Б.67.
Предыдущая сверка 2026-11-10 16:0x MSK, локально и на проде `2.26.10-pre-nat-final`
(`/health` → `200`, `buildVersion: 2.26.10`) — `2.26.6` до аудита, `2.26.7` с честными флагами, `2.26.8` с миграцией уже лежащих строк, `2.26.9` с правками аудита 3.3–3.7, `2.26.10` с гейтом **1326** (4.3 перестала быть SKIP), см. `MANIFEST` §Б.57–Б.60.
Блокер отсутствия SSH-ключа снят — `deploy.sh` катит сам,
`verify.sh` сверяет VPS с GitHub (`sha256` 150/150) и версию `/health` с `package.json` (шаг 3.9).
Карта описывает **файлы**, поэтому устаревает медленнее манифеста — но при добавлении/удалении модуля правится в тот же день.

---

## 1. Точка входа и запуск

| Что | Где |
| :--- | :--- |
| Точка входа | `server.js` (`package.json` → `main`, `scripts.start`) |
| Команда | `npm start` → `node server.js`; порт `3001` |
| Приёмка | `node test-dpouw.js --test` — поднимает изолированный сервер на `mktemp`-БД |
| Прод | systemd `tarnet.service`, каталог `/opt/tarnet/backend-api`, БД `/var/lib/tarnet` |
| **SSH-ключ к проду** | Ключ живёт на **постоянном томе**: `~/.openclaw/ssh/tarnet_vps` (+ `.pub`, `config`, `known_hosts`); `~/.ssh` — **симлинк** на этот каталог. ПОЧЕМУ: `~/.ssh` лежал на overlay-слое контейнера и исчезал при пересборке целиком (так терялся доступ 08–09.11). Восстановление — `bash ~/.openclaw/ssh/ensure.sh` (идемпотентно); алиас `ssh tarnet-vps` работает. Не просить пароль, пока `ensure.sh` не прогнан |
| Мост к libp2p | systemd `p2p-bridge.service` (юнит в `deploy/systemd/p2p-bridge.service`), ключ узла `/var/lib/tarnet/p2p/peer-id.bin`, порт `4001` |
| **Порты: боевой vs демо** | `4001` — **только** `p2p-node/bridge.js` (настоящий libp2p, `P2P_PORT`, открыт в ufw). Демо-меш (`p2p-demo.js`, стартует из `server.js` через `ensureDemoMesh()`) — `4101`/`4102`. **Не возвращать демо-мешу `4001`:** `server.js` поднимается раньше моста и выигрывает гонку, мост падает `EADDRINUSE` и уходит в цикл рестартов, а `tarnet.service` при этом `active` и `/health` — `200` (09.11.2026, `NRestarts=28`) |
| Проверка снаружи | `https://v1107336.hosted-by-vdsina.com/health` и `/p2p/bootstrap` (за **Caddy** на `443`; порт `3001` наружу **закрыт** — не судить о доступности по нему) |
| Соседи P2P | `GET /p2p/status` → блок `bridge` (`connections`, `connected_peers`, `tasks.framesIn`) — **по нему считается готовность P1.1**; плюс `nodes`/`client` демо-меша и `registry` (реестр публичных адресов, критерием **не является**) |
| Проверка автозапуска (P1.2) | `GET /p2p/status → bridge.worker_addresses` — TAR-адреса (`0x…`) воркеров с авторизованным каналом, с 2.24.0. **`connected_peers` для этой сверки не годятся:** там peerId libp2p, а в `~/.tarnet/worker.json` — `0x…`. Нет поля вовсе = сервер старше 2.24.0 (код `3`), есть пустой массив = никто не подключён (код `1`) |
| Счётчики трафика | `p2p-node/task-protocol.js` → `createTaskClient().stats()` → `{framesIn, framesOut, rejected, channels}`; наружу — через `GET /p2p/status → bridge.tasks` |
| Деплой | `scripts/deploy.sh` — **коммит + пуш + раскатка без `--dry-run`** (см. §8). Шаг 5b ставит `npm ci` в `WorkingDirectory` моста **до** рестарта: `p2p-node/` — отдельный npm-пакет, `npm ci` для `backend-api` его не покрывает (09.11.2026 мост падал `ERR_MODULE_NOT_FOUND` на `@libp2p/gossipsub`) |

---

## 2. Ядро экономики (читать в этом порядке)

| Модуль | Строк | Роль |
| :--- | --: | :--- |
| `config.js` | 257 | **Единственный источник констант.** `PRICE_USD_PER_1M_TOKENS`, `USD_PER_TAR`, `TIER_WEIGHTS`, `PROTOCOL_FEE_RATE`, `TIER6.*`, `FAUCET.*` |
| `ledger.js` | 336 | `CumulativeLedger` — накопительные чеки, `debit()`/`credit()`, двойная запись, ключи at rest AES-256-GCM |
| `economics.js` | 255 | CWU, `√stake × reputation`, эмиссия с непрерывным затуханием, ставка `TAR_UTILITY` (единственное место — строки 115-116). С `2.23.3`: `verifyQuality` принимает `promptHashVerified` и различает три состояния; `spotCheckDecision` — 5% выборочная проверка (seed из содержимого работы, не из идентификаторов клиента) |
| `dag-chain.js` | 185 | SHA-256-сцепка чеков: `prevReceiptHash` / `receiptHash`, `payloadVersion: 2` |
| `dispatch-gate.js` | 141 | **С 2.27.1, расширено в 2.27.2** решение «есть ли кому отдать задачу»: `hasWorkerSource` спрашивает ДВА источника — присутствие в `worker_presence` (опрос и WS) и авторизованные каналы моста; `channelAddressInRegistry` берёт адрес из канала только для уже зарегистрированного узла, иначе `recordWork` бросает `Unknown worker node` и запрос стал бы 500 после отправки. **С 2.27.2:** `filterToLive(pool, liveSet)` сужает пул `pickWorker` до адресов с признаком жизни — без него взвешенный выбор по 152 историческим строкам `nodes` попадал в единственного живого воркера с вероятностью 0.4%, и задача уходила мёртвому адресу. Вынесено из `server.js`, чтобы проверялось тестом (38.16, 38.17) |

**Цепочка расчёта чека:** `POST /work` → `economics.js` (CWU, fee, block reward) →
`ledger.js` (запись, `decorate()`) → `dag-chain.js` (хеш-сцепка) → подпись Ed25519.

---

## 3. Сеть и транспорт

| Модуль | Строк | Роль | Статус |
| :--- | --: | :--- | :--- |
| `ws-inbound.js` | 601 | Входящий WS для воркеров: Ed25519-хендшейк, nonce, TOFU, кадры `TASK`/`CANCEL` | ✅ работает |
| `worker-demo.js` | 1989 | Воркер на ПК владельца: опрос/WS, `fetchAbortable`, `askOllama`/`askCloud`, `MAX_EARLY_CANCELS = 200`, `startLinkListener` — ввод кода привязки в окне воркера, `--self-check`. С 2.22.1: `runTask(task, via)` печатает `[WS]`/`[HTTP]` в строке приёма — видно транспорт получения, а не только отправки ответа. С 2.22.2: `startP2pExecutor()` — локальный вход `127.0.0.1` с токеном для p2p-процесса (libp2p в сборку не влезает). С 2.22.5: `loadOrCreateSeed` пишет seed из env в файл при его отсутствии; обработчики `/p2p/execute` и `/p2p/cancel`. С 2.22.6: флаг `--p2p` / `TARNET_P2P=1` (`P2P_WANTED`) — `startP2pChild()` поднимает `p2p-node/p2p-worker.js` через `spawn` (`stdio:'inherit'`) ПОСЛЕ `bindKey`; `SIGINT` гасит ребёнка; `findP2pWorker()` без `p2p-node` → `null` и честный текст. С 2.22.9: `linkState.pendingCode` + `retryPendingLink()` — отказ `DEVICE_KEY_UNKNOWN` НЕ теряет код привязки: он откладывается и гасится повторно после `AUTH_OK` (`connectWs`), ровно один раз; успех или иной код очищают ожидание. **С 2.24.8:** флаг `--test-p2p` — `TEST_P2P` выключает WS и опрос, задачи только по libp2p (успешная задача доказывает P2P, а не «что-то из двух»); `p2pDepsMissing()` проверяет `p2p-node/node_modules/libp2p/package.json` ДО запуска ребёнка и называет причину (`npm ci` не выполнен) вместо стектрейса `ERR_MODULE_NOT_FOUND`; `flagName()` печатает тот флаг, который набрал человек. **С 2.27.0:** `--self-check` не отменяет установку — неполный p2p-транспорт даёт `WARNING` с именами пакетов и код 0, потому что воркер без libp2p работает по WS. **С 2.28.0:** `--self-check` называет транспорт вслух — успех не молчит (`p2p-транспорт готов — лаунчер запустит воркер с --p2p`), а отсутствие узла рядом объясняется как законное состояние, а не провал | ✅ работает |
| `p2p-node/p2p-worker.js` | 739 | Воркер-клиент: bootstrap → `dial` → удержание соединения, поток `TASK_PROTOCOL`. С 2.22.2: `handleTask` принимает кадр `task` и проксирует его локальному исполнителю через `~/.tarnet/p2p-exec.json`, печатает `[p2p-worker] задача … → локальный исполнитель`. С 2.22.5: `waitForWorkerIdentity()` вместо одного чтения (`P2P_KEY_WAIT_MS`), `proxyCancelToLocalExecutor` → `POST /p2p/cancel`. **С 2.25.3:** в `transports` добавлен `circuitRelayTransport()`, в `listen` — `/p2p-circuit`. Оба нужны вместе: транспорт без `/p2p-circuit` в listen не запрашивает резервацию (адреса нет), а `/p2p-circuit` без транспорта не обслуживается. Relay — ТРЕТИЙ адрес, не замена TCP: узел без NAT соединяется напрямую и лишь дополнительно держит слот | ✅ сквозной проход и CANCEL доказаны `scripts/test-p2p-e2e.js` (`via:p2p`) |
| `p2p-channel-pick.js` | 83 | **Правило «кому доставить задачу» — одно на WS и P2P.** `pickChannel(channels,{preferAddress,excludeSet})` → `{channel,reason}`; `pickSwarmPair(wsOrdered,p2pAddresses)` → 0–2 уникальных адреса. С 2.22.12: вынесено из `server.js` после **двух** одинаковых дефектов подряд (`taskClient.send` → `dispatchTaskOverP2p`), оба — «берём первый живой вместо адресата». Чистые функции, проверяются обычным `node` без моста и libp2p | ✅ 61.1–61.9 |
| `p2p-bridge-client.js` | 225 | Клиент моста для server.js без зависимостей. `send`, `announceOnStartup`, `startAnnounceLoop`, `nodeIdentity`. С 2.22.2: `task(payload)` — задача воркеру через мост. С 2.22.5: `cancel({taskId,address,reason})` → `{ok,cancelled[],channels}` | ✅ работает |
| `worker-box.js` | 132 | `openFromWorker` / `sealToWorker`: `sessionKey` шифруется на ключ воркера. **Локальная зависимость воркера** — вшивается сборкой, отдельно не качается | ✅ работает |
| `build-worker.js` | 188 | Сборщик одного файла: `maskComments`, `localRequireNames`, `stripShebang`; `require('./x')` → `__localRequire('x')` | ✅ работает |
| `dist/tarnet-worker.js` | — | Готовая сборка, её отдаёт `/download/worker.js`. В `.gitignore`; **пересобирается автоматически, если старше `worker-demo.js` / `worker-box.js` / `build-worker.js`**. С 2.21.5: проверка «файл есть» не считалась свежестью — старая сборка жила вечно | 🏗 артефакт |
| `p2p-transport.js` | 611 | WS между узлами, `wildcardBind`, `P2P_PUBLIC_URL → P2P_ADVERTISE_IP` | ⚠️ настроен только на `127.0.0.1` |
| `onion.js` | 289 | Onion Routing: RSA-2048-OAEP-SHA256 оборачивает 32-байтный AES, нагрузка AES-256-GCM | ✅ работает (`hops: 3`) |
| `p2p-demo.js` | 129 | Демонстрация P2P. `PREFERRED_PORTS = { relay1: 4101, relay2: 4102 }` — уведён с боевого `4001` (см. строку «Порты: боевой vs демо») | демо |
| `p2p-node/bridge.js` | 963 | Отдельный процесс. Unix-socket `/tmp/tarnet-p2p-bridge.sock` (0600), JSON Lines, `announce`/`status`/`peers`/`ping`/`task`/`cancel`. С 2.21.4 принимает поток `/tarnet/task/1.0.0` от воркеров. С 2.22.5: `cancel(msg)` → `taskClient.cancel()`. Action **`channels`** добавляется с 2.22.x (список авторизованных живых каналов) — если его нет в ответе, мост на старом коде. С 2.24.0: `status()` отдаёт `worker_addresses` — TAR-адреса авторизованных живых каналов, по ним `check-autostart` сверяет «в сети ЭТОТ ПК». **С 2.25.3:** `circuitRelay: circuitRelayServer(...)` — мост теперь и relay. DHT-сервер и relay — РАЗНЫЕ вещи: DHT отвечает «кто и по какому адресу», relay даёт путь туда, где входящий TCP невозможен. `P2P_RELAY=0` выключает. `maxReservations` поднят с дефолтных 15 до 256: шестнадцатый воркер иначе молча не получал слот и оставался невидимым в DHT; `defaultDataLimit` 2 МБ на соединение — запись и кадр задачи влезают, чужой поток не проедет. **С 2.25.4:** `P2P_SEED_PEERS` — список соседних seed, к которым узел звонит сам; `seedPeers` в `status()` (`seeds_total`/`seeds_linked`) — «два seed в конфиге» и «два seed видят друг друга» разные факты. Повтор dial: 18×10 с в фоне с `unref()`, потому что systemd стартует оба юнита одновременно и сосед ещё не слушает порт | ✅ работает на проде (`p2p-bridge.service`) |
| `p2p-node/task-protocol.js` | 328 | Кадры задачи поверх libp2p-потока: один JSON на строку, `createTaskClient` (мост) / `serveTaskStream` (воркер). Без `stream.source`/`sink` — в libp2p 3.5.1 поток итерируется сам, запись через `stream.send` + ожидание `drain` своим `waitEvent` (без пакета `p-event`: тот приходил транзитивно и исчез бы при обновлении libp2p). С 2.22.5: `CONTROL_FRAME='cancel'`, `isControlFrame`, `cancel()`; управление читается **вне** цепочки задач, иначе отмена ждала бы ответа модели. С 2.24.0: ожидания ответов в `Map<taskId, waiter>` вместо массива FIFO — ответ ищется по `taskId`, а не по порядку; ответ без id или с чужим id не отдаётся никому (`orphans` в `stats()`), `ping` идёт отдельной анонимной полосой. С 2.24.1: `isPongFrame()` — анонимная полоса принимает только pong (`{action:'pong'}` или `{action:'ping',pong:true}`), прочие кадры без id — сироты; повторный `taskId` считается `duplicates` (отдельно от `orphans`), память об id ограничена 512 записями | ✅ 51.12–51.14, `check-correlation.mjs` 8/8 |
| `p2p-node/worker-record.js` | 399 | **Запись присутствия и провайдер-индекс.** Схема `tarnet.worker-record.v1`, `DEFAULT_NETWORK_ID='tarnet-testnet-1'`, `RECORD_TTL_MS=90000`, `ANNOUNCE_MS` = треть TTL. Собирает CIDv1/raw **вручную** (38 байт + base32) и base58btc для `peerId` — модуль обязан проверяться на чистой машине, поэтому ни `libp2p`, ни `multiformats` не импортируются; совпадение с библиотекой доказывает E2E-тест. Экспорт: `bucketKey`, `bucketCid`, `provideCids`, `buildRecord`, `verifyRecord`, `publicKeyFromSeed`, `nextSequence` (seq в `~/.tarnet/worker-record-seq`), **с 2.28.2** `normalizeModelFamily`. **Почему нормализация живёт здесь, а не в клиенте:** `bucketKey()` зовёт её сам, поэтому воркер (`provideCids`) и клиент (`findWorkers`) физически не могут посчитать бакет по разным строкам. До 2.28.2 `model` уходил в ключ целиком вместе с тегом версии (`qwen2.5-coder:1.5b`), а воркер объявлял семейство без тега (`P2P_MODEL_FAMILIES=qwen2.5-coder`) — CID не совпадали никогда. Соответствие «модель → семейство» не угадывается: в каталоге `/models` поля `family` нет, поэтому снимается только тег после `:`, а теги с `/` или пробелами отбрасываются JCS берётся из корневого `jcs.js`, второй канонизатор не пишется. **С 2.26.0** `verifyRecord()` ужесточён: `sequence` — положительное целое, TTL ≤ 120 000, канонический base64 (`Buffer.from(sig,'base64').toString('base64') === sig` — иначе «подпись» могла быть неоднозначной записью тех же байт), `workerAddress` по `^0x[a-f0-9]{40}$`, непустой `capabilities.modelFamilies` | ✅ `test-discovery-e2e.js` 10/10 |
| `p2p-node/discovery-client.js` | 232 | **Поиск воркера через DHT** (2.26.0, Блок 3). Единственный модуль, который вызывает `findProviders` — до него провайдер-запись класть умели, а забрать было нечем. Бакет по `(model, deviceClass)` → `findProviders(cid)` → прямой поток `/tarnet/worker-record/1.0.0` к каждому провайдеру за подписанной записью. Возвращает три **разных** списка: `workers` (найдено поиском), `rejected` (пришло, но не прошло `verifyRecord`), `cached` (пришло по gossipsub). Склеивать их нельзя: `cached` — это кэш, а не результат DHT. **Обязан быть в `p2p-bundle.js`** — иначе архив уезжает без модуля и `GET /p2p/discover` падает `ERR_MODULE_NOT_FOUND` на машине пользователя. **С 2.28.1:** разбор событий DHT вынесен в экспортируемую `extractProviderIds(events)`; зовут её **и** `findWorkers()`, **и** тест — инлайн-копии больше нет. До этого разбор не смотрел на имя события и брал само событие, если у него нет поля `providers`; `DIAL_PEER` такого поля не имеет, `String(evt)` давал `"[object Object]"`, и `providers` в ответе становилось `1` при пустой DHT. Правильное поле — `p.id` (в `PeerInfo` kad-dht нет `p.peerId`; `p.toString()` на объекте всегда `"[object Object]"`). **С 2.28.2** модель нормализуется до семейства перед ключом — см. `worker-record.js` | ✅ `test-discovery-e2e.js` 14/14 (4.0 — ловушка на `[object Object]`, 4.0a — тег не меняет бакет, 4.0b — `qwen` ≠ `qwen2.5-coder`) |
| `p2p-node/gossip-announce.js` | 164 | **Объявления присутствия в GossipSub.** `announceTopic(networkId)` → `/tarnet/<networkId>/workers/1.0.0`; `gossipOptions()` с `globalSignaturePolicy: StrictSign`; `createRecordValidator` — схема, `expiresAt`, `message.from.toString() === record.peerId`, Ed25519-подпись; `attachGossip(node, …)` вешает валидатор через `node.services.pubsub.topicValidators.set`. Передаются **только метаданные присутствия** — ни промптов, ни результатов | ✅ подпись и подделка проверены E2E |
| `p2p-node/peer-auth.js` | 168 | **Проверка права на поток задач:** `verifyHello` (Ed25519 тем же ключом, что в WS), `loadAllowlist` — формат `{updatedAt,peers}`, нет файла/битый JSON = запрет; префикс `TARNET_P2P_HELLO`, окно 120 с | ✅ 11 проверок в 51.1–51.11 |
| `p2p-node/peer-hello.js` | 153 | Сторона воркера: `loadWorkerIdentity` (env → `~/.tarnet/*.json`), `buildHello` — подпись PKCS8-обёрткой seed, тот же префикс, что в `worker-demo.js`. С 2.22.5: `workerKeyFile({home,env})` (`P2P_WORKER_KEY_FILE`), `waitForWorkerIdentity({timeoutMs,pollMs})` — ключ может появиться позже. **`verifyHello` здесь НЕТ** — он в `peer-auth.js` | ✅ без сети, обычным `node` |
| `p2p-node/peer-id-store.js` | 81 | Генерация/чтение ключа узла: `/var/lib/tarnet/p2p/peer-id.bin`, права `0600` | ✅ `peerId` стабилен между рестартами |
| `p2p-node/public-addr.js` | 144 | Разбор публичного адреса **без зависимостей** (вынесено, чтобы проверять логику обычным `node`, не ставя libp2p 115 МБ): `P2P_PUBLIC_URL` → `/dns4|dns6|ip4|ip6/…/tcp/<port>/p2p/<peerId>`. Экспорт **именованный** (пакет `"type": "module"`) — `module.exports` падает `ReferenceError`. **`Listen` и `WAN` — разные вопросы:** `Listen` = где открыт порт, `WAN` = как найдут снаружи; при `P2P_PUBLIC_URL` + `P2P_HOST=127.0.0.1` печатаются оба и предупреждение «снаружи недостижим» | ✅ проверяется без сети |
| `p2p-node/test/test-discovery-e2e.js` | 336 | E2E обнаружения: два DHT-сервера в таблицах друг друга, `provide(cid)`, `findProviders`, адреса провайдера, прямой поток `/tarnet/worker-record/1.0.0`, схема записи, совпадение `peerId`, Ed25519-подпись, отказ подделанной записи. **С 2.26.1** флаги `--expect-peer` и `--worker-seed`: ключ строится `generateKeyPairFromSeed`, поэтому `peerId` предвычислим **до** старта воркера, и проверка 4.3 сверяет найденного провайдера с ожидаемым (иначе «нашёл того, кого искал» самосогласованно). Проверка 2.1 сверяет предсказанный `peerId` с фактическим. **Лежит в подпапке намеренно:** `p2p-bundle.js` собирает архив по списку, а тест `54.4` требует, чтобы каждый `.js` **верхнего уровня** уезжал пользователям. Тест — не рантайм. **С 2.28.2** две новые ловушки: 4.0a — `qwen2.5-coder:1.5b` и `qwen2.5-coder` дают один CID; 4.0b — `qwen` и `qwen2.5-coder` дают разные (иначе 4.0a проходила бы за счёт склейки всех семейств). Рядом лежат два пробника: `probe-provider-shape.js` (сырая форма события `PROVIDER`) и `probe-search-topology.js` (поиск с сервера vs с клиента) | ✅ 14/14, запуск из `scripts/test-discovery-e2e.js` |
| `p2p-node/test/test-gossip-e2e.js` | 232 | E2E обмена `WorkerRecord` через GossipSub между **двумя независимыми процессами**. Оркестратор поднимает seed-узел (эмуляция моста: обязан быть подписан на тему, иначе два клиента не видят друг друга) и два дочерних узла через `spawn`, с разными seed → разными `peerId`. Доказывает то, чего не может тест в одном процессе: кадр реально доходит по сети, `message.from === record.peerId` сходится на живом трафике, а не на подставленном объекте. 9 проверок: тема содержит `networkId`, оба процесса поднялись, peerId'ы разные, запись принята, подпись проверена, отправитель совпал, схема верна, `workerAddress` без искажений | ✅ 9/9 |
| `p2p-node/test/gossip-node.js` | 246 | Один узел для `test-gossip-e2e.js`, запускается дочерним процессом: роли `publisher` (ждёт соседей в mesh, публикует 3 раза с паузой 1.2 с — mesh формируется на heartbeat) и `subscriber` (ждёт запись, проверяет её тем же валидатором, что прод). Узел поднимается **тем же ключом**, что подписывает запись: иначе `buildRecord` бросает `PEER_ID_MISMATCH`. Stdout машинно-читаемый (`READY:`/`RESULT:`), логи — в stderr | ✅ используется `test-gossip-e2e.js` |
| `p2p-node/test/test-reannounce-e2e.js` | 392 | **E2E пере-объявления** (`2.26.1`, Блок 2). Поднимает **настоящий** `p2p-worker.js` дочерним процессом со своим `HOME`, а не копию логики: проверяемое живёт в `setInterval` внутри `main()`, и копия в тесте проверяла бы копию. Ждёт дольше `WORKER_RECORD_TTL_MS` (`TTL=1500` → `ANNOUNCE_MS=500`, отношение TTL/ANNOUNCE как в проде) и требует, чтобы запись осталась свежей (`expiresAt > now`) и `sequence` вырос. 9 проверок: объявление, целый `sequence`, TTL записи, отдача после TTL, неистёкший срок, рост `sequence`, рост `issuedAt`, полная `verifyRecord`, и контрольная 2.6 — `verifyRecord` с `now = expiresAt+1` обязан вернуть `EXPIRED` (иначе зелёная проверка срока ничего не значит). **Запись берётся по прямому потоку**, а не через `findProviders`: тот не завершается, пока провайдер не найден (первый прогон — `EXIT=124`, пустой вывод). Наличие записи в DHT доказывает `test-discovery-e2e.js` | ✅ 9/9 |
| `p2p-node/test/test-relay-e2e.js` | 197 | **E2E relay при строгом NAT** (`2.25.3`). Клиент поднимается **без единого TCP-адреса** (`listen: ['/p2p-circuit']`) — не «закрытый порт», а отсутствие прямого пути по построению: с закрытым портом на loopback тест мог бы пройти по TCP и не доказать ничего. 10 проверок: relay слушает и объявляет HOP-кодек, у клиента 0 прямых адресов, резервация получена, адрес содержит `/p2p-circuit` + `peerId` клиента, входящий поток дошёл и ответил, ответ помечен `via=relay`. **Обработчик ставится на КЛИЕНТА** — звонят ему, а не серверу | ✅ 10/10 |
| `p2p-node/test/test-seed-failover.js` | 321 | **Discovery через ЛЮБОЙ из двух seed** (`2.25.4`). Воркер объявляется через seed1, клиент знает **только** seed2 — и находит воркера: это доказывает, что провайдер-запись доехала по DHT между seed, а не лежала в одной таблице. Плюс обратное направление и отрицательный контроль (изолированный seed не находит провайдера из чужой сети). Доказательство строится на **разнице двух замеров** соединений по обе стороны от `provide()`: после него сам DHT звонит ближним узлам, поэтому «воркер знал только seed1» проверять нельзя — можно только «до provide знал один, после — два» | ✅ 12/12 |
| `deploy/Caddyfile.tpl` | — | **Шаблон reverse-proxy с автоматическим TLS** для `bootstrap.sh`: `{{DOMAIN}}` подставляется при установке. В репозитории отсутствовал — конфиг жил только на одном сервере, и при переезде прокси восстанавливался руками | `caddy validate` → `Valid configuration`. Сохраняет `header_up X-Real-IP {remote_host}`: без него лимиты и логи видят адрес Caddy, и rate-limit считает всех одним человеком |
| `deploy/systemd/tarnet-seed2.service` | 62 | **Второй DHT-seed**, `P2P_PORT=4002`, `P2P_DATA_DIR=/var/lib/tarnet/p2p-seed2` (свой ключ → свой peerId; общий каталог дал бы один узел дважды), сокет `/tmp/tarnet-seed2.sock`, `P2P_SEED_PEERS=/ip4/127.0.0.1/tcp/4001`. В юните прямо написано, что это НЕ резервирование: одна машина, один диск, один systemd — падение VPS уносит оба | ✅ работает на проде |
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
| `conversation.js` | 271 | **С 2.29.1.** Память диалога: `normalizeMessages`, `messagesToPrompt`, `truncateMessages`, `conversationFromBody`, `chatMessagesFor`, `estimateTokens`. Без внешних зависимостей — вклеивается в сборку воркера (`build-worker.js` → `LOCAL_MODULES`). **Один модуль на четыре точки** (`/inference`, тело `worker_tasks`, `worker-demo.js`, PWA): разойдись нормализация в двух из них — разошлась бы ровно на том поле, что сверяется хешем |

---

## 5. Идентичность и клиент

| Модуль | Строк | Роль |
| :--- | --: | :--- |
| `identity.js` | 232 | TarNet ID: детерминированный вывод ключей из мастер-энтропии |
| `jcs.js` | 74 | RFC 8785. **Применяется только в Device Linking** (`server.js:4108`), не в подписи `/work` |
| `app/app.js` | 3261 | PWA-клиент: чат, кошелёк, агенты, `CryptoKey` с `extractable: false` в IndexedDB. **С 2.26.13** сайдбар показывает два разных факта вместо одного: узлы из `bridge.connections` (`paintNetworkStatus`, `null` если мост не ответил) и воркеры из `lastHealth.active_workers`; демо-ответ объясняет `pending_work`/`threshold` через `.trace-note` и не подставляет номер чека. **С 2.28.0:** текст `OLLAMA_NOT_RUNNING` называет `ollama list` — одна команда отделяет «не запущена» от «не установлена/сломана»; 11.11 этот код пришёл при исправной на вид установке с повреждённым бинарником |
| `app/agents.js` | 811 | Агенты в браузере, вендорный `noble-ed25519` (`app/vendor/ed25519.js`) |
| `app/sw.js` | 212 | Service worker, кэш `tarnet-app-v35` |
| `app/index.html` | 746 | Разметка чата, инструкция привязки: код вводится в окне воркера |
| `install/install.bat.tpl` | 512 | Установщик Windows: `start.cmd` запускает `node` в видимом окне (не `start /min`), чистый ASCII. **С 2.22.7** качает `/download/p2p-node.zip`, распаковывает в `%LOCALAPPDATA%\TarNet\p2p-node`, ставит зависимости `npm ci --omit=dev`, проверяет `import('libp2p')` и только тогда добавляет `--p2p` в лаунчер (`P2P_OK=1`). Любой отказ p2p — `WARNING` и работа на WS, а не падение установки. **С 2.22.10** кладёт ярлык `TarNet Worker.lnk` в Startup (только Windows) через `GetFolderPath('Startup')`, цель — `start.cmd`, сбой ведёт в `:autostart_failed`. **С 2.24.8** `start.cmd` начинается с `cd /d "%TARNET_DIR%"`: без него запуск из чужой папки (ярлык, автозапуск, терминал) терял `p2p-node/` молча **С 2.26.12** проверяет `jcs.js` после распаковки (`:p2p_no_jcs`) и печатает строки запуска как `%%*`, чтобы `start.cmd --test-p2p` действительно передавал аргумент; семейство модели добирается из `ollama list`, если `pull` пропущен. **С 2.27.0** npm ищется цепочкой `where npm.cmd` → `where npm` → `node_modules\npm\bin\npm-cli.js`, и найденный путь идёт в сам вызов `ci`: на nvm/fnm и портативном Node рядом с `node.exe` npm нет, и зависимости молча не ставились |
| `install/install.command.tpl` | 384 | Установщик macOS/Linux: то же для p2p (распаковка `unzip`, фолбэк `ditto` на macOS без CLT); `start.sh` получает `--p2p` только при `P2P_OK=1`. **С 2.24.8** `start.sh` начинается с `cd "$TARNET_DIR"`: без него запуск из чужой папки терял `p2p-node/` молча **С 2.26.12** проверяет `jcs.js` до `npm ci` (`JCS_OK=0` — транспорт пропускается с названной причиной) и добирает семейство из `ollama list` |
| `p2p-bundle.js` | 252 | **Новое в 2.22.7.** Сборка ZIP с `p2p-node` для установщика своим писателем на `node:zlib`: `buildZip`, `crc32` (свой — `zlib.crc32` только с Node 22.2), `buildP2pArchive`, `getP2pArchive` (кеш по mtime). Явный список `BUNDLED_FILES`: забытый модуль — ошибка сборки, а не `ERR_MODULE_NOT_FOUND` у человека. `data/` (ключ узла) и `node_modules` не входят никогда **С 2.26.12** второй список `ROOT_FILES = ['jcs.js']`: корневые файлы кладутся без префикса `p2p-node/`, иначе `requireFromHere('../jcs.js')` промахивался на уровень; штамп кеша учитывает и их |
| `app/styles.css` | 2087 | Стили |
| `ui/console.html`, `ui/index.html` | — | Отдельная консоль оператора |

---

## 6. Агенты, знания, синхронизация

| Модуль | Строк | Роль |
| :--- | --: | :--- |
| `agent-runtime.js` | 611 | Бюджеты агента в токенах, политика инструментов и **исполнение** их с `2.29.3` (P1.1a): `evaluateExpression` — собственная грамматика без `eval`, `ledgerQuery` — read-only чтение источника, `runToolCall` — единый вход. Плюс `parseToolRequests`/`stripToolRequests` для маркеров `[[tool:...]]` |
| `knowledge-loop.js` | 641 | Сжатие Micro-LoRA (Trim 80% → INT8 → CSR), шлюз валидации. С `2.23.3`: `selectPairs` расшифровывает `promptText`/`response` через `decryptText` — без этого сборка датасета после шифрования вернула бы `DECRYPT_UNAVAILABLE`. С **`2.25.2`** обратная сторона того же ключа: `encryptText` шифрует `prompt`/`response` **при записи JSONL**, потому что файл переживает запрос и лежит в `storage/experience` до ручной уборки. Служебные поля (`promptHash`, `rating`, `modelId`, `domain`) остаются открытыми — иначе тренер не отберёт по домену; NDA не содержимого диалога |
| `benchmark-gate.js` | 206 | Benchmark Gate / Proof-of-Learning (Фаза 3) |
| `chat-sync.js` | 310 | Оффлайн-история: LWW-Element-Set + векторные часы |
| `seed.js` | 112 | Начальные данные (3 фикстуры адаптеров) |

---

## 7. Тесты и стенды

| Файл | Строк | Проверок | Что покрывает |
| :--- | --: | --: | :--- |
| `test-dpouw.js` | 11716 | **1298** | Основная приёмка: экономика, леджер, чеки, API, Private Swarm, корреляция ответов (51.12–51.14), сверка адреса автозапуска (59.1–59.4b), `--test-p2p` и диагностика зависимостей (53.7–53.10) |
| `test-mesh.js` | 459 | **25** | Onion, mesh, многоузловой путь |
| `proof-treasury-gate.js` | 199 | **15** | Казна и гейт. С 2.24.1 фикстура проходит гейт оплаты: отдельный плательщик через `POST /faucet/claim`, `clientAddress` в теле `/work`. Две проверки фикстуры (faucet выдал, баланс > 0) + 13 исходных |
| `proof-agent-key.js` | 352 | 57 | Ключ агента: `exportKey` → `InvalidAccessError` |
| `proof-onion-inference.js` | 125 | — | Onion-инференс |
| `proof-onion-restart.js` | 161 | — | Переживание рестарта |
| `test-mesh-worker.js` | 50 | — | Воркер для mesh-теста |
| `check-payment-gate.js` | 130 | **7** | Гейт оплаты на живом сервере: `/work` без `clientAddress` → 400 и ноль начислений; пустой клиент → 402; `TARNET_REQUIRE_PAYMENT=0` возвращает стенд |
| `test-conversation.js` | 388 | **30** | **С 2.29.1.** Память диалога E2E: мульти-раунд `/inference` с `messages[]`, канонический `prompt`, сверка `promptHash` на воркере, старый путь `prompt` байт-в-байт (два ключа, без `messages`), `400 PROMPT_MESSAGES_MISMATCH`, `400 PROMPT_REQUIRED`, обрезка с сохранением первого и последнего хода |
| `p2p-node/check-correlation.mjs` | 95 | **8** | Корреляция ответов по `taskId`: поздний ответ не достаётся следующему ожиданию, чужой id — сирота, `ping` отдельной полосой |

**Итого приёмки: 1227** (`test-dpouw.js`), прогон 09.11 05:58, `0 ❌`. Плюс отдельные стенды: `check-payment-gate.js` 7/7 и `check-correlation.mjs` 8/8.
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
| `check-autostart.js` | **Проверка P1.2**: ждёт `active_workers ≥ 1` **и** `bridge.connections ≥ 1` в окне (600 с). С 2.24.0 с адресом (`--address` или `~/.tarnet/worker.json`) ждёт **этот** узел по `worker_addresses`. С 2.24.1 при известном адресе требуются **оба** факта — адрес в `worker_addresses` И `active_workers ≥ 1`: канал переживает падение воркера, поэтому «адрес есть, воркер мёртв» раньше давало ложный код 0. Вывод печатает `addr=` и `mine=` раздельно. `--any` — сверка по счётчику. `--url`, `--window`, `--interval`, `--json` | Проверяет **следствие**, а не причину: сервер не знает о перезагрузке ПК. Коды: 0 — узел в сети, 1 — таймаут (называет причину), 2 — плохой аргумент, **3 — сервер старше 2.24.0 (поля `worker_addresses` нет): сверка по адресу невозможна, это не провал**. Пустой список ≠ отсутствие поля — различаются `hasAddressField` |
| `verify.sh` | Гоняет три набора + сверяет `/config` с `config.js` | Основной вход приёмки |
| `ensure.sh` | **Резервный SSH-ключ владельца на VPS** (`2.25.2`): идемпотентно добавляет публичный ключ в `/root/.ssh/authorized_keys`, затем **проверяет вход именно этим ключом** (`-o IdentitiesOnly=yes`). Проверка не прошла — файл откатывается из `bak`, основной доступ не теряется | Не путать с `~/.openclaw/ssh/ensure.sh` (тот про восстановление локального каталога ключа, этот — про `authorized_keys` на сервере). Ключ едет в argv как base64: публичный ключ секретом не является, а base64 снимает вопрос кавычек в комментарии. Файл пишется через временный + `mv`: обрыв связи посередине не оставит пустой `authorized_keys` |
| `test-p2p-e2e.js` | **Сквозной P2P** (`2.22.3`): поднимает мост + `p2p-worker.js` + исполнитель во временном `HOME`, ждёт `via:'p2p'` | Свой сокет/порт/bootstrap-заглушка — боевой мост не трогает; проверен loopback, не боевая топология |
| `prune-archives.js` | **Очистка `.zst`** (`2.22.4`): удаляет архивы старше 7 дн. только при совпадении SHA-256 с `session_transcript_archives` | Dry-run по умолчанию; возраст из метки `.deleted.<ISO>` в имени, не из mtime. Прогон: 32 файла, 75.3 КБ |
| `prune-distill.js` | **Очистка `distill-*.jsonl`** (`2.25.3`): два независимых основания — `adapterHash` файла есть в `adapter_versions` (обучен) ИЛИ возраст ≥ `--days` (30). Домен берётся из поля `domain` первой строки, не из имени: имя санировано (`/` → `_`), и `code/review` с `code_review` дали бы одно имя при разных хешах | Dry-run по умолчанию; расписание — `tarnet-prune-distill.timer` (вс 03:00, `--apply`, `Persistent=true`). **Считает ОБА варианта хеша**: `mock_train.py` кладёт `domain + \x00 + data`, fallback в `knowledge-loop.js` — без нулевого байта, и подгонка под один оставила бы файлы второго пути навсегда | ✅ фикстура: обучен python-стилем, обучен fallback-стилем, свежий необученный оставлен, старый удалён, повторный прогон — 0 удалений |
| `migrate-legacy-jsonl.js` | **Миграция старых датасетов** (`2.26.0`, Блок 7): перешифровывает записи `enc:v1:` в `enc:v2:` с AAD `promptHash:field` и пишет через `.tmp` + `rename`. Атомарность здесь не украшение: мигратор переписывает существующие файлы, и смерть на середине оставила бы обрезанную последнюю строку — валидный для тренера JSONL. `enc:v1:` читается по-прежнему: смена формата на месте превратила бы старые датасеты в мусор | Dry-run по умолчанию, `--apply` пишет |
| `backup.sh` | **Перенос состояния на другой хост** (`v2.29.0-portable-deploy`): `VACUUM INTO` снимок БД (CLI `sqlite3` на проде нет — снимок через `node:sqlite`), затем 27 файлов в `tar.gz` с `MANIFEST.txt` внутри: БД, `master.key`, `faucet-ip.key`, `rclone.conf`, `litestream-tarnet.yml`, `peer-id.bin` ×2, allowlist, 6 юнитов + 3 drop-in'а, `Caddyfile`, 5 канонических документов | Печатает **одну строку JSON** (`ok`, `archive`, `bytes`, `sha256`, `db_bytes`, `files`, `commit`). Архив проверяется **до** `ok:true` и при неполноте **удаляется** — непроверенный бэкап на диске хуже отсутствующего. Проверка архива сделана одним `tar -tzf` в список: `grep -q` под `set -o pipefail` давал ложное «нет файла» из-за `SIGPIPE` от `tar`. `node_modules` не входит намеренно (567 МБ) |
| `bootstrap.sh` | **Развёртывание на чистом Debian/Ubuntu** до отвечающего `/health`: 12 шагов с проверкой каждого. Ставит Node ≥ 22 (NodeSource: apt даёт 18, а нужен `node:sqlite`), Caddy, ufw; `npm ci` **дважды** (корень и `p2p-node` — разные lock-файлы); восстанавливает БД и секреты из архива `backup.sh`; подставляет домен в юниты и `Caddyfile.tpl`; открывает 22/80/443/4001/4002, **3001 не открывает** | Два места стоили падения при замере и закрыты кодом: **swap 2 ГБ** (с 1 ГБ `npm ci` убивается ядром на распаковке `onnxruntime`, `code 137`) и **`ONNXRUNTIME_NODE_INSTALL=skip`** по умолчанию (`install-metadata.js` объявляет `'linux/x64': ['cuda12']`, пакет тянет 272 МБ CUDA-провайдера на любом x64; серверу он не нужен — инференс на воркере. `--with-cuda` для обратного). Проверяет, что systemd **видит** `TARNET_PUBLIC_URL`, а не что файл лёг на диск. Без `--domain` не стартует: домен вписывается в юниты, а пустой дал бы хост со ссылками на чужую машину. Полного прогона на чистой ОС **не было** — см. `docs/STAGE-PORTABILITY.md` |
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
| `MASTER-PLAN.md` | «где мы на пути от идеи до цели» — 16 этапов (0–15), статус каждого. Единственный документ, показывающий весь путь; остальные его дополняют, но не заменяют | при закрытии любого этапа — в том же коммите |
| `docs/BACKLOG.md` | «что отложено и почему» | когда задачу откладывают |
| `docs/REALITY-CHECK-v4.md` | «что обещали и что имеем» — Gap Analysis Манифест vs Код, срез `2.26.1`. Уровни доказательства A/B/C: Discovery готов к runtime, **уровень C (NAT) пуст** | при смене вехи; устаревает → заменяется v5, а не правится. `v3` — история среза `2.22.13` |
| `docs/NAT-TEST.md` | **инструкция владельцу**: проверка воркера за домашним роутером. Установка (`worker.js` + `p2p-node.zip` + `npm ci`), `--test-p2p` против `--p2p`, строки `[p2p-worker]`, `check-autostart.js`, таблица «NAT не пробит / воркер не стартовал». Сверен с кодом 09.11.2026: флаги, шаблоны `start.*`, эндпоинты и поля `/p2p/status` совпадают | пока уровень C пуст — настольная инструкция; после прогона заменяется отчётом в `PROJECT-HISTORY` |
| `docs/NARRATIVE.md` | **нарративная история проекта для инвесторов**: тот же путь, что в `MASTER-PLAN`, но рассказным языком (5 актов, от «Биткоина для ИИ» до P2P). Не содержит обязательств сверх кода; каждое число проверяемо (`/health`, `/summary`, `/models`, `verify.sh`). Срез `2.26.3`: 793 чека, 1324 теста, последний чек `seq 793` | при закрытии этапа — править вместе с `MASTER-PLAN`; при расхождении побеждает код |
| `docs/PRE-NAT-STATUS.md` | **готовность к NAT-тесту одной страницей**: что готово (с доказательствами), что нужно от Владельца пошагово, что будет после успеха (`v2.27.0`, этап 9), что останется (второй seed, верификация, спрос) | переписывается перед NAT-тестом и после него; не дублирует `NAT-TEST.md` — тот про «как сделать», этот про «где мы» |
| `docs/PITCH-DECK.md` | «что говорить инвестору» — 13 слайдов; слайд 10Б «Реальность vs Видение» обязателен, `$330`/`GMV` только как отозванные или сценарий | при каждом изменении живых цифр; цифры в слайдах 6 и 9Б — снимок стенда |
| `docs/NETWORK-CONTRACT-v1.md` | контракт воркера и API | при изменении API |
| `docs/STAGE-10-WEBRTC.md` | **план транспорта PWA↔воркер** (Этап 10 `MASTER-PLAN`): discovery через `/p2p/discover`, DataChannel, `werift` вместо `wrtc`, TURN с честной оговоркой «видит трафик, но не расшифрует», подпись `TaskGrant` через `peer-auth.js`, откат на WS-relay с явным логом. Статус — **план, кода нет** | при приёмке B1 (создан); правится при старте работ по WebRTC, после реализации — заменяется отчётом в `PROJECT-HISTORY` |
| `docs/STAGE-10-CHECKLIST.md` | **порядок готовности Этапа 10** (WebRTC-транспорт, не второй seed): пять пунктов в обязательной последовательности — A3 (`found ≥ 1`, открыт) → P1.2 (ребут, блокирован п. 1) → WebRTC-прототип (закрыт `2.28.4`) → WebRTC в PWA (не начат) → отказ от `POST /inference` (не начат). Критерии, предусловия и точные строки лога взяты из кода `2.28.4`, а не из описания | при переходе любого из пяти пунктов; правится, пока этап открыт, после закрытия — заменяется отчётом в `PROJECT-HISTORY` |
| `docs/MIGRATION.md` | **порядок переезда на другой хост**: бэкап → перенос → `bootstrap.sh` → DNS → приёмка → откат, с таблицей «симптом → причина → что делать» по каждому шагу | при изменении `backup.sh`/`bootstrap.sh`; откат описан явно, потому что старый хост до приёмки не выключается |
| `docs/HOSTING-CHECKLIST.md` | **требования к хосту перед оплатой**: 19 проверяемых пунктов (12 обязательных, 7 рекомендуемых), несовместимые конфигурации, готовый скрипт проверки | главный пункт — доступность **из России** (`check-host.net`, ≥ 2 из 3 узлов): переезд без неё не решает задачу, ради которой затеян |
| `docs/STAGE-PORTABILITY.md` | **что доказано и что не проверено** в переносимости: таблица замеров `npm ci` (без swap → `code 137`, 1 ГБ → `code 137`, 2 ГБ → `RC=0`, `skip` → `RC=0`), четыре расхождения директивы с фактом | документ честности: прямо перечисляет непроверенное (полный прогон на чистой ОС, TLS, `--restore`), чтобы «скрипты готовы» не читалось как «переезд проверен» |
| `docs/PROJECT-MEMORY.md` | сводка по всем сессиям | по запросу |
| `docs/PROJECT-REPORT-2026-11-07.md` | **полный сводный отчёт**: идея, архитектура, карта кода, экономика, живой срез 18:25, что работает и чего нет | снимок; устаревает → заменяется датированным отчётом, а не правится |

**Правило одного источника:** факт о том, что работает, живёт в `MANIFEST`;
дата и причина — в `PROJECT-HISTORY`; расположение — здесь. Дублирование факта
в двух местах означает, что одно из них протухнет.

### 11.1. Раскладка папок (с 05.11.2026)

В корне `backend-api/` — **пять канонических документов и `README.md`**.
Всё остальное — в `docs/`. Перенос сделан 05.11.2026 (`git mv`, история сохранена);
`MASTER-PLAN.md` добавлен 09.11.2026 как пятый канонический.

| Где | Что |
| :--- | :--- |
| корень `backend-api/` | `MANIFEST.v3.4-UNIFIED.md`, `PROJECT-HISTORY.md`, `PROJECT-MAP.md`, `ROADMAP.md`, `MASTER-PLAN.md`, `README.md` |
| `docs/` — отчёты и планы | `docs/BACKLOG.md`, `docs/PLAN-WAVE2.md`, `docs/PLAN-AGENT-RUNTIME.md`, `docs/LEGAL-DISTILLATION-PIPELINE.md`, `docs/V2.17.*-REPORT.md`, `docs/V2.17.13-REPORT.md`, `docs/REALITY-CHECK-v2.17.7.md`, `docs/REALITY-CHECK-v3.md` |
| `docs/` — инвестору и демо | `docs/ONE-PAGER.md`, `docs/PITCH-DECK.md`, `docs/DEMO-SCRIPT.md`, `docs/DEMO-RUNBOOK.md`, `docs/EMAIL-TEMPLATE.md`, `docs/AUDIT-REALITY.md` |
| `docs/` — контракты и решения | `docs/NETWORK-CONTRACT-v1.md`, `docs/BYOK-PRICING.md`, `docs/PII-DECISION.md`, `docs/VISION-8-COMPONENTS.md`, `docs/PROJECT-MEMORY.md` |

**Корень workspace** (на уровень выше, вне git) держит **симлинки** на публичные документы.
Копий намеренно нет: копии разъезжались молча (29.10 `EMAIL-TEMPLATE` в корне был 8080 б
против 9207 в `docs/`). Проверяет `scripts/verify.sh` → шаг 3.8.

Шаг 3.8 проверяет **11 симлинков**, а не 7, как было до 09.11.2026: `ROADMAP.md`,
`PROJECT-MAP.md` и `PROJECT-MEMORY.md` симлинками были, но в список не входили —
гейт показывал «7/7», хотя три документа могли молча стать копиями.

**Ссылки внутри документов указывают путь от `backend-api/`**, то есть на перемещённое —
через `docs/`: `docs/BACKLOG.md`, `docs/DEMO-RUNBOOK.md`. Голое имя теперь означает файл в корне.

### 11.2. Репозиторий на GitHub — **private** с 08.11.2026

| Факт | Значение |
| :--- | :--- |
| Слаг | `pdkiller666/tarnet-backend` |
| Видимость | **private** (было public 22.10–08.11, переключено по указанию владельца) |
| Ветка | `main`, HEAD сверяется с локальным при каждом деплое |
| Креденшелы | `$HOME/.openclaw/credentials/github/personal/*/hosts.yml`, override — `TARNET_GH_CREDS` |
| Токен в env (`$GH_TOKEN`, `$GITHUB_TOKEN`) | **не использовать**: `$GH_TOKEN` мёртв (`401`), `$GITHUB_TOKEN` пуст. Деплой их не читает |

**Как потребители ходят в GitHub теперь:**

| Потребитель | Путь |
| :--- | :--- |
| `scripts/deploy.sh` | пуш и `ls-remote` по `https://x-access-token:<TOKEN>@…` |
| Код на VPS | **bundle по SSH**, GitHub со стороны сервера не участвует |
| `scripts/verify.sh:128` | `git ls-remote` с токеном |
| `scripts/push-tag.js:60` | URL с токеном |

⚠️ **Анонимный `curl` на `raw.githubusercontent.com` больше не работает** — отдаёт `404`.
Если такой шаг появится в скрипте, диагностировать как «нет доступа», а не «нет файла».
Pages/Actions/webhooks/releases — не используются (проверено 08.11: 0 и 404).

---

## 12. Куда НЕ идти

| Путь | Почему |
| :--- | :--- |
| ~~`archive/python-app/crypto.py`~~ | ⚠️ **Файла не существует.** Каталога `archive/python-app/` в репозитории нет (в `archive/` только `lottery-tests/`), `find -name crypto.py` → 0. Историческая запись: `sign_message()` на SHA-256 — хеш-заглушка, не Ed25519. Текущие подписи — Ed25519 |
| `archive/lottery-tests/` | Отозванная механика лотерей |
| `node_modules/` | Не читать, не грепать при аудите |
| `../archive/MANIFEST.md` (v3.1), `../archive/MANIFEST.v3.3.md` | Помечены «устарело», перенесены в `archive/` 2026-11-05. Побеждает v3.4-UNIFIED. В корне workspace остался только канон |
| `.model-cache/` | Модели ONNX; на проде отсутствует |
