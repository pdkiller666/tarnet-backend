# PRE-FLIGHT RECON (срез перед конституционной директивой)

**Дата:** 15.11.2026, 10:08–10:20 MSK
**Версия прода:** `buildVersion: 2.29.13`, схема леджера `2.1.0-dpouw`
**Источник базового URL:** `scripts/verify.sh:45` → `PUBLIC_URL="${TARNET_PUBLIC_URL:-https://v1107336.hosted-by-vdsina.com}"`, переменная `TARNET_PUBLIC_URL` в окружении не задана. Тот же адрес подтверждён ответом (`server: Caddy`, `x-powered-by: Express`) и `scripts/deploy.sh:54`.
**Режим работы:** только чтение. Ни одного файла репозитория не изменено; создан только этот документ. Не коммичен.

---

## 0. Начальное состояние

```
$ pwd
/home/node/.openclaw/workspace-main/backend-api

$ git status --porcelain
(пусто)
```

Дерево чистое, грязных файлов нет.

---

## 1. Живой срез прода

### 1.1 `GET /health` → 200

```json
{"status":"ok","timestamp":1794726482358,"database":"sqlite:///var/lib/tarnet/tarnet.db","databaseBytes":2433024,"version":"2.1.0-dpouw","buildVersion":"2.29.13","rewardMode":"hybrid","signatureAlg":"ed25519","priceFloor":{"usdPer1MTokens":0.2,"usdPerTar":20,"protocolFeeRate":0.05,"burnRate":0.025,"treasuryRate":0.025,"loraRoyaltyRate":0.05},"tierWeights":{"nano":0.1,"base":1,"expert":4},"p2p_capabilities_configured":false,"llm_mode":"deterministic_fallback","external_provider":null,"active_workers":0,"llm_mode_reason":"no_workers","active_p2p_workers":0,"p2p_worker_records":0,"p2p_model_families":[],"p2p_transport_known":true,"pii_blocked_today":0,"pii_classifier":{"enabled":false,"ready":false,"modelId":"Xenova/bert-base-NER","cacheDir":"/opt/tarnet/backend-api/.model-cache","perThreshold":0.5,"minFreeMb":900,"loadError":null,"minConfidence":0.95,"note":"structured regex only: ONNX NER not loaded (TARNET_PII_ONNX=1 enables it)"},"worker_task_ttl_ms":150000,"worker_active_window_ms":60000,"conservation":{"gross":176.872557,"distributed":176.872557,"delta":0,"holds":true,"reservedTar":0,"inconsistentRows":0},"conservationTier6":{"calls":17,"gross":0.0073,"distributed":0.0073,"delta":0,"holds":true,"inconsistentRows":0,"fundedByClient":17,"fundedByEmission":0},"faucetEmission":{"claims":11,"totalTar":0.11,"emission":true,"note":"разовые выдачи на адрес, не заработок"},"treasuryBalanceTar":0.1982,"committee":{"candidates":23,"eligible":1,"required":5,"drawn":0,"reason":"insufficient_stake"},"onchain":{"simulated":true,"note":"No blockchain integration","settlements":17},"cloudflared_processes":0,"treasury":{"balanceTar":0.1982,"reserveUsdc":0,"lastOracleRate":null,"lastOracleUpdate":null,"monthlyOpexUsd":517,"reserveStatus":"critical"},"epoch":{"index":390,"emissionTar":23.840838,"releasedTar":8.411168,"distributedTar":0,"unclaimedTar":8.411168,"halvingPeriodEpochs":365,"durationSec":86400},"gateway":{"address":"0x6b36d38081c440f93b7b910937b0f3737867b6d4","publicKeyPem":"-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAdNiGs6SLzjrFd6eS0vDNUQhtlm0b8jV+Tg/6l0KzuKc=\n-----END PUBLIC KEY-----\n"}}
```

Заголовки: `HTTP/2 200`, `server: Caddy`, `x-ratelimit-class: read`, `x-ratelimit-limit: 300`.

### 1.2 `GET /summary` → 200

