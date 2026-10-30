# REALITY-CHECK v2.17.7 — сверка PDF-манифестов с кодом

**Срез:** prod VPS `v1107336.hosted-by-vdsina.com`, build `2.17.6-pii-confirm`, снято **2026-10-30 19:10 MSK** (HEAD `4ffcf79`).
**Предмет:** два PDF от Gemini — «TarNet: История эволюции и полная спецификация» и «TarNet / Synapse: Полная выжимка (v3.4-UNIFIED)».
**Метод:** живой срез эндпоинтов **на прод-сервере** (`curl http://127.0.0.1:3001/...` по SSH) + `grep` по коду. Код не менялся.
**Кредо:** PDF — не истина. Код — истина.

> **О состоянии стенда.** Все числа в §1 и §4 сняты с боевой БД `/var/lib/tarnet/tarnet.db` на VPS и помечены `[prod]`. Предыдущая редакция этого отчёта снималась с локальной копии после `seed.js` и содержала нули (`work_receipts = 0`, `balances = 5`, `nodes = 3`) — эта редакция их не содержит, потому что нули были артефактом пустой песочницы, а не состоянием продукта.
>
> **Одно расхождение с директивой:** она ожидала `balances = 162`. Фактически на проде `balances = 219` (проверено `node:sqlite`, см. §1.6). В отчёте стоит живое число, а не ожидаемое.

---

## 1. Живой срез прода (дословно)

Процесс на VPS: `⚙️ Reward mode: hybrid | no randomness in payouts`, `📐 CWU κ: {"nano":0.1,"base":1,"expert":4} | fee φ=0.05 (burn 0.025, treasury 0.025)`, `🏔️ Emission: E0=50 TAR/epoch, continuous decay 2^(-epoch/365)`.

### 1.1 `GET /health` (200 OK, прод)

```json
{
  "status":"ok","version":"2.1.0-dpouw","buildVersion":"2.17.6-pii-confirm",
  "rewardMode":"hybrid","signatureAlg":"ed25519",
  "priceFloor":{"usdPer1MTokens":0.2,"usdPerTar":20,"protocolFeeRate":0.05,"burnRate":0.025,"treasuryRate":0.025,"loraRoyaltyRate":0.05},
  "tierWeights":{"nano":0.1,"base":1,"expert":4},
  "llm_mode":"deterministic_fallback","llm_mode_reason":"no_workers","external_provider":null,
  "active_workers":0,
  "worker_active_window_ms":60000,"worker_task_ttl_ms":150000,
  "pii_blocked_today":0,
  "pii_classifier":{"enabled":false,"ready":false,"modelId":"Xenova/bert-base-NER",
    "cacheDir":"/opt/tarnet/backend-api/.model-cache","perThreshold":0.5,"minFreeMb":900,
    "loadError":null,"minConfidence":0.95,
    "note":"structured regex only: ONNX NER not loaded (TARNET_PII_ONNX=1 enables it)"},
  "conservation":{"gross":89.559498,"distributed":89.559498,"delta":0,"holds":true,"reservedTar":0,"inconsistentRows":0},
  "conservationTier6":{"calls":12,"gross":0.006,"distributed":0.006,"delta":0,"holds":true,
    "inconsistentRows":0,"fundedByClient":12,"fundedByEmission":0},
  "faucetEmission":{"claims":9,"totalTar":0.09,"emission":true,"note":"разовые выдачи на адрес, не заработок"},
  "treasuryBalanceTar":0.1978,
  "onchain":{"simulated":true,"note":"No blockchain integration","settlements":17},
  "treasury":{"balanceTar":0.1978,"reserveUsdc":0,"lastOracleRate":null,"lastOracleUpdate":null,
    "monthlyOpexUsd":517,"reserveStatus":"critical"},
  "epoch":{"index":374,"emissionTar":24.576348,"releasedTar":17.924413,"distributedTar":4.776986,
    "unclaimedTar":13.147427,"halvingPeriodEpochs":365,"durationSec":86400},
  "gateway":{"address":"0x6b36d38081c440f93b7b910937b0f3737867b6d4"}
}
```

### 1.2 `GET /summary` (200 OK, прод)

