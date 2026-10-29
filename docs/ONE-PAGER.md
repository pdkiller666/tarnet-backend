# TarNet / Synapse — One-Pager (чистовик)

**Статус:** сверено с живым стендом **2026-10-29, 14:41 MSK** (сборка `2.17.0-ws-utility`, схема леджера `2.1.0-dpouw`, тег `v2.17.0-ws-utility`).
**Правило:** каждая цифра ниже снята с живого стенда либо посчитана из его ответов. Ни одна не взята из документов и не округлена в большую сторону. Источник указан рядом с каждой.

---

## RU

### TarNet / Synapse — работающий протокол, у которого появился первый исполнитель

**Что это.** Децентрализованная сеть вычислений для LLM-инференса: владельцы устройств выполняют запросы, получают за это `$TAR`, а протокол ведёт независимый реестр выполненной работы (dPoUW) с проверяемым сохранением стоимости.

**Состояние на 29.10.2026, 14:41 MSK:**

| Показатель | Значение | Откуда |
|---|---|---|
| Выполненных единиц работы | **750** чеков | `/summary.receipts` |
| Адресов с историей начислений | **90** | `/summary.workers` |
| Выплачено воркерам | **80.387229 TAR** | `/summary.totalRewardTar` |
| Полный оборот леджера | **80.772805 TAR** | `/health.conservation.gross` |
| Инвариант сохранения | **delta 0**, `holds: true`, 0 несогласованных строк | `/health.conservation` |
| Сверка казны и сжигания | **`treasuryAudit` и `burnAudit`: `holds: true`** — журнал сходится с балансами | `/summary` |
| Суммарный учтённый труд | **744 298 062 CWU** | `/summary.totalCwu` |
| Моделей в каталоге | **18** — 15 облачных у 8 вендоров + 3 локальные | `/models` |
| Живых воркеров | **1 сейчас** — `0xe56c…`, 4343 опроса (окно жизни — 60 с) | `/worker/status` |
| Режим инференса | **`worker`** — живая модель `qwen2.5-coder:1.5b` | `/health.llm_mode` |
| Автотестов приёмки | **995** (970 + 25), 0 падений | прогон 29.10.2026 |
| Привязка устройств | **подпись Ed25519** + одноразовый nonce | `/devices/link` |
| Перенос старых балансов | **`POST /migrate/claim`** — подпись нового кошелька | `2.12.9` (не менялось) |
| Внутренняя утилизация токена | механизм **есть** (`TAR_UTILITY`, 2%), но `totalUtilizedTar: 0` — не используется | `/summary` |

**Сквозной путь доказан, а не заявлен.** 28.10.2026 телефон в мобильной сети отправил запрос → VPS → домашний ПК исполнителя → Ollama (`qwen2.5-coder:1.5b`) → VPS → телефон. Ответ пришёл от **живой модели**: `llm_mode: worker`, воркер `0xaf34…` онлайн, более 2 000 опросов. Это не стенд на `127.0.0.1` — это мобильная сеть и домашнее устройство. **На замере 29.10 14:41 воркер снова онлайн** (`active_workers: 1`, `llm_mode: worker`, 4343 опроса) — но окно жизни 60 с, поэтому «сейчас работает» не равно «сеть работает».

**Экономика — то, что реально в коде.**

- Базовая ставка: **$0.20 / 1M токенов** (`PRICE_USD_PER_1M_TOKENS = 0.20`).
- Экспертный тир дороже не ценой, а весом: `TIER_WEIGHTS.expert = 4.0` → эффективно **$0.80 / 1M**.
- Комиссия протокола 5%, из неё burn 2.5%, казна 2.5%, роялти LoRA 5%.
- Проверка: `GET /config`.

**Tier 6 (BYOK) — новый слой экономики.** Пользователь вставляет свой ключ провайдера (OpenRouter / OpenAI), вызов идёт напрямую от него, протокол берёт комиссию **0.0005 TAR** и возвращает **кэшбэк 0.0001 TAR**. Остаток комиссии делится 50/50 между сжиганием и казной. Инвариант Tier 6 сходится в ноль. Ворота проверены на живом проде в правильном порядке: нет модели → `400`, нет ключа → `401` **до** любого сетевого вызова, нет денег → `402`, отказ провайдера → `401 PROVIDER_AUTH_FAILED` с именем провайдера.