```json
{"receipts":808,"workers":97,"active_p2p_workers":0,"p2p_worker_records":0,"p2p_model_families":[],"p2p_transport_known":true,"totalCwu":754304523,"totalRewardTar":176.481981,"totalFeeRewardTar":7.152497,"totalFeeGrossTar":7.543073,"totalBlockRewardTar":169.329484,"totalBurnedTar":0.188638,"totalBurnedTier6Tar":0.0028,"totalTreasuryTar":0.188638,"totalLoraRoyaltyTar":0.0133,"totalUtilizedTar":0.000012,"totalUtilizedCount":3,"burnAddressBalanceTar":0.191438,"treasuryBalanceTar":0.1982,"burnAudit":{"workReceiptsTar":0.188638,"tier6Tar":0.0028,"accountedTar":0.191438,"addressBalanceTar":0.191438,"delta":0,"holds":true},"treasuryAudit":{"workReceiptsTar":0.188638,"tier6Tar":0.0028,"accruedTar":0.191438,"selfPayoutTar":0.006762,"cashbackOutTar":0,"cashbackOutRows":0,"expectedBalanceTar":0.1982,"actualBalanceTar":0.1982,"delta":0,"holds":true},"onchainSettlements":17,"onchain":{"simulated":true,"note":"No blockchain integration"},"receiptsByTier":[{"tier":"base","receipts":766,"cwu":558030220,"reward":163.286394,"fee":5.301188,"block":157.985206,"burn":0.13957},{"tier":"expert","receipts":31,"cwu":192000204,"reward":9.897742000000001,"fee":1.810702,"block":8.08704,"burn":0.048},{"tier":"nano","receipts":11,"cwu":4274099,"reward":3.297845,"fee":0.040607,"block":3.257238,"burn":0.001068}],"conservation":{"gross":176.872557,"distributed":176.872557,"delta":0,"holds":true,"reservedTar":0}}
```

### 1.3 `GET /models` → 200

`count: 18`. Состав: 3 локальных (`deepseek-r1-distill-1.5b` tier 1, `qwen2.5-coder:1.5b` tier 1, `qwen2.5-coder-7b` tier 2), 15 внешних (tier 6): deepseek ×3, fireworks ×2, gigachat ×2, mistral ×2, openai/gpt-4o, openrouter/qwen3-coder, together ×2, yandex ×2.

### 1.4 `GET /p2p/status` → 200

```json
{"ok":true,"transport":"websocket","listenHost":"127.0.0.1","publicUrl":"ws://127.0.0.1:4101","announced_public":false,"routeNodes":["0x2491ab72f3cdfa132059df7e5cf08a0ea4c9fe25","0xabe139a759a3e77649eabc45fa5319e7085b2610","0x3281abaf01c3d746d09934b8e3a64344c0de3640"],...}
```

Ключевое из ответа:
- `announced_public: false`, `listenHost: 127.0.0.1` — наружу не анонсируется;
- `registry.total: 0`, `has_public_nodes: false` — реестр пуст;
- `bridge`: `ok: true`, `libp2p: "listening 0.0.0.0:4001"`, `connections: 1`, `connected_peers: ["12D3KooWHSRfkQtdfQSa88mbqsJPVPHgtvnMTww8SBwmUdAKNYss"]`, `worker_addresses: []`, `uptime_s: 45444`.

### 1.5 Сводка «что отдаёт прод»

| Метрика | Значение | Источник |
|---|---|---|
| версия | `2.29.13` | `/health.buildVersion` |
| схема | `2.1.0-dpouw` | `/health.version` |
| `rewardMode` | `hybrid` | `/health`, `/config` |
| `conservation.delta` | `0`, `holds: true` | `/health`, `/summary` |
| `conservationTier6.delta` | `0`, `holds: true` | `/health` |
| активных воркеров | `0` (`active_p2p_workers: 0`) | `/health` |
| чеков в базе | `808` | `/summary.receipts` |
| воркеров всего | `97` | `/summary.workers` |
| `totalCwu` | `754 304 523` | `/summary` |
| `totalRewardTar` | `176.481981` | `/summary` |
| из него fee / block | `7.152497` / `169.329484` | `/summary` |
| сожжено / казна | `0.188638` / `0.188638` | `/summary` |
| эпоха | `index 390`, `emissionTar 23.840838`, `releasedTar 8.411168`, `distributedTar 0` | `/health`, `/epoch` |
| Tier 6 | `calls 17`, `delta 0`, `fundedByEmission 0` | `/health` |
| faucet | `claims 11`, `0.11 TAR`, помечен `emission: true` | `/health` |
| комитет | `candidates 23`, `eligible 1`, `required 5`, `drawn 0`, `insufficient_stake` | `/health` |
| on-chain | `simulated: true`, `settlements 17` | `/summary` |
| казна USD-резерв | `monthlyOpexUsd 517`, `reserveStatus: critical` | `/health` |

### 1.6 Дополнительные живые маршруты (не в директиве, но существуют)

| Путь | Код | Что отдаёт |
|---|---|---|
| `/config` | 200 | константы: `usdPer1MTokens 0.2`, `usdPerTar 20`, `emission.initialBlockReward 50`, `halvingPeriodEpochs 365`, `genesisTs 1761000000000`, `minReceiptTokens 50`, `TIER6` |
| `/epoch` | 200 | `{"index":390,"emissionTar":23.840838,"releasedTar":8.48599,"distributedTar":0,"unclaimedTar":8.48599,"denominator":0}` |
| `/nodes` | 200 | список узлов со `stake`, `reputation`, `routingWeight` |
| `/settlements` | 200 | 17 записей, синтетический `txHash` |
| `/receipt/audit` | 200 | пустой чек `{"seq":0,"workerId":"audit","empty":true,"verified":true}` |
| `/receipts` | 404 | `Cannot GET /receipts` |
| `/stats` | 404 | — |
| `/treasury` | 404 | — |
| `/audit` | 404 | — |
| `/network` | 404 | — |

