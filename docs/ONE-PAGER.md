# TarNet / Synapse — One-Pager (чистовик)

**Статус:** сверено с живым стендом **2026-10-28, 23:46:09 MSK** (сборка `2.14.0-responsive`, схема леджера `2.1.0-dpouw`, тег `v2.14.0-responsive`).
**Правило:** каждая цифра ниже снята с живого стенда либо посчитана из его ответов. Ни одна не взята из документов и не округлена в большую сторону. Источник указан рядом с каждой.

---

## RU

### TarNet / Synapse — работающий протокол, у которого появился первый исполнитель

**Что это.** Децентрализованная сеть вычислений для LLM-инференса: владельцы устройств выполняют запросы, получают за это `$TAR`, а протокол ведёт независимый реестр выполненной работы (dPoUW) с проверяемым сохранением стоимости.

**Состояние на 28.10.2026, 23:46:09 MSK:**

| Показатель | Значение | Откуда |
|---|---|---|
| Выполненных единиц работы | **725** чеков | `/summary.receipts` |
| Адресов с историей начислений | **83** | `/summary.workers` |
| Выплачено воркерам | **72.119545 TAR** | `/summary.totalRewardTar` |
| Полный оборот леджера | **72.503071 TAR** | `/health.conservation.gross` |
| Инвариант сохранения | **delta 0**, `holds: true`, 0 несогласованных строк | `/health.conservation` |
| Суммарный учтённый труд | **740 196 253 CWU** | `/summary.totalCwu` |
| Моделей в каталоге | **18** — 15 облачных у 8 вендоров + 3 локальные | `/models` |
| Живых воркеров | **0 сейчас** (окно жизни — 15 с) | `/worker/status` |
| Режим инференса | **`deterministic_fallback`** — заглушка, пока воркер не запущен | `/health.llm_mode` |
| Автотестов приёмки | **918**, 0 падений | прогон 28.10.2026 |
| Привязка устройств | **подпись Ed25519** + одноразовый nonce | `/devices/link` |
| Перенос старых балансов | **`POST /migrate/claim`** — подпись нового кошелька | `2.12.9` (не менялось) |

**Сквозной путь доказан, а не заявлен.** 28.10.2026 телефон в мобильной сети отправил запрос → VPS → домашний ПК исполнителя → Ollama (`qwen2.5-coder:1.5b`) → VPS → телефон. Ответ пришёл от **живой модели**: `llm_mode: worker`, воркер `0xaf34…` онлайн, более 2 000 опросов. Это не стенд на `127.0.0.1` — это мобильная сеть и домашнее устройство. **На момент этой записи воркер выключен** (`active_workers: 0`, `llm_mode: deterministic_fallback`): путь доказан, но не постоянно живой.

**Экономика — то, что реально в коде.**

- Базовая ставка: **$0.20 / 1M токенов** (`PRICE_USD_PER_1M_TOKENS = 0.20`).
- Экспертный тир дороже не ценой, а весом: `TIER_WEIGHTS.expert = 4.0` → эффективно **$0.80 / 1M**.
- Комиссия протокола 5%, из неё burn 2.5%, казна 2.5%, роялти LoRA 5%.
- Проверка: `GET /config`.

**Tier 6 (BYOK) — новый слой экономики.** Пользователь вставляет свой ключ провайдера (OpenRouter / OpenAI), вызов идёт напрямую от него, протокол берёт комиссию **0.0005 TAR** и возвращает **кэшбэк 0.0001 TAR**. Остаток комиссии делится 50/50 между сжиганием и казной. Инвариант Tier 6 сходится в ноль. Ворота проверены на живом проде в правильном порядке: нет модели → `400`, нет ключа → `401` **до** любого сетевого вызова, нет денег → `402`, отказ провайдера → `401 PROVIDER_AUTH_FAILED` с именем провайдера.

**Безопасность привязки устройств — подпись, а не заявка.** До `2.12.8` `POST /devices/link` принимал адрес из тела без проверки: кто знал адрес, тот привязывал чужое устройство, и комиссия Tier 6 списывалась с чужого кошелька. Теперь владелец подписывает строку `<scope>:<owner>:<device>:<nonce>` ключом Ed25519; nonce одноразовый (`409` на повтор), scope у привязки и отвязки разный, подпись проверяется **до** поиска устройства в сети — иначе код ответа выдавал бы, какие адреса существуют. Клиент получил настоящий ключ: адрес выводится как `0x + sha256(SPKI-DER)[0..40]`, приватный ключ остаётся в браузере.