**Безопасность привязки устройств — подпись, а не заявка.** До `2.12.8` `POST /devices/link` принимал адрес из тела без проверки: кто знал адрес, тот привязывал чужое устройство, и комиссия Tier 6 списывалась с чужого кошелька. Теперь владелец подписывает строку `<scope>:<owner>:<device>:<nonce>` ключом Ed25519; nonce одноразовый (`409` на повтор), scope у привязки и отвязки разный, подпись проверяется **до** поиска устройства в сети — иначе код ответа выдавал бы, какие адреса существуют. Клиент получил настоящий ключ: адрес выводится как `0x + sha256(SPKI-DER)[0..40]`, приватный ключ остаётся в браузере.

**Старые балансы больше не заморожены.** До `2.12.9` адрес в PWA был 20 случайными байтами без ключа, и демо-начисления на таких адресах были недоступны навсегда. `POST /migrate/claim` переносит их на текущий кошелёк: подпись ставит **новый** адрес (старый ключа не имеет по определению), перенос идёт одной строкой реестра и не меняет сумму по всем балансам. Перенос с живого аккаунта, с адреса с ключом и с адреса привязанного устройства закрыт.

**Что показывает инвариант сохранения.** Выплаты воркерам (80.387229) плюс сожжённое (0.186138), казна (0.186138) и роялти (0.013300) дают ровно 80.772805 — оборот леджера. Расхождение нулевое на 750 чеках. Это не декларация, а проверяемое тождество: любой может пересчитать его из двух публичных endpoint'ов.

**Чего у нас пока нет — прямо и без оговорок.**

1. **Сеть из одного узла.** На замере 29.10 14:41 воркер был онлайн (`active_workers: 1`, `0xe56c…`, 4343 опроса), но окно жизни — 60 секунд: устройство основателя, выключаемое руками. Механика режима `worker` доказана сквозным тестом 28.10, второго независимого исполнителя нет. Честная формулировка: «протокол работает, сеть состоит из одного узла, который надо включать руками».
2. **Комитет валидаторов не набран.** Требуется 5 независимых валидаторов со стейком 10 TAR каждый — **50 TAR заблокированного стейка**. Сейчас 0 членов, гейт работает в вырожденном режиме самопроверки. Это вопрос денег, а не кода.
3. **P2P только на localhost.** Три узла маршрута слушают `ws://127.0.0.1`, `announced_public: false`. Криптография настоящая (RSA-OAEP + AES-256-GCM, 3 хопа), распределённости нет.
4. **Обучение не идёт.** Knowledge Loop: `phase: 2.5 [SPEC / ROADMAP]`, `training.implemented: false`, причина — нужен GPU. Адаптеры в статусе `pending_gpu`.
5. **Токен пока без опоры в спросе.** **91.22%** награды — эмиссия (73.329811 TAR) против **8.78%** из комиссий (7.057418 TAR). На 1 TAR платного спроса (7.442994 gross) приходится **9.85 TAR** напечатанных. Механизм внутренней утилизации (`TAR_UTILITY`, 2%) в коде с 2.17.0, но экономически мёртв: `totalUtilizedTar: 0`.
6. **Tier 6 проверен девять раз, не потоком.** `tier6_calls: 9` — успешные вызовы с живым ключом OpenRouter, `gross 0.0045`, `delta: 0`, `fundedByClient: 9`. Девять запросов не показывают поведение под нагрузкой: лимиты провайдера, параллельные резервы и TTL на реальном трафике не проверялись.

**Аудит 8 компонентов видения:** **2 ✅ / 3 ⚠️ / 3 ❌ (~44%)** по методике `docs/VISION-8-COMPONENTS.md` (✅ = 1, ⚠️ = 0.5). Не ~62%: 62.5% выходит, только если ⚠️ считать полным ✅.

**Почему это всё же интересно.** Ядро — криптография, леджер и экономика — проверяемо сегодня: 750 чеков, нулевое расхождение, 995 автотестов, воспроизводимая приёмка одной командой, сквозной инференс через мобильную сеть. Отсутствует не протокол, а его рынок: устройства. Это разница между «мы построили сеть» (неправда) и «мы построили работающий протокол, которому нужна сеть» (правда, и её можно проверить).

**The Ask.** $150K pre-seed за 5–10% токенов — на подключение первых исполнителей, комитет валидаторов и GPU-обучение адаптеров.

---

## EN

### TarNet / Synapse — a working protocol that just got its first executor

**What it is.** A decentralized compute network for LLM inference: device owners serve requests and earn `$TAR`, while the protocol keeps an independent ledger of verified work (dPoUW) with a checkable conservation-of-value invariant.

**State as of 29 Oct 2026, 14:41 MSK** (build `2.17.0-ws-utility`, ledger schema `2.1.0-dpouw`, tag `v2.17.0-ws-utility`):