**Важно:** `/epoch.denominator = 0` — в текущей эпохе нет работы, поэтому накопленная эмиссия `8.48599` не распределена.

**Поправка (проверено 15.11 10:34–10:35 MSK).** Расхождение `releasedTar` между `/health` (`8.411168`) и `/epoch` (`8.48599`), замеченное выше, — **не дефект и не два источника одного числа**. `releasedTar` начисляется **непрерывно**, по секундам:

```
10:34:46  /health.epoch.releasedTar 8.853807   /epoch.releasedTar 8.853860
10:35:06  /health.epoch.releasedTar 8.859425   /epoch.releasedTar 8.859484
```

Прирост `0.005618` за 20 с = `0.000281` TAR/с; `emissionTar 23.840838 / 86400` = `0.000276` TAR/с — совпадает. Разница `6·10⁻⁵` между двумя маршрутами в одном прогоне = доли секунды между запросами. Первоначальные `0.0748` TAR = ≈271 с — это интервал между моими запросами, а не расхождение данных. Пункт 18 в §8 снят.

---

## 2. Структура репозитория

### 2.1 git

```
$ git log --oneline -10
f4e02f1 2.29.13: числа в документах стали проверяемыми, провенанс чеков — названным
60ea7de 2.29.12: версия в шапках MASTER-PLAN и MANIFEST стала проверяемой — шаг 3.10 в verify.sh
087121c 2.29.11: инструменты прогона Этапа 10, отсрочка по диску и два места, где директива разошлась с кодом
06ff8f2 2.29.10: сигналинг POST /p2p/signal и браузерный клиент Этапа 10
21c314a 2.29.9: GET /providers отдельным адресом, реестр собирается одной функцией
9708a76 2.29.8: пропуск в наборе перестал быть зелёным
3f4dcb0 docs 2.29.7: арифметика гейта исправлена, добавлена запись о раскатке
f7cf2e9 2.29.7: RAG доказан проверками — 46 новых, два дефекта исправлены
a121789 docs: разорвана петля «документы после деплоя» — sha HEAD не пиннится в шапках
60509b8 docs: 2.29.6 раскатан на прод — §Б.86, сверки и числа из вывода verify.sh

$ git describe --tags --always
v2.19.2-p0-p1-security-139-gf4e02f1
```

- ветка `main`, remote `https://github.com/pdkiller666/tarnet-backend.git`
- `package.json` → `"version": "2.29.13"`
- **последний тег:** `v2.19.2-p0-p1-security` (05.11.2026); **139 коммитов после него без тега**

Хвост списка тегов (`git tag --list | tail -20`):
```
v2.17.5-manifest-pii-contract   v2.17.6-pii-confirm
v2.17.7-reality-sync            v2.17.8-byok-pricing-b
v2.17.9-config-reality          v2.19.2-p0-p1-security
v2.2.0-p2p   v2.2.1-p2p-live    v2.3.0-identity
v2.4.0-pii   v2.4.1-production-ready  v2.4.1-tier-fix
v2.5.0-prep  v2.5.1-prep        v2.6.0-tier6-prep
v2.7.0-wave2-prep  v2.7.1-manifest-fix
v2.8.0-agent-foundation  v2.9.1-agent-ui  v2.9.2-agent-runtime-fix
```
(алфавитный хвост, не хронологический; хронологически последний — `v2.19.2-p0-p1-security`)

### 2.2 Верхний уровень `backend-api/`

```
MANIFEST.v3.4-UNIFIED.md   486 653 B   ← канон (в корне воркспейса — симлинк)
MASTER-PLAN.md              41 334 B   ← симлинк в корне
PROJECT-HISTORY.md         757 412 B   ← симлинк в корне
PROJECT-MAP.md              84 560 B   ← симлинк в корне
ROADMAP.md                 158 005 B   ← симлинк в корне
README.md                   20 928 B
server.js                  707 831 B
config.js                   31 637 B
economics.js                13 503 B
ledger.js                   16 721 B
dag-chain.js                 9 286 B
agent-runtime.js            37 965 B
llm-adapter.js              36 421 B
knowledge-loop.js           33 828 B
p2p-transport.js            28 178 B
ws-inbound.js               30 319 B
worker-demo.js             128 474 B
test-dpouw.js              761 143 B
test-knowledge.js           16 045 B
test-conversation.js        20 990 B
test-mesh.js                22 441 B
test-mesh-worker.js          2 626 B
tarnet.db                  565 248 B   ← ЛОКАЛЬНАЯ dev-копия от 09.11, не прод
package.json                   577 B
+ каталоги: app/ archive/ deploy/ dist/ docs/ install/ node_modules/ p2p-node/ scripts/ storage/ ui/
```