```json
{"receipts":759,"workers":91,"totalCwu":754299699,"totalRewardTar":89.168922,
 "totalFeeRewardTar":7.152436,"totalFeeGrossTar":7.543012,"totalBlockRewardTar":82.016486,
 "totalBurnedTar":0.188638,"totalBurnedTier6Tar":0.0024,"totalTreasuryTar":0.188638,
 "totalLoraRoyaltyTar":0.0133,"totalUtilizedTar":0.00001,"totalUtilizedCount":1,
 "burnAddressBalanceTar":0.191038,"treasuryBalanceTar":0.1978,
 "burnAudit":{"workReceiptsTar":0.188638,"tier6Tar":0.0024,"accountedTar":0.191038,
   "addressBalanceTar":0.191038,"delta":0,"holds":true},
 "treasuryAudit":{"workReceiptsTar":0.188638,"tier6Tar":0.0024,"accruedTar":0.191038,
   "selfPayoutTar":0.006762,"cashbackOutTar":0,"cashbackOutRows":0,
   "expectedBalanceTar":0.1978,"actualBalanceTar":0.1978,"delta":0,"holds":true},
 "onchainSettlements":17,"onchain":{"simulated":true,"note":"No blockchain integration"},
 "receiptsByTier":[
   {"tier":"base","receipts":717,"cwu":558025396,"reward":75.973335,"fee":5.301127,"block":70.672208,"burn":0.13957},
   {"tier":"expert","receipts":31,"cwu":192000204,"reward":9.897742,"fee":1.810702,"block":8.08704,"burn":0.048},
   {"tier":"nano","receipts":11,"cwu":4274099,"reward":3.297845,"fee":0.040607,"block":3.257238,"burn":0.001068}],
 "conservation":{"gross":89.559498,"distributed":89.559498,"delta":0,"holds":true,"reservedTar":0}}
```

Сходимость руками (не на слово):
`75.973335 + 9.897742 + 3.297845 = 89.168922` = `totalRewardTar` ✅
`89.168922 + 0.188638 (burn) + 0.188638 (treasury) + 0.0133 (LoRA) = 89.559498` = `conservation.gross` ✅

### 1.3 `GET /models` (200 OK, прод)

```json
{"count":18,"models":[3 локальных tier 1–2, 15 внешних tier 6]}
```

### 1.4 `GET /p2p/status` (200 OK, прод)

```json
{"ok":true,"transport":"websocket","listenHost":"127.0.0.1","publicUrl":"ws://127.0.0.1:4001",
 "announced_public":false,
 "routeNodes":["0x2491ab72…","0xabe139a7…","0x3281abaf…"],
 "nodes":[{"role":"relay1"},{"role":"relay2"},{"role":"worker"}],
 "registry":{"total":0,"nodes":[],"has_public_nodes":false}}
```

Все три узла — `ws://127.0.0.1:*` (демо-меш `p2p-demo.js`), все счётчики `framesIn/framesOut/requests` = 0. Публичного узла нет.

### 1.5 `GET /worker/status` (200 OK, прод)

```json
{"active_workers":0,"pending_tasks":0,"mode":"deterministic_fallback","mode_reason":"no_workers","workers":[]}
```

### 1.6 Таблицы боевой БД `[prod]`

`sqlite3` на VPS не установлен, поэтому счёт через `node:sqlite` (`scripts/sqlite-tool.js` того же назначения):

| Таблица | Строк `[prod]` |
|---|---|
| `work_receipts` | **759** |
| `balances` | **219** |
| `nodes` | **147** |
| `tar_id` | **16** |
| `tier6_receipts` | **12** |

### 1.7 Сводка полей

| Поле | Значение `[prod]` | Источник |
|---|---|---|
| `buildVersion` | **`2.17.6-pii-confirm`** (не 2.17.7) | `/health` |
| тесты | **987 + 25 + 12 = 1024** ✅ / 0 ❌ | прогон трёх suite, §2.3 |
| чеков | **759** | `/summary.receipts` |
| выплачено | **89.168922 TAR** | `/summary.totalRewardTar` |
| воркеров (исторически) | **91** | `/summary.workers` |
| CWU всего | **754 299 699** | `/summary.totalCwu` |
| чеков по тирам | base **717** / expert **31** / nano **11** | `/summary.receiptsByTier` |
| Fee / Block | **7.543012** (8.42%) / **82.016486** (91.58%) TAR | `/summary` |
| `tier6_calls` | **12** (все `fundedByClient`) | `/health.conservationTier6` |
| `delta` (все 4 аудита) | **0**, `holds: true` | `/health`, `/summary` |
| эмиссия эпохи 374 | начислено **24.576348**, выдано **17.924413**, распределено **4.776986**, не получено **13.147427** | `/health.epoch` |
| казна | **0.1978 TAR**, `reserveUsdc: 0`, `reserveStatus: critical`, OPEX **$517/мес** | `/health.treasury` |
| faucet | **9** выдач, **0.09 TAR** | `/health.faucetEmission` |
| on-chain | `simulated: true`, `settlements: 17` | `/health.onchain` |
| `active_workers` | **0** | `/health`, `/worker/status` |
| `llm_mode` | **`deterministic_fallback`** (`no_workers`) | `/health` |
| `pii_classifier` | **`enabled: false` / `ready: false`** | `/health` |
| `registry.total` | **0** (при 147 строках в `nodes`) | `/p2p/status` |
| `announced_public` | **`false`** | `/p2p/status` |