| Metric | Value | Source |
|---|---|---|
| Completed units of work | **750** receipts | `/summary.receipts` |
| Addresses with payout history | **90** | `/summary.workers` |
| Paid to workers | **80.387229 TAR** | `/summary.totalRewardTar` |
| Total ledger turnover | **80.772805 TAR** | `/health.conservation.gross` |
| Conservation invariant | **delta 0**, `holds: true`, 0 inconsistent rows | `/health.conservation` |
| Treasury and burn reconciliation | **`treasuryAudit` and `burnAudit`: `holds: true`** — ledger matches balances | `/summary` |
| Total accounted work | **744,298,062 CWU** | `/summary.totalCwu` |
| Models in catalog | **18** — 15 cloud across 8 vendors + 3 local | `/models` |
| Live workers | **1 right now** — `0xe56c…`, 4343 polls (60-second liveness window) | `/worker/status` |
| Inference mode | **`worker`** — live model `qwen2.5-coder:1.5b` | `/health.llm_mode` |
| Acceptance assertions | **995** (970 + 25), 0 failures | run of 29 Oct 2026 |
| Device binding | **Ed25519 signature** + single-use nonce | `/devices/link` |
| Legacy balance claim | **`POST /migrate/claim`** — signed by the new wallet | `2.12.9` (unchanged) |
| Token utilization | mechanism **exists** (`TAR_UTILITY`, 2%), but `totalUtilizedTar: 0` — unused | `/summary` |

**The end-to-end path is proven, not claimed.** On 28 Oct 2026 a phone on a mobile network sent a request → VPS → the executor's home PC → Ollama (`qwen2.5-coder:1.5b`) → VPS → phone. The answer came from a **live model**: `llm_mode: worker`, worker `0xaf34…` online with over 2,000 polls. This is not a `127.0.0.1` bench — it is a mobile network and a home device. **At the 29 Oct 14:41 snapshot the worker is online again** (`active_workers: 1`, `llm_mode: worker`, 4343 polls) — but the liveness window is 60 seconds, so "working right now" is not the same as "the network works".

**Economics — what is actually in the code.**

- Base rate: **$0.20 / 1M tokens** (`PRICE_USD_PER_1M_TOKENS = 0.20`).
- The expert tier is priced by weight, not by a separate rate: `TIER_WEIGHTS.expert = 4.0` → effectively **$0.80 / 1M**.
- Protocol fee 5%, split into burn 2.5%, treasury 2.5%, LoRA royalty 5%.
- Verification: `GET /config`.

**Tier 6 (BYOK) — a new economic layer.** A user supplies their own provider key (OpenRouter / OpenAI), the call goes out on their account, the protocol charges a **0.0005 TAR** fee and returns a **0.0001 TAR** cashback. The remainder splits 50/50 between burn and treasury. The Tier 6 invariant sums to zero. Gates were verified on live production in the correct order: no model → `400`, no key → `401` **before** any network call, no funds → `402`, provider rejection → `401 PROVIDER_AUTH_FAILED` naming the provider.

**Device binding is a signature, not a claim.** Before `2.12.8`, `POST /devices/link` accepted an address from the request body with no verification: whoever knew an address could bind someone else's device, and the Tier 6 fee was then charged to that stranger's wallet. Now the owner signs `<scope>:<owner>:<device>:<nonce>` with an Ed25519 key; the nonce is single-use (`409` on replay), link and unlink use different scopes, and the signature is checked **before** the device lookup — otherwise the response code would leak which addresses exist. The client now holds a real key: the address is `0x + sha256(SPKI-DER)[0..40]`, and the private key never leaves the browser.

**Legacy balances are no longer frozen.** Before `2.12.9` the PWA address was 20 random bytes with no key, so demo credits on such addresses were permanently unreachable. `POST /migrate/claim` moves them to the current wallet: the **new** address signs (the old one has no key by definition), the move is a single ledger row, and the sum across all balances is unchanged. Claims from a live account, from an address that has a key, and from a bound device are all rejected.

**What the conservation invariant shows.** Worker payouts (80.387229) plus burned (0.186138), treasury (0.186138) and royalties (0.013300) equal exactly 80.772805 — the ledger's turnover. Zero discrepancy across 750 receipts. This is not a claim but a checkable identity: anyone can recompute it from two public endpoints.

**What we do not have yet — stated plainly.**

