# TarNet / Synapse — One-Pager (чистовик)

**Статус:** сверено с живым стендом **2026-10-28, 16:30 MSK** (сборка `2.12.4-tier6-dos-fix`, схема леджера `2.1.0-dpouw`, тег `v2.13.0-tier6-byok`).
**Правило:** каждая цифра ниже снята с живого стенда либо посчитана из его ответов. Ни одна не взята из документов и не округлена в большую сторону. Источник указан рядом с каждой.

---

## RU

### TarNet / Synapse — работающий протокол, у которого появился первый исполнитель

**Что это.** Децентрализованная сеть вычислений для LLM-инференса: владельцы устройств выполняют запросы, получают за это `$TAR`, а протокол ведёт независимый реестр выполненной работы (dPoUW) с проверяемым сохранением стоимости.

**Состояние на 28.10.2026, 16:30 MSK:**

| Показатель | Значение | Откуда |
|---|---|---|
| Выполненных единиц работы | **716** чеков | `/summary.receipts` |
| Адресов с историей начислений | **83** | `/summary.workers` |
| Выплачено воркерам | **72.116894 TAR** | `/summary.totalRewardTar` |
| Полный оборот леджера | **72.500420 TAR** | `/health.conservation.gross` |
| Инвариант сохранения | **delta 0**, `holds: true`, 0 несогласованных строк | `/health.conservation` |
| Суммарный учтённый труд | **740 195 558 CWU** | `/summary.totalCwu` |
| Живых воркеров | **1** (устройство основателя) | `/worker/status` |
| Режим инференса | **`worker`** — реальная модель, не заглушка | `/health.llm_mode` |
| Автотестов приёмки | **738** (713 + 25), 0 падений | прогон 28.10.2026 |

**Сквозной путь доказан, а не заявлен.** 28.10.2026 телефон в мобильной сети отправил запрос → VPS → домашний ПК исполнителя → Ollama (`qwen2.5-coder:1.5b`) → VPS → телефон. Ответ пришёл от **живой модели**: `llm_mode: worker`, воркер `0xaf34…` онлайн, более 2 000 опросов. Это не стенд на `127.0.0.1` — это мобильная сеть и домашнее устройство.

**Экономика — то, что реально в коде.**

- Базовая ставка: **$0.20 / 1M токенов** (`PRICE_USD_PER_1M_TOKENS = 0.20`).
- Экспертный тир дороже не ценой, а весом: `TIER_WEIGHTS.expert = 4.0` → эффективно **$0.80 / 1M**.
- Комиссия протокола 5%, из неё burn 2.5%, казна 2.5%, роялти LoRA 5%.
- Проверка: `GET /config`.

**Tier 6 (BYOK) — новый слой экономики.** Пользователь вставляет свой ключ провайдера (OpenRouter / Gemini / Groq), вызов идёт напрямую от него, протокол берёт комиссию **0.0005 TAR** и возвращает **кэшбэк 0.0001 TAR**. Остаток комиссии делится 50/50 между сжиганием и казной. Инвариант Tier 6 сходится в ноль. Ворота проверены на живом проде в правильном порядке: нет модели → `400`, нет ключа → `401` **до** любого сетевого вызова, нет денег → `402`, отказ провайдера → `401 PROVIDER_AUTH_FAILED` с именем провайдера.

**Что показывает инвариант сохранения.** Выплаты воркерам (72.116894) плюс сожжённое (0.185113), казна (0.185113) и роялти (0.013300) дают ровно 72.500420 — оборот леджера. Расхождение нулевое на 716 чеках. Это не декларация, а проверяемое тождество: любой может пересчитать его из двух публичных endpoint'ов.

**Чего у нас пока нет — прямо и без оговорок.**