> Про OPEX: `RESERVE_OPEX_USD=517` приходит из systemd drop-in `opex.conf`, а не из `config.js` (там дефолт `0`, `config.js:163`). На проде переменная выставлена — поэтому `monthlyOpexUsd: 517` и `reserveStatus: critical` при резерве `0`.

---

## 2. Семь обязательных правок

| # | PDF говорит | Код делает | Вердикт |
|---|---|---|---|
| 2.1 | `$TAR / $GRID`, «в техническом коде используется `$GRID`» | `$GRID` в коде **0 вхождений** | 🔴 расхождение |
| 2.2 | «`delta === θ` — инвариант леджера» | `θ` — **0**; но `delta === 0` реально проверяется | ⚠️ частично |
| 2.3 | «1005 автотестов» | **1024** (987+25+12) | 🔴 расхождение |
| 2.4 | «TarNet ID через Seed/Passkey с WebRTC-синхронизацией» | Passkey **0**, WebRTC **0**; ID = `/id/register` + Ed25519 | 🔴 расхождение |
| 2.5 | «Cross-Compute через пулы ключей Tier 6 других пользователей» | пул ключей **не читается**; Cross-Compute — виджет ROI | 🔴 расхождение |
| 2.6 | «установщики для Windows и macOS» (Linux не заявлен) | Linux-ветка в `install.command.tpl` есть, но частичная | ⚠️ частично |
| 2.7 | «PII confidence >= 0.95» как работающий гейт | порог `0.95` в коде есть; NER **не загружен** (`ready:false`) | ⚠️ частично |

### 2.1 `$GRID` / `$TAR` — 🔴

```
grep -rn "GRID\|Swarm-Grid\|swarm-grid" config.js ledger.js server.js app/app.js  → нет строк
grep -rc "GRID" config.js ledger.js                                             → config.js:0  ledger.js:0
grep -rn "GRID" --include=*.js --include=*.html . (без node_modules)             → 0
grep -c "TAR" config.js                                                         → 24
```

**Есть:** только `$TAR` (24 вхождения в `config.js`).
**Нет:** `$GRID`, `Swarm-Grid`, `swarm-grid` — ноль вхождений во всём репозитории, включая HTML.
**Вывод:** утверждение «в техническом коде и смарт-контрактах используется $GRID» ложно. В коде **только TAR**. Смарт-контрактов в репозитории нет вообще (`onchain.simulated: true`, `settlements: 17` — симуляция).

### 2.2 `delta === θ` / `delta === 0` — ⚠️

```
grep -c "θ" ledger.js config.js server.js   → 0 : 0 : 0
server.js:2713  delta: Number((distributed - gross).toFixed(6))
server.js:5598  delta: Number((distributed - gross).toFixed(6))
server.js:6501  delta: round((cashback + burnTar + treasuryTar) - fee)
```

**Нет:** символа `θ` в коде ноль. Формулировка PDF «`delta === θ`» не подтверждается и, вероятно, опечатка/артефакт генерации.
**Есть:** инвариант `delta === 0` реализован по-настоящему и проверяется в четырёх местах: `conservation` (работа), `conservationTier6` (внешние вызовы), `burnAudit`, `treasuryAudit`. На проде все четыре: `"delta":0,"holds":true`.
**Вывод:** механика — да, запись `θ` — нет. В PDF заменить `delta === θ` на `delta === 0`.

### 2.3 Тесты — 1005 vs 1024 — 🔴

```
node test-dpouw.js --test   → Итого: 987 ✅   0 ❌   (EXIT 0)
node test-mesh.js           → Итого: 25 ✅ / 0 ❌    (EXIT 0)
node proof-treasury-gate.js → Итого: 12 ✅   0 ❌    (EXIT 0)
```

**Сумма: 987 + 25 + 12 = 1024**, все зелёные, все три процесса завершились с кодом 0 (прогон 2026-10-30 19:12 MSK).
**Вывод:** PDF занижает на 19 тестов. Правильное число — **1024**, не 1005.

### 2.4 Seed / Passkey / WebRTC — 🔴