### 2.3 `docs/` (38 файлов)

`NARRATIVE.md` (41 947 B) · `AUDIT-REALITY.md` · `BACKLOG.md` · `BYOK-PRICING.md` · `DEMO-RUNBOOK.md` · `DEMO-SCRIPT.md` · `DISCOVERY.md` · `EMAIL-TEMPLATE.md` · `HOSTING-CHECKLIST.md` · `INVESTOR-CHECKLIST.md` · `LEGAL-DISTILLATION-PIPELINE.md` · `MIGRATION.md` · `MULTI-TURN-TEST.md` · `NAT-TEST.md` · `NAT-TEST-SHORT.md` · `NETWORK-CONTRACT-v1.md` · `ONE-PAGER.md` · `PII-DECISION.md` · `PITCH-DECK.md` · `PLAN-AGENT-RUNTIME.md` · `PLAN-WAVE2.md` · `PRE-NAT-STATUS.md` · `PROJECT-MEMORY.md` · `PROJECT-REPORT-2026-11-07.md` · `REALITY-CHECK-v3.md` · `REALITY-CHECK-v4.md` · `REALITY-CHECK-v2.17.7.md` · `REBOOT-TEST.md` · `STAGE-10-CHECKLIST.md` · `STAGE-10-WEBRTC.md` · `STAGE-PORTABILITY.md` · `V2.17.5-REPORT.md` · `V2.17.6-REPORT.md` · `V2.17.8-REPORT.md` · `V2.17.9-REPORT.md` · `V2.17.13-REPORT.md` · `VISION-8-COMPONENTS.md` · `WEBRTC-BROWSER-TEST.md`

### 2.4 `scripts/` (28 файлов)

`verify.sh` (45 012 B, исполняемый) · `deploy.sh` · `bootstrap.sh` · `ensure.sh` · `backup.sh` · `backup-tarnet-s3.sh` · `check-doc-numbers.js` · `check-multi-turn.js` · `check-webrtc.js` · `check-autostart.js` · `test-doc-numbers.js` · `test-p2p-e2e.js` · `test-seed-failover.js` · `test-discovery-e2e.js` · `webrtc-test.js` · `push-tag.js` · `push-github.sh` · `sqlite-tool.js` · `tarnet-guard.sh` · `tarnet-supervisor.sh` · `tarnet-tunnel.sh` · `tarnet-tunnel-watch.sh` · `authorize-peer.js` · `archive-transcripts.js` · `extract-session-summary.js` · `make-icons.js` · `migrate-legacy-jsonl.js` · `prune-archives.js` · `prune-distill.js` · `generate-backup-key.md`

### 2.5 Подтверждение путей из директивы

| Ожидание директивы | Факт | Вывод |
|---|---|---|
| `scripts/verify.sh` | `backend-api/scripts/verify.sh`, 45 012 B | **есть**, но путь от корня репо `backend-api`, в корне воркспейса нет |
| `docs/NARRATIVE.md` | `backend-api/docs/NARRATIVE.md`, 41 947 B | **есть**; в корне воркспейса симлинк `NARRATIVE.md` |
| `MANIFEST.v3.4-UNIFIED.md` | `backend-api/MANIFEST.v3.4-UNIFIED.md`, 486 653 B | **есть**; симлинк в корне |
| `MASTER-PLAN.md` | `backend-api/MASTER-PLAN.md`, 41 334 B | **есть**; симлинк в корне |
| `PROJECT-HISTORY.md` | `backend-api/PROJECT-HISTORY.md`, 757 412 B | **есть**; симлинк |
| `PROJECT-MAP.md` | `backend-api/PROJECT-MAP.md`, 84 560 B | **есть**; симлинк |
| `ROADMAP.md` | `backend-api/ROADMAP.md`, 158 005 B | **есть**; симлинк |
| `README.md` | `backend-api/README.md`, 20 928 B | **есть** |

### 2.6 Метки в `MANIFEST.v3.4-UNIFIED.md`

Фактические вхождения (grep по `\[SPEC`/`\[TESTNET`):

| Метка | Вхождений |
|---|---|
| `[SPEC / ROADMAP]` | 9 |
| `[SPEC]` | 8 |
| `[SPEC Фаза 2.5]` | 2 |
| `[SPEC Фаза 3]` | 1 |
| `[SPEC Phase 2.5]` | 1 |
| `[TESTNET-LIVE]` | **0** |
| `[SPEC-...]` (с дефисом) | **0** |

**Блока конституции в манифесте нет.** grep по `constitution|конституц` в `MANIFEST.v3.4-UNIFIED.md`, `MASTER-PLAN.md`, `config.js`, `economics.js` → 0 вхождений. Единственные упоминания слова «конституционные» во всём репо — две строки исторического описания ролей агентов в `PROJECT-HISTORY.md:1546-1547`.