**Старые балансы больше не заморожены.** До `2.12.9` адрес в PWA был 20 случайными байтами без ключа, и демо-начисления на таких адресах были недоступны навсегда. `POST /migrate/claim` переносит их на текущий кошелёк: подпись ставит **новый** адрес (старый ключа не имеет по определению), перенос идёт одной строкой реестра и не меняет сумму по всем балансам. Перенос с живого аккаунта, с адреса с ключом и с адреса привязанного устройства закрыт.

**Что показывает инвариант сохранения.** Выплаты воркерам (72.119545) плюс сожжённое (0.185113), казна (0.185113) и роялти (0.013300) дают ровно 72.503071 — оборот леджера. Расхождение нулевое на 725 чеках. Это не декларация, а проверяемое тождество: любой может пересчитать его из двух публичных endpoint'ов.

**Чего у нас пока нет — прямо и без оговорок.**

1. **Сеть из одного узла — и тот сейчас выключен.** `active_workers: 0` на момент записи: устройство основателя офлайн, инференс идёт заглушкой `deterministic_fallback`. Механика режима `worker` работает и доказана сквозным тестом 28.10, но второго независимого исполнителя нет, и постоянно живым узел тоже не является. Честная формулировка: «протокол работает, сеть состоит из одного узла, который надо включать руками».
2. **Комитет валидаторов не набран.** Требуется 5 независимых валидаторов со стейком 10 TAR каждый — **50 TAR заблокированного стейка**. Сейчас 0 членов, гейт работает в вырожденном режиме самопроверки. Это вопрос денег, а не кода.
3. **P2P только на localhost.** Три узла маршрута слушают `ws://127.0.0.1`, `announced_public: false`. Криптография настоящая (RSA-OAEP + AES-256-GCM, 3 хопа), распределённости нет.
4. **Обучение не идёт.** Knowledge Loop: `phase: 2.5 [SPEC / ROADMAP]`, `training.implemented: false`, причина — нужен GPU. Адаптеры в статусе `pending_gpu`.
5. **Токен пока без опоры в спросе.** **90.27%** награды — эмиссия (65.098459 TAR) против **9.73%** из комиссий (7.018435 TAR). На 1 TAR платного спроса приходится **9.28 TAR** напечатанных. Это главная незакрытая проблема экономики.
6. **Tier 6 проверен одной сделкой.** `tier6_calls: 1` — 28.10 17:03 MSK прошёл успешный вызов с живым ключом OpenRouter (`fee 0.0005 = cashback 0.0001 + burn 0.0002 + treasury 0.0002`, `funded_by: client`, `delta: 0`). Выборка из одного запроса не показывает поведение под нагрузкой: лимиты провайдера, параллельные резервы и TTL на реальном трафике не проверялись.

**Аудит 8 компонентов видения:** **2 ✅ / 3 ⚠️ / 3 ❌ (~44%)** по методике `docs/VISION-8-COMPONENTS.md` (✅ = 1, ⚠️ = 0.5). Не ~62%: 62.5% выходит, только если ⚠️ считать полным ✅.

**Почему это всё же интересно.** Ядро — криптография, леджер и экономика — проверяемо сегодня: 725 чеков, нулевое расхождение, 918 автотестов, воспроизводимая приёмка одной командой, сквозной инференс через мобильную сеть. Отсутствует не протокол, а его рынок: устройства. Это разница между «мы построили сеть» (неправда) и «мы построили работающий протокол, которому нужна сеть» (правда, и её можно проверить).

**The Ask.** $150K pre-seed за 5–10% токенов — на подключение первых исполнителей, комитет валидаторов и GPU-обучение адаптеров.

---

## EN

### TarNet / Synapse — a working protocol that just got its first executor

**What it is.** A decentralized compute network for LLM inference: device owners serve requests and earn `$TAR`, while the protocol keeps an independent ledger of verified work (dPoUW) with a checkable conservation-of-value invariant.

**State as of 28 Oct 2026, 23:46:09 MSK** (build `2.14.0-responsive`, ledger schema `2.1.0-dpouw`, tag `v2.14.0-responsive`):