```
grep -rc "Passkey" server.js app/app.js app/index.html            → 0
grep -rc "WebRTC\|RTCPeerConnection" server.js app/app.js app/index.html → 0
grep -rn "Seed" app/ server.js   → только app/agents.js: hkdfSeed / importSeed (HKDF для ключей агента)
grep -n "id/register\|ed25519\|generateKey" server.js app/app.js
  server.js:3312  app.post('/id/register', ...)
  server.js:118   crypto.generateKeyPairSync('ed25519')
  app/app.js:95   crypto.subtle.generateKey({name:'Ed25519'}, ...)
```

**Чего нет:** Passkey — 0, WebRTC — 0, `RTCPeerConnection` — 0. P2P-синхронизации чатов по WebRTC нет.
**Что есть на самом деле:** TarNet ID = `POST /id/register` + ключ Ed25519 (генерируется в браузере через WebCrypto и в сервисе через `node:crypto`). «Seed» в коде — это HKDF-зерно для деривации ключей агента в `app/agents.js`, а не пользовательская seed-фраза и не Passkey. На проде в `tar_id` — **16** записей.
**Вывод:** «TarNet ID (через Seed/Passkey с P2P-синхронизацией чатов по WebRTC)» — ложь на 3/3. Правильно: «TarNet ID — регистрация Ed25519-ключа через `/id/register`».

### 2.5 Cross-Compute через пулы ключей — 🔴

```
grep -rn "pool" config.js server.js
  server.js:694  CREATE INDEX idx_user_keys_pool ON user_keys (isAvailableForNetwork, provider)
  server.js:1849-1863  pool = nodes для routing (не ключи)
grep -rn "isAvailableForNetwork" server.js → только DDL таблицы (строки 690, 694), чтения нет
grep -rni "cross-compute" server.js → server.js:2915  app.get('/cross-compute/:address')
```

**Чего нет:** пула ключей как механизма. Таблица `user_keys` с колонкой `isAvailableForNetwork` и индексом `idx_user_keys_pool` **создана**, но ни одна строка кода её не читает — нет ни одного `SELECT ... FROM user_keys ... WHERE isAvailableForNetwork = 1`.
**Что есть на самом деле:** `GET /cross-compute/:address` считает по **одному** адресу: `earnedTar` из `work_receipts`, `spentTar` из `tier6_calls` + `ledger_txs`, `netTar` = разность. Это ROI-виджет, а не обмен токенов на чужие ключи.
**Вывод:** PDF выдаёт DDL-заготовку и виджет за работающий пул. Это 🔴.

### 2.6 Linux-установщик — ⚠️

```
ls install/  → install.bat.tpl (Windows), install.command.tpl (macOS / Linux)
install/install.command.tpl:3    # TarNet Worker — установка в один клик (macOS / Linux)
install/install.command.tpl:80   Linux) OS=linux ;;
install/install.command.tpl:140  "Linux: автоматическая установка не поддерживается, ставлю вручную"
install.bat.tpl  → Linux: 0 вхождений
```

**Что есть:** два шаблона — `.bat.tpl` (Windows) и `.command.tpl` (macOS/Linux). В `.command.tpl` Linux реально поддержан для скачивания portable Node.js (`node-$NODEV-linux-$ARCH`), но автоустановка Ollama на Linux **не поддерживается** — скрипт предлагает ручной `curl ... | sh`.
**Вывод:** PDF говорит «Windows и macOS» — это не ложь, но **неполно**: Linux покрыт частично. Статус ⚠️. Формулировка для PDF: «установщики в 1 клик для Windows и macOS; Linux — частично (Node.js автоматически, Ollama вручную)».

### 2.7 PII confidence >= 0.95 — ⚠️

```
/health.pii_classifier → {"enabled":false,"ready":false,"minConfidence":0.95,
                          "note":"structured regex only: ONNX NER not loaded"}
llm-adapter.js:33       const TIER6_MIN_CONFIDENCE = 0.95;
pii-classifier.js:41    const TIER6_MIN_CONFIDENCE = 0.95;
pii-classifier.js:225   let confidence = structured.clean ? 1 : 0;   // бинарно, 1 или 0
server.js:6187          const pii = LLM.piiCheck(prompt);
server.js:6195          required_confidence: LLM.TIER6_MIN_CONFIDENCE
```

**Что есть:** порог `0.95` в коде на месте, гейт реально вызывается в `/inference` перед внешним вызовом, при провале — блок. На проде `pii_blocked_today: 0`.
**Чего нет:** ONNX NER не загружен (`ready: false`, `enabled: false`). Классификатор работает **только на структурированных regex-паттернах**, и тогда `confidence` бинарна: `1` (чисто) или `0` (совпало). То есть «confidence >= 0.95» технически достигается только как `1.0`, а «уверенность модели» в смысле NER — не измеряется.
**Вывод:** порог в коде есть, NER нет. PDF не договаривает: гейт работает на regex, а не на NER-модели. Статус ⚠️.