1. **Сеть из одного узла.** `active_workers: 1` — это устройство основателя. Механика режима `worker` работает и доказана сквозным тестом, но второго независимого исполнителя нет. Честная формулировка: «протокол работает, сеть состоит из одного узла».
2. **Комитет валидаторов не набран.** Требуется 5 независимых валидаторов со стейком 10 TAR каждый — **50 TAR заблокированного стейка**. Сейчас 0 членов, гейт работает в вырожденном режиме самопроверки. Это вопрос денег, а не кода.
3. **P2P только на localhost.** Три узла маршрута слушают `ws://127.0.0.1`, `announced_public: false`. Криптография настоящая (RSA-OAEP + AES-256-GCM, 3 хопа), распределённости нет.
4. **Обучение не идёт.** Knowledge Loop: `phase: 2.5 [SPEC / ROADMAP]`, `training.implemented: false`, причина — нужен GPU. Адаптеры в статусе `pending_gpu`.
5. **Токен пока без опоры в спросе.** **90.27%** награды — эмиссия (65.098459 TAR) против **9.73%** из комиссий (7.018435 TAR). На 1 TAR платного спроса приходится **9.28 TAR** напечатанных. Это главная незакрытая проблема экономики.
6. **Tier 6 проверен одной сделкой.** `tier6_calls: 1` — 28.10 17:03 MSK прошёл успешный вызов с живым ключом OpenRouter (`fee 0.0005 = cashback 0.0001 + burn 0.0002 + treasury 0.0002`, `funded_by: client`, `delta: 0`). Выборка из одного запроса не показывает поведение под нагрузкой: лимиты провайдера, параллельные резервы и TTL на реальном трафике не проверялись.

**Аудит 8 компонентов видения:** **2 ✅ / 3 ⚠️ / 3 ❌ (~44%)** по методике `docs/VISION-8-COMPONENTS.md` (✅ = 1, ⚠️ = 0.5). Не ~62%: 62.5% выходит, только если ⚠️ считать полным ✅.

**Почему это всё же интересно.** Ядро — криптография, леджер и экономика — проверяемо сегодня: 716 чеков, нулевое расхождение, 738 автотестов, воспроизводимая приёмка одной командой, сквозной инференс через мобильную сеть. Отсутствует не протокол, а его рынок: устройства. Это разница между «мы построили сеть» (неправда) и «мы построили работающий протокол, которому нужна сеть» (правда, и её можно проверить).

**The Ask.** $150K pre-seed за 5–10% токенов — на подключение первых исполнителей, комитет валидаторов и GPU-обучение адаптеров.

---

## EN

### TarNet / Synapse — a working protocol that just got its first executor

**What it is.** A decentralized compute network for LLM inference: device owners serve requests and earn `$TAR`, while the protocol keeps an independent ledger of verified work (dPoUW) with a checkable conservation-of-value invariant.

**State as of 28 Oct 2026, 16:30 MSK** (build `2.12.4-tier6-dos-fix`, ledger schema `2.1.0-dpouw`, tag `v2.13.0-tier6-byok`):