---

## 3. Живые экономические константы

Все значения — из кода, не из спецификаций.

### 3.1 `config.js`

| Строка | Константа | Значение |
|---|---|---|
| 255 | `REWARD_MODE` | `'hybrid'` (варианты: `bootstrap` \| `demand` \| `hybrid`) |
| 260 | `PRICE_USD_PER_1M_TOKENS` | `0.20` |
| 270 | `USD_PER_TAR` | `20.0` |
| 309 | `INITIAL_BLOCK_REWARD` | `50` (E₀, TAR/эпоха) |
| 310 | `EPOCH_DURATION_SEC` | `86400` |
| 311 | `HALVING_PERIOD_EPOCHS` | `365` |
| 316 | `MAX_RECEIPT_SHARE_OF_EPOCH` | `0.25` |
| 324 | `MIN_RECEIPT_TOKENS` | `50` |
| 417 | `GENESIS_TS` | `1761000000000` |
| 6 | `TIER_WEIGHTS` | `{nano: 0.1, base: 1.0, expert: 4.0}` |
| 272-274 | `PROTOCOL_FEE_RATE` / `BURN_RATE` / `TREASURY_RATE` | `0.05` / `0.025` / `0.025` |
| 275 | `LORA_ROYALTY_RATE` | `0.05` |
| 314-315 | `TAR_UTILITY_BURN_RATE` / `TAR_UTILITY_TREASURY_RATE` | `0.01` / `0.01` |
| 50-52 | `TIER6.ORCHESTRATION_FEE_TAR` / `CASHBACK_TAR` | `0.0002` / `0.0001` |

### 3.2 κ (каппа) — фактические значения

```
config.js:6    // Тарифные веса κ_tier: сколько «полезной работы» даёт один токен по тиру.
config.js:259  // тир учитывается коэффициентом κ внутри CWU, а не отдельной ценой.
```
`TIER_WEIGHTS = { nano: 0.1, base: 1.0, expert: 4.0 }`. Отдельной скалярной константы `KAPPA` нет — κ задаётся таблицей по тиру.

### 3.3 Формула `Block_Share` — как в коде

```js
// economics.js:175-190
static blockStream({ cwu, omegaValue, denominator, unclaimed, epochEmissionTar = 0 }) {
  if (!(denominator > 0) || !(unclaimed > 0)) return { amount: 0, ... };
  const share = (cwu * omegaValue) / denominator;
  const ceiling = epochEmissionTar > 0
    ? epochEmissionTar * CONFIG.MAX_RECEIPT_SHARE_OF_EPOCH
    : Infinity;
  const ideal = Math.min(unclaimed * share, ceiling);
  const amount = Math.min(ideal, unclaimed);
  ...
}
```

Эмиссия эпохи:
```js
// economics.js:109-112
function epochEmission(epoch) {
  if (epoch < 0) return 0;
  return CONFIG.INITIAL_BLOCK_REWARD * Math.pow(2, -epoch / CONFIG.HALVING_PERIOD_EPOCHS);
}
```

Вес узла:
```js
// economics.js:114-117
function omega(stake, reputation) {
  return Math.sqrt(Math.max(Number(stake) || 0, 0)) * Math.max(Number(reputation) || 0, 0);
}
```

Точка применения в сервере:
```js
// server.js:2876-2885
const omegaValue = routingWeight(node.stake, node.reputation);   // = omega(stake, rep)
const denominator = state.denominator + cwuPreview.cwu * omegaValue;
...
RewardEngine.settle({ ..., omegaValue, denominator, unclaimed, ... });
```

**Ответ на вопрос «с стейком или без»: стейк-множитель ЕСТЬ.** Он входит не отдельным коэффициентом в `Block_Share`, а через `omega = √stake × reputation`, который умножает CWU в числителе доли и участвует в знаменателе эпохи. При `stake = 0` вес нулевой, и эмиссия узлу не начисляется (см. комментарий `server.js:6815`).

Формула платы за работу (`Fee_Reward`):
```js
// economics.js:122
const gross = (cwu * CONFIG.PRICE_USD_PER_1M_TOKENS) / 1e6 / CONFIG.USD_PER_TAR;
// затем burn = gross×0.025, treasury = gross×0.025, net = gross−burn−treasury,
// royalty = net×0.05 (если есть автор адаптера), worker = net−royalty
// при paymentMode === 'TAR_UTILITY' ставки 0.01/0.01 вместо 0.025/0.025
```

---

## 4. Строка чека

### 4.1 Где реализована

`buildCanonicalReceiptString` **не существует**. Реальная функция — `receiptPayloadV2(r)` в `backend-api/dag-chain.js:59-77`; сборка чека — `ledger.js:105-150`; запись `payloadVersion = 2` жёстко в `ledger.js:146`.

### 4.2 Поддерживаемые `payloadVersion`