---

## 3. Пять пометок `[SPEC / ROADMAP]`

| # | Утверждение PDF | Код | Вердикт |
|---|---|---|---|
| 3.1 | Tier 1 Nano: мобильные устройства, «работает только на зарядке» | `battery`/`charging` → **0** во всех JS | 🔴 только документ |
| 3.2 | Tier 3 Heavy: GPU-фермы, валидаторы Benchmark Gate | механизм комитета **есть**; узлов expert/heavy — **0** | ⚠️ код есть, сети нет |
| 3.3 | Tier 5 Cloud Anchor, лимит 30% трафика | `cloudAnchor`/`TIER_5`/`MAX_ASN` → **0** | 🔴 только документ |
| 3.4 | Tier 4 DAG Planner (декомпозиция задач) | `planner`/`decompose` → **0** | 🔴 только документ |
| 3.5 | Semantic DHT-роутинг | `DHT`/`kademlia` → **0** | 🔴 только документ |

### 3.1 Tier 1 Nano — 🔴

```
grep -rc "battery\|charging" worker-demo.js server.js config.js app/app.js → 0 : 0 : 0 : 0
grep -rn "nano\|Nano" worker-demo.js server.js config.js
  config.js:8      nano: 0.1   // смартфон/планшет: relay + nano inference
  config.js:14     nano: 'nano', relay: 'nano', nano_relay: 'nano'
  server.js:4200   NODE_TIERS = ['nano','base','expert','heavy']
```

**Есть:** `nano` как вес κ = 0.1 и как класс железа узла, и **11 живых чеков** tier nano `[prod]` — то есть тир реально считает работу.
**Нет:** мобильного воркера, политики батареи/зарядки — ноль вхождений `battery`/`charging`. Мобильного клиента как воркера в коде нет.
**Вывод:** «работает только на зарядке» — чистая спека. Помета `[SPEC]` уместна.

### 3.2 Tier 3 Heavy / валидаторы — ⚠️

```
knowledge-loop.js:255  const VALIDATOR_STAKE_LOCK_TAR = 10;
knowledge-loop.js:257  const REQUIRED_COMMITTEE_SIZE = 5;
knowledge-loop.js:266  const MIN_VALIDATOR_STAKE_TAR = 10;
knowledge-loop.js:390  детерминированно выбирает REQUIRED_COMMITTEE_SIZE валидаторов
knowledge-loop.js:438  throw INSUFFICIENT_VALIDATORS: have N, need 5
server.js:4127-4139    committeeResult = benchmarkGate.selectCommittee(epochHash, nodes); verifyAdapter(...)
server.js:4293         validatorEligible: ['expert','heavy'].includes(finalTier)
```

**Есть:** механизм Benchmark Gate с комитетом реализован целиком: константы, детерминированный выбор, таблицы `benchmark_runs` (UNIQUE по `adapterHash, validatorId`), отказ `INSUFFICIENT_VALIDATORS`.
**Чего нет:** валидаторов. Комиссии не набирается: нужно **5** при `VALIDATOR_STAKE_LOCK_TAR = 10` → **50 TAR** застейканных, чего в сети нет. `benchmark_runs = 0`.
**Вывод:** код есть, сети нет. Формулировка для PDF: «Benchmark Gate реализован; комитет из 5 валидаторов в сети ни разу не набирался, новых Tier 3 узлов нет».

### 3.3 Tier 5 Cloud Anchor — 🔴

```
grep -rn "cloudAnchor\|CloudAnchor\|TIER_5\|Tier 5\|MAX_TIER5\|MAX_ASN\|MAX_BENEFICIARY" config.js server.js → 0
```

Ноль вхождений. Нет ни типа узла, ни лимита 30%, ни ASN-ограничения.
**Вывод:** только документ. `[SPEC]`.

### 3.4 DAG Planner — 🔴

```
grep -rci "planner\|decompose\|decomposition" server.js app/app.js → 0 : 0
```

**Осторожно, ловушка:** в репозитории есть `dag-chain.js`, но это **hash-chain для чеков** (монотонный `workerSeq`, `prevReceiptHash`, `cumulativeCwu/cumulativeTar`), а не планировщик задач. Разные «DAG».
**Вывод:** DAG-планировщика декомпозиции нет. `[SPEC]`. PDF не должен путать его с `dag-chain.js`.

### 3.5 Semantic DHT — 🔴