| Metric | Value | Source |
|---|---|---|
| Completed units of work | **716** receipts | `/summary.receipts` |
| Addresses with payout history | **83** | `/summary.workers` |
| Paid to workers | **72.116894 TAR** | `/summary.totalRewardTar` |
| Total ledger turnover | **72.500420 TAR** | `/health.conservation.gross` |
| Conservation invariant | **delta 0**, `holds: true`, 0 inconsistent rows | `/health.conservation` |
| Total accounted work | **740,195,558 CWU** | `/summary.totalCwu` |
| Live workers | **1** (founder's device) | `/worker/status` |
| Inference mode | **`worker`** — a real model, not a stub | `/health.llm_mode` |
| Acceptance assertions | **738** (713 + 25), 0 failures | run of 28 Oct 2026 |

**The end-to-end path is proven, not claimed.** On 28 Oct 2026 a phone on a mobile network sent a request → VPS → the executor's home PC → Ollama (`qwen2.5-coder:1.5b`) → VPS → phone. The answer came from a **live model**: `llm_mode: worker`, worker `0xaf34…` online with over 2,000 polls. This is not a `127.0.0.1` bench — it is a mobile network and a home device.

**Economics — what is actually in the code.**

- Base rate: **$0.20 / 1M tokens** (`PRICE_USD_PER_1M_TOKENS = 0.20`).
- The expert tier is priced by weight, not by a separate rate: `TIER_WEIGHTS.expert = 4.0` → effectively **$0.80 / 1M**.
- Protocol fee 5%, split into burn 2.5%, treasury 2.5%, LoRA royalty 5%.
- Verification: `GET /config`.

**Tier 6 (BYOK) — a new economic layer.** A user supplies their own provider key (OpenRouter / Gemini / Groq), the call goes out on their account, the protocol charges a **0.0005 TAR** fee and returns a **0.0001 TAR** cashback. The remainder splits 50/50 between burn and treasury. The Tier 6 invariant sums to zero. Gates were verified on live production in the correct order: no model → `400`, no key → `401` **before** any network call, no funds → `402`, provider rejection → `401 PROVIDER_AUTH_FAILED` naming the provider.

**What the conservation invariant shows.** Worker payouts (72.116894) plus burned (0.185113), treasury (0.185113) and royalties (0.013300) equal exactly 72.500420 — the ledger's turnover. Zero discrepancy across 716 receipts. This is not a claim but a checkable identity: anyone can recompute it from two public endpoints.

**What we do not have yet — stated plainly.**

1. **A network of one node.** `active_workers: 1` is the founder's device. The `worker` mode works and is proven end-to-end, but there is no second independent executor. The honest phrasing: "the protocol works, the network consists of a single node."
2. **The validator committee is not formed.** It needs 5 independent validators staking 10 TAR each — **50 TAR of locked stake**. There are 0 members today, and the gate runs in a degenerate self-check mode. This is a funding problem, not an engineering one.
3. **P2P is localhost-only.** Three route nodes listen on `ws://127.0.0.1`, `announced_public: false`. The cryptography is real (RSA-OAEP + AES-256-GCM, 3 hops); the distribution is not there.
4. **Training is not running.** Knowledge Loop: `phase: 2.5 [SPEC / ROADMAP]`, `training.implemented: false`, blocked on GPU. Adapters sit in `pending_gpu`.
5. **The token has no demand floor yet.** **90.27%** of rewards are emission (65.098459 TAR) against **9.73%** from fees (7.018435 TAR). Every 1 TAR of paid demand carries **9.28 TAR** printed. This is the main unsolved problem of the economy.
6. **Tier 6 has been exercised exactly once.** `tier6_calls: 1` — one successful call with a live OpenRouter key on 28 Oct 17:03 MSK (`fee 0.0005 = cashback 0.0001 + burn 0.0002 + treasury 0.0002`, `funded_by: client`, `delta: 0`). A single request says nothing about behaviour under load: provider rate limits, concurrent reserves and TTL on real traffic are unverified.

**Eight-component vision audit:** **2 ✅ / 3 ⚠️ / 3 ❌ (~44%)** per the `docs/VISION-8-COMPONENTS.md` methodology (✅ = 1, ⚠️ = 0.5). Not ~62%: 62.5% only appears if ⚠️ is counted as full ✅.

**Why it is still interesting.** The core — cryptography, ledger and economics — is verifiable today: 716 receipts, zero discrepancy, 738 automated assertions, reproducible acceptance in one command, end-to-end inference over a mobile network. What is missing is not the protocol but its market: devices. That is the difference between "we built a network" (false) and "we built a working protocol that needs a network" (true, and checkable).

**The Ask.** $150K pre-seed for 5–10% of tokens — to onboard the first executors, seat the validator committee, and fund GPU training of the adapters.

---

## Пометки для правки

- **Не цитировать:** `$1.50–2.50/M`, `$0.30–0.50/M`, `$2.00/M`, `$330/мес`, `$1.00/M` — цены Whitepaper, в коде не действуют.
- **Не писать «83 узла в сети».** 83 — адреса с историей начислений; живой воркер **один**.
- **Не писать «72.12 TAR распределено» без уточнения.** Это выплаты воркерам; оборот леджера 72.500420.
- **Не писать «сети нет / `active_workers: 0`».** Это устарело 28.10: `llm_mode: worker`, воркер онлайн, сквозной тест пройден.
- **Не ставить старые снимки как текущие.** 705/78/56.55 — снимок 24.10; 716/83/72.12 — снимок 28.10 16:30.
- **Не писать «Tier 6 работает под нагрузкой».** `tier6_calls: 1` — одна сделка с живым ключом. Говорить можно про «вызов проходит и арифметика сходится», нельзя — про поток, лимиты и параллельные резервы.
- **Не писать «713 тестов»** без «+25 mesh» — иначе теряется часть приёмки.
- **Источники для перепроверки:** `GET /health`, `/summary`, `/config`, `/worker/status`, `/knowledge/status`, `/p2p/status`.