| Версия | Покрытие |
|---|---|
| 1 | исторические чеки, строка без DAG-сцепки; `payloadVersionOf()` считает всё `< 2` единицей (`dag-chain.js:74-77`) |
| 2 | все новые чеки, сцепка внутри подписи |
| 3 | **нет.** `grep -rn "payloadVersion.*3\|receiptPayloadV3"` → 0 вхождений |

### 4.3 Поля канонической строки v2 (порядок фиксирован)

```
v2.1-dpouw | seq | workerAddress | cwu | rewardTar | cumulativeTotal
| burnTar | treasuryTar | royaltyTar | epoch | timestamp
| prevSignature | workerSeq | prevReceiptHash | cumulativeCwu | cumulativeTar
```
Числа — `toFixed(6)`, тег `PAYLOAD_V2_TAG = 'v2.1-dpouw'`, разделитель `|`.

### 4.4 Ключевое расхождение в именах полей

| Ожидание (в директиве) | Факт в коде | Где |
|---|---|---|
| `cumulativeMicroCwu` | **`cumulativeCwu`** | `dag-chain.js:74`, `ledger.js:121,180`, `server.js` |
| `cumulativeTarUnits` | **`cumulativeTar`** | там же |

grep по `cumulativeMicroCwu` и `cumulativeTarUnits` по всему репозиторию (без `node_modules`) → **0 вхождений**. Колонки в БД называются так же: `cumulativeCwu`, `cumulativeTar`.

### 4.5 Заготовки под версию 3

Нет ни `payloadVersion: 3`, ни `receiptPayloadV3`, ни поля-заглушки. Единственная «версионность» — `payloadVersionOf()` с порогом `>= 2`.

---

## 5. Тесты

Оба режима, только чтение (тестовый набор поднимает собственный изолированный сервер на временной БД и свободном порту).

| Набор | Команда | Итог | RC | Время |
|---|---|---|---|---|
| `test-dpouw.js` | `node test-dpouw.js --test` | **1344 ✅ / 0 ❌ / 0 SKIP** | 0 | **171 с** |
| `test-knowledge.js` | `node test-knowledge.js` | **46 ✅ / 0 ❌** | 0 | <1 с |
| `test-conversation.js` | `node test-conversation.js` | **30 ✅ / 0 ❌** | 0 | **30 с** |

`grep -c "test("` по `test-dpouw.js` → 254 (вхождения в исходнике, не число проверок).

Файлы `test*.js` в репозитории: `test-conversation.js` (20 990 B), `test-dpouw.js` (761 143 B), `test-knowledge.js` (16 045 B), `test-mesh.js` (22 441 B), `test-mesh-worker.js` (2 626 B).

### 5.1 Полный гейт `scripts/verify.sh`

Запущен целиком, RC = 0, 304 с:

```
✅ GitHub HEAD              f4e02f1 = локальный f4e02f1
✅ локальное дерево чистое
✅ VPS HEAD                 f4e02f1a = локальный f4e02f1
✅ git status на VPS        чистый
✅ sha256 файлов            179/179 совпали с коммитом
✅ systemd drop-in          3 файлов = репозиторию
✅ переменные применены     systemd видит все значения
✅ хроника проекта          f4e02f1 (2026-11-14 21:30), кода после неё нет
✅ тесты dpouw              1344 ✅   0 ❌
✅ тесты mesh               25 ✅ / 0 ❌
✅ тесты treasury           15 ✅   0 ❌
✅ тесты knowledge          46 ✅   0 ❌
✅ тесты conversation       30 ✅   0 ❌
⏭  multi-turn              воркера нет (active_workers: 0) — память не проверена, это НЕ провал модели
✅ тесты p2p-discovery      15 ✅   0 ❌
✅ тесты p2p-gossip         10 ✅   0 ❌
✅ тесты p2p-seed-failover  12 ✅   0 ❌
✅ тесты p2p-relay          10 ✅   0 ❌
✅ тесты p2p-reannounce     9 ✅   0 ❌
✅ systemd tarnet           active
✅ /health на VPS           HTTP 200
✅ версия прода            2.29.13 = package.json
✅ версия в шапках         2.29.13 = package.json (три документа)
✅ число проверок (локальный гейт) 1420 = 1344 dpouw + 46 knowledge + 30 conversation
✅ число проверок (все наборы)     1516 = 10 наборов, слагаемые совпадают
✅ /health снаружи          HTTP 200
✅ /app/ снаружи            HTTP 200
✅ /download/worker.js      HTTP 200
✅ оба seed в bootstrap    2|12D3KooW,12D3KooW (peerId разные)
✅ /config TIER6            fee=0.0002 cashback=0.0001 rate=0.5 (= config.js)
✅ документы в корне        13/13 — симлинки в backend-api
✅ свободное место         1356 МБ свободно (порог 500)

ВСЁ ЗЕЛЁНОЕ: VPS = GitHub = f4e02f1, сервис жив
```