```
grep -rci "dht\|kademlia" server.js p2p-transport.js p2p-demo.js → 0 : 0 : 0
grep -rni "semantic.*rout" → 0
```

**Вывод:** семантического DHT-роутинга нет. Маршрутизация — onion через фиксированные relay-узлы (`routeNodes`, 3 хопа), и на проде `announced_public: false`, `registry.total: 0`.
**Вывод:** `[SPEC]`.

---

## 4. Экономика — что реально `[prod]`

| Показатель | Значение `[prod]` | Как считается |
|---|---|---|
| Комиссия протокола | **5%** (`protocolFeeRate: 0.05`) | `config.js:104` |
| Burn | **2.5%** | `config.js:105` |
| Treasury | **2.5%** | `config.js:106` |
| Льготная ставка (TAR_UTILITY) | **2%** (1% burn + 1% treasury) | `config.js:132-134` |
| Эмиссия эпохи E₀ | **50 TAR**, халвинг 365 эпох | `config.js:120-122` |
| `totalUtilizedTar` | **0.00001** (1 операция) | `/summary` |
| Казна | **0.1978 TAR**, `reserveStatus: critical`, OPEX **$517/мес** | `/health.treasury` |

**Доли Fee / Block теперь считаются по живым данным, а не по документации:**

```
totalFeeGrossTar     =  7.543012   →  7.543012 / 89.559498 = 8.42 %
totalBlockRewardTar  = 82.016486   → 82.016486 / 89.559498 = 91.58 %
conservation.gross   = 89.559498   (сумма сходится ровно)
```

Это те же `8.42% / 91.58%`, что в `PROJECT-HISTORY.md:555` и `docs/PITCH-DECK.md:267` — **теперь подтверждены живьём**, а не пересказаны.

**Казна против расходов:** `0.1978 TAR` при `USD_PER_TAR = 20` ≈ **$3.96** против `$517/мес` OPEX. Отсюда `reserveStatus: critical` — это не баг, а честная оценка: резерв покрывает 0.77% месячных расходов.

**Вывод:** PDF не упоминает соотношение 8.42% / 91.58% — добавить стоит, и теперь это можно делать без оговорок про «требует перезамера».

---

## 5. Что PDF описывает верно

| # | Утверждение | Доказательство | Вердикт |
|---|---|---|---|
| 5.1 | Бэкенд на Node.js + SQLite | `package.json` `"main":"server.js"`, зависимости express/ws/node:sqlite; `server.js:234 new DatabaseSync(DB_PATH)` | ✅ подтверждено |
| 5.2 | Отказ от лотерей, dPoUW | `grep -c "lottery\|faceValueTar" config.js server.js` → **0 : 0** | ✅ подтверждено |
| 5.3 | Чеки подписаны Ed25519 | `grep -c "ed25519\|Ed25519" server.js ledger.js` → **15**; `/health.signatureAlg: "ed25519"` | ✅ подтверждено `[prod]` |
| 5.4 | WebSocket Inbound-Multiplexing | `server.js:46 createWsInbound`; лог `🔌 Worker WS inbound: ws://<host>:3001/p2p/worker` | ✅ подтверждено `[prod]` |
| 5.5 | Ed25519 handshake (challenge-response) | `ws-inbound.js:44 AUTH_PREFIX='TARNET_WS_AUTH'`; тесты 43.3–43.4 зелёные | ✅ подтверждено |
| 5.6 | Tier 6 BYOK | таблицы и `conservationTier6` есть, `delta 0`; **12 вызовов** `[prod]`, все `fundedByClient`; оплата **чужим** ключом — `501 [SPEC Phase 2.5]` | ⚠️ частично |
| 5.7 | PWA-клиент | `curl /app/` → **200**, 44764 B; `/index.html` → 200 | ✅ подтверждено |
| 5.8 | Бренд Synapse вычищен из PWA | `grep -c "Synapse" app/index.html ui/index.html ui/console.html` → **0 : 0 : 0** | ✅ подтверждено |
| 5.9 | TarNet = Tokenized AI Resource Network | `app/index.html:6 <title>TarNet — Tokenized AI Resource Network</title>` | ✅ подтверждено |

**Уточнение по 5.6.** Механизм Tier 6 реально работает: на проде **12 вызовов**, `gross 0.006`, `distributed 0.006`, `delta 0`, и все 12 — `fundedByClient`, ни одного за счёт эмиссии. Резерв `reserveTier6Fee` и консервация держатся. Чего нет: *оплата чужим ключом* (`paymentMethod: 'BYOK'`) отвечает `501 [SPEC Phase 2.5]` (`server.js:6107-6109`); принимается только ключ в заголовке `x-provider-key`. То есть «оркестрация по личным ключам пользователя» — пока приём собственного ключа, а не пул чужих.