| Metric | Value | Source |
|---|---|---|
| Completed units of work | **725** receipts | `/summary.receipts` |
| Addresses with payout history | **83** | `/summary.workers` |
| Paid to workers | **72.119545 TAR** | `/summary.totalRewardTar` |
| Total ledger turnover | **72.503071 TAR** | `/health.conservation.gross` |
| Conservation invariant | **delta 0**, `holds: true`, 0 inconsistent rows | `/health.conservation` |
| Total accounted work | **740,196,253 CWU** | `/summary.totalCwu` |
| Models in catalog | **18** — 15 cloud across 8 vendors + 3 local | `/models` |
| Live workers | **0 right now** (15-second liveness window) | `/worker/status` |
| Inference mode | **`deterministic_fallback`** — stub until the worker runs | `/health.llm_mode` |
| Acceptance assertions | **918**, 0 failures | run of 28 Oct 2026 |
| Device binding | **Ed25519 signature** + single-use nonce | `/devices/link` |
| Legacy balance claim | **`POST /migrate/claim`** — signed by the new wallet | `2.12.9` (unchanged) |

**The end-to-end path is proven, not claimed.** On 28 Oct 2026 a phone on a mobile network sent a request → VPS → the executor's home PC → Ollama (`qwen2.5-coder:1.5b`) → VPS → phone. The answer came from a **live model**: `llm_mode: worker`, worker `0xaf34…` online with over 2,000 polls. This is not a `127.0.0.1` bench — it is a mobile network and a home device. **At the time of writing the worker is off** (`active_workers: 0`, `llm_mode: deterministic_fallback`): the path is proven, but not continuously live.

**Economics — what is actually in the code.**

- Base rate: **$0.20 / 1M tokens** (`PRICE_USD_PER_1M_TOKENS = 0.20`).
- The expert tier is priced by weight, not by a separate rate: `TIER_WEIGHTS.expert = 4.0` → effectively **$0.80 / 1M**.
- Protocol fee 5%, split into burn 2.5%, treasury 2.5%, LoRA royalty 5%.
- Verification: `GET /config`.

**Tier 6 (BYOK) — a new economic layer.** A user supplies their own provider key (OpenRouter / OpenAI), the call goes out on their account, the protocol charges a **0.0005 TAR** fee and returns a **0.0001 TAR** cashback. The remainder splits 50/50 between burn and treasury. The Tier 6 invariant sums to zero. Gates were verified on live production in the correct order: no model → `400`, no key → `401` **before** any network call, no funds → `402`, provider rejection → `401 PROVIDER_AUTH_FAILED` naming the provider.

**Device binding is a signature, not a claim.** Before `2.12.8`, `POST /devices/link` accepted an address from the request body with no verification: whoever knew an address could bind someone else's device, and the Tier 6 fee was then charged to that stranger's wallet. Now the owner signs `<scope>:<owner>:<device>:<nonce>` with an Ed25519 key; the nonce is single-use (`409` on replay), link and unlink use different scopes, and the signature is checked **before** the device lookup — otherwise the response code would leak which addresses exist. The client now holds a real key: the address is `0x + sha256(SPKI-DER)[0..40]`, and the private key never leaves the browser.

**Legacy balances are no longer frozen.** Before `2.12.9` the PWA address was 20 random bytes with no key, so demo credits on such addresses were permanently unreachable. `POST /migrate/claim` moves them to the current wallet: the **new** address signs (the old one has no key by definition), the move is a single ledger row, and the sum across all balances is unchanged. Claims from a live account, from an address that has a key, and from a bound device are all rejected.

**What the conservation invariant shows.** Worker payouts (72.119545) plus burned (0.185113), treasury (0.185113) and royalties (0.013300) equal exactly 72.503071 — the ledger's turnover. Zero discrepancy across 725 receipts. This is not a claim but a checkable identity: anyone can recompute it from two public endpoints.

**What we do not have yet — stated plainly.**