1. **A network of one node.** At the 29 Oct 14:41 snapshot the worker was online (`active_workers: 1`, `0xe56c…`, 4343 polls), but the liveness window is 60 seconds: it is the founder's device, switched on by hand. The `worker` mode is proven end-to-end on 28 Oct, but there is no second independent executor. The honest phrasing: "the protocol works, the network consists of a single node that has to be switched on by hand."
2. **The validator committee is not formed.** It needs 5 independent validators staking 10 TAR each — **50 TAR of locked stake**. There are 0 members today, and the gate runs in a degenerate self-check mode. This is a funding problem, not an engineering one.
3. **P2P is localhost-only.** Three route nodes listen on `ws://127.0.0.1`, `announced_public: false`. The cryptography is real (RSA-OAEP + AES-256-GCM, 3 hops); the distribution is not there.
4. **Training is not running.** Knowledge Loop: `phase: 2.5 [SPEC / ROADMAP]`, `training.implemented: false`, blocked on GPU. Adapters sit in `pending_gpu`.
5. **The token has no demand floor yet.** **91.22%** of rewards are emission (73.329811 TAR) against **8.78%** from fees (7.057418 TAR). Every 1 TAR of paid demand (7.442994 gross) carries **9.85 TAR** printed. The in-protocol utilization mechanism (`TAR_UTILITY`, 2%) exists since 2.17.0 but is economically dead: `totalUtilizedTar: 0`.
6. **Tier 6 has been exercised nine times, not under load.** `tier6_calls: 9` — successful calls with a live OpenRouter key, `gross 0.0045`, `delta: 0`, `fundedByClient: 9`. Nine requests say nothing about behaviour under load: provider rate limits, concurrent reserves and TTL on real traffic are unverified.

**Eight-component vision audit:** **2 ✅ / 3 ⚠️ / 3 ❌ (~44%)** per the `docs/VISION-8-COMPONENTS.md` methodology (✅ = 1, ⚠️ = 0.5). Not ~62%: 62.5% only appears if ⚠️ is counted as full ✅.

**Why it is still interesting.** The core — cryptography, ledger and economics — is verifiable today: 750 receipts, zero discrepancy, 995 automated assertions, reproducible acceptance in one command, end-to-end inference over a mobile network. What is missing is not the protocol but its market: devices. That is the difference between "we built a network" (false) and "we built a working protocol that needs a network" (true, and checkable).

**The Ask.** $150K pre-seed for 5–10% of tokens — to onboard the first executors, seat the validator committee, and fund GPU training of the adapters.

---

## Пометки для правки

- **Не цитировать:** `$1.50–2.50/M`, `$0.30–0.50/M`, `$2.00/M`, `$330/мес`, `$1.00/M` — цены Whitepaper, в коде не действуют.
- **Не писать «90 узлов в сети».** 90 — адреса с историей начислений. На замере 29.10 14:41 — `active_workers: 1`; окно жизни воркера 60 секунд, поэтому «один сейчас» не значит «сеть», а «ноль» — не значит «сеть мертва». Говорить: «один узел, включаемый руками».
- **Не писать «80.39 TAR распределено» без уточнения.** Это выплаты воркерам; оборот леджера 80.772805.
- **Не писать «сеть постоянно живая».** 28.10 воркер был онлайн и сквозной тест прошёл; на замере 29.10 14:41 — `active_workers: 1`, `llm_mode: worker`. Окно жизни 60 с, поэтому говорить «путь доказан», не «сеть работает непрерывно».
- **Не ставить старые снимки как текущие.** 705/78/56.55 — снимок 24.10; 716/83/72.116894 — 28.10 16:30; 721/83/72.117293 — 28.10 19:30; 725/83/72.119545 — 28.10 23:46:09; 731/84/72.119989 — 29.10 09:03; **750/90/80.387229 — 29.10 14:41 (текущий)**.
- **Не писать «Tier 6 работает под нагрузкой».** `tier6_calls: 9` — девять сделок с живым ключом. Говорить можно про «вызов проходит и арифметика сходится», нельзя — про поток, лимиты и параллельные резервы.
- **Не писать «738 тестов» или «713+25»** — актуально **995** (970 на `node test-dpouw.js --test` + 25 на `node test-mesh.js`).
- **Не смешивать «9 провайдеров» и «8 вендоров».** `/models` считает `provider: "local"` отдельной строкой, поэтому 9 = 8 вендоров + локальные. Gemini и Groq в коде есть, но в каталог не внесены — в цифру 18 не входят.
- **Не называть привязку устройств «заявкой».** С `2.12.8` это подпись Ed25519 с одноразовым nonce. Но и не обещать больше: подпись доказывает владение **аккаунтом**, а не самим ПК.
- **Источники для перепроверки:** `GET /health`, `/summary`, `/config`, `/worker/status`, `/knowledge/status`, `/p2p/status`.