---

## 6. Список для Gemini — точные формулировки

1. **`$GRID` (PDF 1 §1, PDF 2 §1).** Удалить «в техническом коде и смарт-контрактах используется `$GRID`».
   → «Расчётная единица в коде — **`TAR`** (`grep GRID` → 0 во всём репозитории). `$GRID` — историческое имя проекта; смарт-контрактов в репозитории нет, расчёты on-chain симулированы (`onchain.simulated: true`).»

2. **`delta === θ` (PDF 1 §2, PDF 2 §5).** Заменить везде `delta === θ` на **`delta === 0`**.
   → «Безгазовый DAG-леджер с инвариантом **`delta === 0`**, который проверяется в четырёх блоках: `conservation`, `conservationTier6`, `burnAudit`, `treasuryAudit` (`holds: true` на проде).»

3. **«1005 автотестов» (PDF 1 §7).** Заменить на **1024**.
   → «Кодовая база содержит **1024** успешно проходящих автотеста: `test-dpouw` 987, `test-mesh` 25, `proof-treasury-gate` 12; все с кодом выхода 0.»

4. **«TarNet ID через Seed/Passkey с WebRTC» (PDF 1 §6).** Удалить Passkey и WebRTC.
   → «TarNet ID — регистрация Ed25519-ключа: `POST /id/register`, ключ генерируется в браузере через WebCrypto. Passkey и WebRTC-синхронизация чатов **не реализованы** (`grep` → 0). В сети — 16 зарегистрированных ID.»

5. **«Cross-Compute через пулы ключей Tier 6 других пользователей» (PDF 1 §5).** Убрать «пулы ключей».
   → «Cross-Compute — виджет ROI по одному адресу (`GET /cross-compute/:address`): заработок из `work_receipts` минус траты из `tier6_calls` и `ledger_txs`. Обмен токенов на чужие ключи **не реализован**: таблица `user_keys.isAvailableForNetwork` создана, но не читается.»

6. **«Установщики для Windows и macOS» (PDF 1 §7, PDF 2).** Дополнить про Linux.
   → «Установщики в 1 клик: Windows (`.bat`) и macOS/Linux (`.command`). На Linux автоматически ставится portable Node.js, Ollama — вручную.»

7. **«PII confidence >= 0.95» (PDF 2 §3).** Добавить оговорку про NER.
   → «Порог `0.95` в коде есть (`TIER6_MIN_CONFIDENCE`). Гейт работает на **структурированных regex-паттернах**; ONNX NER **не загружен** (`pii_classifier.ready: false`), поэтому при чистом тексте `confidence = 1.0`, при совпадении — `0`.»

8. **Tier 1 Nano «только на зарядке» (оба PDF).** Пометить `[SPEC]`.
   → «Tier 1 Nano — `[SPEC]`: в коде есть только вес κ = 0.1 и класс узла `nano` (11 чеков на проде); мобильного воркера и политики батареи нет (`grep battery|charging` → 0).»

9. **Tier 3 Heavy / валидаторы (оба PDF).** Уточнить состояние сети.
   → «Benchmark Gate реализован (`REQUIRED_COMMITTEE_SIZE = 5`, `MIN_VALIDATOR_STAKE_TAR = 10` → 50 TAR застейканных), но комитет в сети ни разу не набрался (`INSUFFICIENT_VALIDATORS`), `benchmark_runs = 0`.»

10. **Tier 5 Cloud Anchor 30% (PDF 2 §2).** Пометить `[SPEC]`.
    → «Tier 5 Cloud Anchor и лимит 30% трафика — `[SPEC]`: `grep cloudAnchor|TIER_5|MAX_ASN` → 0.»

11. **DAG Planner (PDF 2 §2).** Пометить `[SPEC]`, не путать с `dag-chain.js`.
    → «DAG-планировщик декомпозиции — `[SPEC]`. Существующий `dag-chain.js` — это hash-chain чеков, а не планировщик задач.»

12. **Semantic DHT (PDF 1 §1).** Пометить `[SPEC]`.
    → «Семантический DHT-роутинг — `[SPEC]` (`grep dht|kademlia` → 0). Реальная маршрутизация — onion через 3 relay-хопа; публичного узла в сети нет (`announced_public: false`, `registry.total: 0`).»

13. **Экономика (оба PDF, §4/§5).** Добавить реальные доли и казну.
    → «Комиссия 5% = 2.5% burn + 2.5% treasury; при оплате TAR — 2% (1% + 1%). На проде: **8.42%** (`7.543012`) из комиссий против **91.58%** (`82.016486`) из блочной эмиссии, сумма `89.559498` TAR. Казна: **0.1978 TAR** ≈ `$3.96` при OPEX `$517/мес` → `reserveStatus: critical`.»