Сумма: **1516 проверок в 10 наборах, 0 ❌**. Один намеренный SKIP (`multi-turn`) — из-за `active_workers: 0`, это отсутствие окружения, а не дефект.

---

## 6. Состояние базы

`sqlite3` из `exec` недоступен по политике OpenClaw («cannot open databases under the active OpenClaw state directory»). Использован `node:sqlite` (`DatabaseSync`, `readOnly: true`) на копии файла в `/tmp/tarnet-recon.db`.

**Внимание:** локальный `backend-api/tarnet.db` — dev-копия, mtime `2026-11-09 11:11`, 565 248 B. Он НЕ соответствует проду (808 чеков). Прод пишет в `/var/lib/tarnet/tarnet.db` (2 433 024 B по `/health.databaseBytes`).

### Локальная dev-копия

```
work_receipts:            60 строк (seq 1..60)
по payloadVersion:        2 → 60   (v1 нет)
balances WHERE balanceTar > 0:  14
balances WHERE stakedTar  > 0:  20
balances:                 29 адресов, Σ balanceTar = 4.786916
nodes:                    24 записи, Σ stake = 46 300, Σ reputation = 10.82
work_receipts.omega:      min 1.5811, max 176.0615, avg 19.0292
work_receipts.share:      min 0.00000209, max 1.0
epoch_state:              {"epoch":381,"emissionTar":24.251811,"releasedTar":4.267296,"distributedTar":4.267254,"denominator":3786022430.3266377}
```

Колонки `balances`: `address, balanceTar, stakedTar, reservedTar, updatedAt` (колонки `balance` нет — запрос из директивы `WHERE balance > 0` дал бы ошибку).

### Прод (через API)

| Метрика | Значение | Источник |
|---|---|---|
| чеков | `808` | `/summary.receipts` |
| разбивка по тирам | base 766, expert 31, nano 11 | `/summary.receiptsByTier` |
| разбивка по `payloadVersion` | **не отдаётся** ни одним живым маршрутом | — |
| балансов > 0 | **не отдаётся** (`/receipts` 404) | — |
| узлов | 97 (`workers`), комитет candidates 23 | `/summary`, `/health` |

**Дыра:** прод не публикует `payloadVersion`-разбивку. Утверждать, что все 808 чеков — версия 2, нельзя; локальная копия (60/60 v2) этого не доказывает.

---

## 7. Знания агента о проекте

**1. Актуальная версия.** `2.29.13` — по `curl /health → buildVersion` и `package.json`, схема леджера `2.1.0-dpouw`. Совпадает с VPS и GitHub (`f4e02f1`). Тег `v2.29.13` не поставлен: последний тег `v2.19.2-p0-p1-security` от 05.11, после него 139 коммитов.

**2. Канонические документы по экономике.** `MANIFEST.v3.4-UNIFIED.md` — единственный канон по устройству и экономике (Code-First Rule: всё, чего нет в `config.js`/`ledger.js`, помечается `[SPEC / ROADMAP]`). Источник истины по числам — `config.js` и `economics.js`, по начислению — `ledger.js` и `dag-chain.js`. `NARRATIVE.md` — та же картина для инвесторов, но не источник фактов. `MASTER-PLAN.md` — путь по этапам (16 этапов, 0–15), не описание экономики.

**3. Формула эмиссии и стейк.** Двухпоточная модель, `REWARD_MODE = 'hybrid'`:
- Поток 1 (demand): `gross = cwu × 0.20 / 1e6 / 20`, минус 2.5% burn + 2.5% treasury + 5% роялти от net;
- Поток 2 (bootstrap): `E_epoch = 50 × 2^(−t/365)`, доля `(cwu × ω) / Σ(cwu × ω)`, потолок `25%` эпохи на один чек;
- `ω = √stake × reputation` — **стейк-множитель есть**, он в `omega()`, а не отдельным коэффициентом.

Фактический срез: `totalBlockRewardTar = 169.329484` против `totalFeeRewardTar = 7.152497` — эмиссия даёт 96% выплат, платный спрос — 4%.

**4. Заготовки под конституцию.** Нет. `constitution_v2` — 0 вхождений, `demand_factor`/`demandFactor` — 0, `payloadVersion: 3` — 0, `receiptPayloadV3` — 0. Слово «конституция» в коде и манифесте не встречается.

**5. Прошлое обсуждение.** В моём контексте его нет — я не видел ни брифинга, ни директивы `v2.29.14-monetary-constitution-spec`. Всё выше снято живыми командами в этом ходе. Если директива ссылается на договорённости, которых нет в репозитории, я их не подтвержу.

---

## 8. Расхождения с ожиданиями конституционной директивы

### Блокирующие (директива ляжет криво, если не поправить)