1. **A network of one node — and that node is currently off.** `active_workers: 0` at the time of writing: the founder's device is offline and inference falls back to the `deterministic_fallback` stub. The `worker` mode works and is proven end-to-end on 28 Oct, but there is no second independent executor, and the node is not continuously live either. The honest phrasing: "the protocol works, the network consists of a single node that has to be switched on by hand."
2. **The validator committee is not formed.** It needs 5 independent validators staking 10 TAR each — **50 TAR of locked stake**. There are 0 members today, and the gate runs in a degenerate self-check mode. This is a funding problem, not an engineering one.
3. **P2P is localhost-only.** Three route nodes listen on `ws://127.0.0.1`, `announced_public: false`. The cryptography is real (RSA-OAEP + AES-256-GCM, 3 hops); the distribution is not there.
4. **Training is not running.** Knowledge Loop: `phase: 2.5 [SPEC / ROADMAP]`, `training.implemented: false`, blocked on GPU. Adapters sit in `pending_gpu`.
5. **The token has no demand floor yet.** **90.27%** of rewards are emission (65.098459 TAR) against **9.73%** from fees (7.018435 TAR). Every 1 TAR of paid demand carries **9.28 TAR** printed. This is the main unsolved problem of the economy.
6. **Tier 6 has been exercised exactly once.** `tier6_calls: 1` — one successful call with a live OpenRouter key on 28 Oct 17:03 MSK (`fee 0.0005 = cashback 0.0001 + burn 0.0002 + treasury 0.0002`, `funded_by: client`, `delta: 0`). A single request says nothing about behaviour under load: provider rate limits, concurrent reserves and TTL on real traffic are unverified.

**Eight-component vision audit:** **2 ✅ / 3 ⚠️ / 3 ❌ (~44%)** per the `docs/VISION-8-COMPONENTS.md` methodology (✅ = 1, ⚠️ = 0.5). Not ~62%: 62.5% only appears if ⚠️ is counted as full ✅.

**Why it is still interesting.** The core — cryptography, ledger and economics — is verifiable today: 725 receipts, zero discrepancy, 918 automated assertions, reproducible acceptance in one command, end-to-end inference over a mobile network. What is missing is not the protocol but its market: devices. That is the difference between "we built a network" (false) and "we built a working protocol that needs a network" (true, and checkable).

**The Ask.** $150K pre-seed for 5–10% of tokens — to onboard the first executors, seat the validator committee, and fund GPU training of the adapters.

---

## Пометки для правки

- **Не цитировать:** `$1.50–2.50/M`, `$0.30–0.50/M`, `$2.00/M`, `$330/мес`, `$1.00/M` — цены Whitepaper, в коде не действуют.
- **Не писать «83 узла в сети».** 83 — адреса с историей начислений. Живой воркер на 28.10 23:46 — **ноль**; окно жизни воркера 15 секунд, поэтому «ноль сейчас» не значит «сеть мертва», но и «сеть работает» говорить нельзя.
- **Не писать «72.12 TAR распределено» без уточнения.** Это выплаты воркерам; оборот леджера 72.503071.
- **Не писать «сеть постоянно живая».** 28.10 воркер был онлайн и сквозной тест прошёл, но на 23:46 `active_workers: 0`, `llm_mode: deterministic_fallback`. Говорить «путь доказан», не «сеть работает непрерывно».
- **Не ставить старые снимки как текущие.** 705/78/56.55 — снимок 24.10; 716/83/72.116894 — снимок 28.10 16:30; 721/83/72.117293 — снимок 28.10 19:30; **725/83/72.119545** — снимок 28.10 23:46:09.
- **Не писать «Tier 6 работает под нагрузкой».** `tier6_calls: 1` — одна сделка с живым ключом. Говорить можно про «вызов проходит и арифметика сходится», нельзя — про поток, лимиты и параллельные резервы.
- **Не писать «738 тестов» или «713+25»** — актуально **918** на одном прогоне `node test-dpouw.js --test`.
- **Не смешивать «9 провайдеров» и «8 вендоров».** `/models` считает `provider: "local"` отдельной строкой, поэтому 9 = 8 вендоров + локальные. Gemini и Groq в коде есть, но в каталог не внесены — в цифру 18 не входят.
- **Не называть привязку устройств «заявкой».** С `2.12.8` это подпись Ed25519 с одноразовым nonce. Но и не обещать больше: подпись доказывает владение **аккаунтом**, а не самим ПК.
- **Источники для перепроверки:** `GET /health`, `/summary`, `/config`, `/worker/status`, `/knowledge/status`, `/p2p/status`.