14. **Tier 6 «BYOK работает» (PDF 2 §2).** Уточнить.
    → «Tier 6: 12 вызовов на проде, `gross 0.006`, `delta === 0`, все `fundedByClient` — оплачены клиентом, не эмиссией. Оплата **чужим** ключом — `501 [SPEC Phase 2.5]`; принимается только ключ в заголовке `x-provider-key`.»

15. **Faucet (нет в PDF).** Добавить, если PDF описывает экономику целиком.
    → «Faucet: `POST /faucet/claim`, `0.01 TAR` один раз на адрес, лимит 3 на IP через HMAC-SHA256 `ipHash`. На проде 9 выдач, `0.09 TAR`. Учтён отдельно в `/health.faucetEmission`, не смешивается с `conservation.delta`.»

---

## 7. Поймал у себя

1. **Первая редакция отчёта снималась не с прода.** Она писалась на локальной копии после `seed.js`, где `work_receipts = 0`, и все «живые» числа были нулями. Нули — артефакт пустой песочницы, а не свойство продукта. Эта редакция снята с боевой БД и помечена `[prod]`; локальные нули удалены.

2. **Ожидание директивы `balances = 162` не совпало с фактом.** На проде **219** строк. Записано живое число; расхождение отмечено в шапке, чтобы его не приняли за опечатку.

3. **`buildVersion` — 2.17.6, а не 2.17.7.** Директива называется `v2.17.7-reality-check`, `/health` отдаёт `2.17.6-pii-confirm`. Версию кода не трогал: это docs-веха, а не релиз кода. Тег `v2.17.7-reality-sync` ставится на коммит документов, `buildVersion` меняется отдельно при следующей сборке.

4. **`sqlite3` на VPS отсутствует.** Директива предполагала `sqlite3 /var/lib/tarnet/tarnet.db "SELECT ..."` — команда даёт `command not found`. Счёт снят через `node:sqlite` (`scripts/sqlite-tool.js` сделан ровно для этого контейнера).

5. **`origin` на VPS — это бандл, а не GitHub.**
   ```
   origin  /tmp/tarnet-deploy.bundle (fetch/push)
   ```
   Поэтому предписанный `git fetch origin --tags --force` на проде не достал бы теги. Теги теперь едут внутри бандла (`git bundle create … --tags`) и отдельным refspec-ом на VPS (`+refs/tags/*:refs/tags/*`).

6. **`git ls-remote --tags | wc -l` считает вдвое больше.** На annotated-тег GitHub отдаёт две строки: `refs/tags/x` и `refs/tags/x^{}`. При 37 тегах команда печатает 70. Сравнивать надо с `grep -v '\^{}'`.

7. **`MEMORY.md` не входит в git-репозиторий.** Workspace-корень — не repo, `backend-api` — отдельный. Поэтому коммит содержит два файла из трёх, а правка памяти живёт как файл памяти.

---

## Приложение: где именно смотреть

| Факт | Команда / путь |
|---|---|
| `$GRID` = 0 | `grep -rn "GRID" --include=*.js --include=*.html . \| grep -v node_modules` |
| `delta === 0` | `server.js:2713, 2743, 5433, 5566, 5598, 6501` |
| 1024 теста | `node test-dpouw.js --test` / `test-mesh.js` / `proof-treasury-gate.js` |
| Passkey/WebRTC = 0 | `grep -rc "Passkey\|WebRTC\|RTCPeerConnection" server.js app/` |
| пул ключей не читается | `grep -n "user_keys" server.js` — только DDL (683–694) |
| Linux в установщике | `install/install.command.tpl:3, 80, 140` |
| PII NER не загружен | `/health.pii_classifier.ready: false` |
| батарея = 0 | `grep -rc "battery\|charging" worker-demo.js server.js config.js app/app.js` |
| комитет валидаторов | `knowledge-loop.js:255-266, 390-455` |
| DAG planner = 0 | `grep -rci "planner\|decompose\|decomposition" server.js app/app.js` |
| DHT = 0 | `grep -rci "dht\|kademlia" server.js p2p-transport.js p2p-demo.js` |
| экономика 8.42/91.58 | `/summary` (`totalFeeGrossTar` / `totalBlockRewardTar`), `PROJECT-HISTORY.md:555` |
| счёт таблиц прода | `node -e "…DatabaseSync('/var/lib/tarnet/tarnet.db')…"` на VPS |