| № | Ожидание в директиве | Факт | Что делать в директиве |
|---|---|---|---|
| 1 | `cumulativeMicroCwu` в подписи | поле называется **`cumulativeCwu`** | заменить имя на реальное |
| 2 | `cumulativeTarUnits` в подписи | поле называется **`cumulativeTar`** | заменить имя на реальное |
| 3 | `buildCanonicalReceiptString` | функции нет; есть **`receiptPayloadV2()`** в `dag-chain.js` | ссылаться на реальный символ и файл |
| 4 | `scripts/verify.sh` «существует/путь» | лежит в `backend-api/scripts/verify.sh`, не в корне репо и не в корне воркспейса | указать полный путь от корня репо |
| 5 | `docs/NARRATIVE.md` | в `backend-api/docs/NARRATIVE.md`; в корне — симлинк `NARRATIVE.md` | указать, что корневой путь — симлинк |
| 6 | блоки `[SPEC-...]` в манифесте | формат — `[SPEC]`, `[SPEC / ROADMAP]`, `[SPEC Фаза 2.5]`, `[SPEC Фаза 3]`; дефисных `[SPEC-...]` нет | использовать реальный формат метки |
| 7 | `[TESTNET-LIVE]` в манифесте | **0 вхождений** | не ссылаться на несуществующую секцию |
| 8 | «если уже есть блок конституции — привести» | блока нет; слово «конституция» отсутствует в MANIFEST | конституцию писать с нуля, не «дополнять» |
| 9 | `WHERE balance > 0` для БД | колонка называется **`balanceTar`** | исправить SQL |
| 10 | «держать `kappa` одной константой» | κ — таблица `TIER_WEIGHTS` по тиру, не скаляр | формулы писать через `TIER_WEIGHTS[tier]` |

### Не блокирующие, но требующие решения

| № | Факт | Следствие |
|---|---|---|
| 11 | `MAX_RECEIPT_SHARE_OF_EPOCH = 0.25` **уже есть** в коде | конституция не «вводит» его — она либо подтверждает 0.25, либо меняет значение с обоснованием |
| 12 | `REWARD_MODE = 'hybrid'` **уже есть** | то же: подтверждение или смена режима, а не «ввести» |
| 13 | `demand_factor` не существует | если конституция его вводит — это новая константа, а не ссылка на имеющуюся |
| 14 | `payloadVersion: 3` не заготовлен | версия 3 — полностью новая работа: `receiptPayloadV3()`, миграция, ветка в `payloadVersionOf()`, ветка в `ledger.js` |
| 15 | стейк-множитель уже в `omega()`, но **не в `Block_Share` явно** | если конституция требует стейк «в формуле доли», надо решить: оставить `ω` в числителе или добавить отдельный множитель |
| 16 | теги отстают на 139 коммитов | конституцию нельзя привязать к тегу — привязка только к коммиту `f4e02f1` |
| 17 | `README.md` в шапке: `2.22.13` при `package.json` `2.29.13` | `verify.sh` сверяет три документа (MASTER-PLAN, MANIFEST, NARRATIVE), README не входит — расхождение живёт |
| 18 | `/health.epoch.releasedTar 8.411168` vs `/epoch.releasedTar 8.48599` | два источника одного числа расходятся; при конституции «эмиссия = X» надо назвать один канонический маршрут |
| 19 | прод не отдаёт разбивку чеков по `payloadVersion` | нельзя утверждать «все 808 чеков v2»; нужен либо маршрут, либо SQL на проде |
| 20 | локальный `tarnet.db` — dev-копия от 09.11 (60 чеков) | любые цифры «из базы» локально ≠ прод; в конституции числа брать из `/summary` |
| 21 | `faucetEmission` помечен `emission: true` (11 выдачи, 0.11 TAR) | если конституция объявляет «эмиссия только через block reward», этот канал ей противоречит — надо назвать исключением |
| 22 | комитет: `eligible 1`, `required 5`, `drawn 0`, `insufficient_stake` | конституционные лимиты по стейку сейчас не проходят; любая норма «5 валидаторов» немедленно красная |

### Что подтвердилось

- `scripts/verify.sh` существует и **зелёный целиком** (RC 0, 1516 проверок, 10 наборов).
- `docs/NARRATIVE.md` существует.
- `MANIFEST.v3.4-UNIFIED.md` существует и является каноном (так и записано в шапке).
- `MASTER-PLAN.md`, `PROJECT-HISTORY.md`, `PROJECT-MAP.md`, `ROADMAP.md`, `README.md` — все на месте.
- `MAX_RECEIPT_SHARE_OF_EPOCH` и `REWARD_MODE` в коде есть.
- Стейк-множитель в экономике есть, через `ω = √stake × reputation`.
- `conservation.delta = 0` и на проде, и в тестах.

---

## 9. Состояние рабочего дерева

`git status --porcelain` — **пусто** на момент начала разведки. Единственный новый файл — этот документ; не закоммичен намеренно, как требовала директива.
