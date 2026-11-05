# 🌐 TARNET & SYNAPSE (SWARM-GRID CORE)
# ЕДИНЫЙ ЭТАЛОННЫЙ СТАНДАРТ АРХИТЕКТУРЫ, ЭКОНОМИКИ И МАНИФЕСТ ПРОЕКТА
**Версия:** 3.4-UNIFIED (Consensus Standard: Gemini + Qwen + OpenClaw)  
**Дата:** 22 октября 2026 г. (ревизия 05.11.2026) | **Сборка живого стенда:** `2.20.0-session-archive` (схема леджера — `2.1.0-dpouw`), сверено 05.11.2026 11:52 MSK  
**Ревизия:** 22.10.2026 — сверка с кодом (6 расхождений устранены, см. Приложение Б) · **24.10.2026** — полный аудит: 5 расхождений (3 занижали проект, 2 завышали), см. Приложение Б.6 · **05.11.2026** — сверка с продом `2.19.2`, см. Приложение Б.11  
**Основатель и Главный Архитектор:** Илья Тарасов  

> ⚠️ **ДИРЕКТИВА ДЛЯ ВСЕХ ИИ-АГЕНТОВ (GEMINI, QWEN, OPENCLAW):** этот документ — **единственный канонический источник истины**. Он объединяет проверенный код Фазы 1 (`OpenClaw v3.3`), интерфейсы (`Qwen v2.4`) и физику роевого ИИ (`Gemini Swarm-Grid`).  
> **Code-First Rule:** работающее на стенде (`порт 3001`) описывается строго по `config.js` и `ledger.js`; всё из Фаз 2, 2.5, 3 и 4 маркируется `[SPEC / ROADMAP]`. Возврат к отозванным мифам (лотерейные билеты, `$330/мес` на офисном CPU, `$3/день` на смартфоне) запрещён.
---

## 0. ДВОЙНАЯ ИДЕНТИЧНОСТЬ И БРЕНДИНГ (DUAL IDENTITY)

| Контур | Имя инфраструктуры | Имя ИИ-ядра | Тикер токена | Где используется |
| :--- | :--- | :--- | :--- | :--- |
| **Публичный (B2C / B2B / UI / PR)** | **TarNet** | **Synapse** | **`$TAR`** | Публичный манифест, интерфейс чата, документация API, питч-дек |
| **Технический (Репозиторий / Ядро)** | **Swarm-Grid** | **Synapse MoE** | **`$GRID` / `TAR`** | Исходный код (`app/*`, `server.js`, `ledger.js`), смарт-контракты, тесты |

---

## 1. КОНЦЕПТУАЛЬНОЕ ЯДРО: ОТКАЗ ОТ МОНОЛИТОВ И ДВУХОСЕВОЙ СЕТЕВОЙ ЭФФЕКТ

### 1.1. Почему Pipeline Parallelism не работает
Разрезание одной модели (70B–405B) по слоям между домашними ПК упирается в **«Стену задержки» (`Latency Wall`)**: авторегрессия требует синхронной пересылки тензоров активаций на каждом токене, и при пинге 20–50 мс ответ замедляется до секунд на слово.

### 1.2. Архитектурный сдвиг
Вместо «распиливания» монолита — **роевая оркестрация автономных SLM (0.5B–7B+, INT4 / Q4_K_M / BitNet)** с доменными `LoRA`-адаптерами. Узел держит модель целиком в локальной памяти и решает узкую подзадачу со скоростью своего чипа.

### 1.3. Двухосевое масштабирование
1. **Compute Scaling:** рост числа узлов линейно увеличивает совокупную пропускную способность для независимых задач:
   $$\text{Throughput}_{\text{Swarm}} \approx \sum_{i=1}^{N} \big(\text{TPS}_i \times \text{Uptime}_i \times \text{Reliability}_i\big) - \text{Overhead}_{\text{routing + crypto}}$$
   Задержка запроса ($t_{\text{routing}} + t_{\text{queue}} + t_{\text{crypto}} + t_{\text{inference}} + t_{\text{response}}$) падает за счёт ликвидации очередей и точного сопоставления `Task Profile ↔ Node Profile`.
2. **Knowledge Scaling:** умнее не от «слепого обучения», а через воронку селекции: `Experience Buffer` $\to$ `Preference Dataset` (DPO) $\to$ ночное дообучение (`Micro-LoRA / MeZO`) $\to$ сжатие адаптера (Trim 80 %, INT8, CSR) $\to$ **Benchmark Gate / Ratchet Rule** с авто-откатом `Rollback`. **TIES-Merging — Фаза 2.5** (требует GPU и реальных адаптеров); в коде его нет, реализовано только сжатие.

---

## 2. ШЕСТИУРОВНЕВАЯ АРХИТЕКТУРА УЗЛОВ (6-TIER HETEROGENEOUS NETWORK)

Отдельной константы цены на тир нет: базовая ставка в коде едина (`PRICE_USD_PER_1M_TOKENS = $0.20`), а стоимость и вознаграждение масштабируются коэффициентом **`κ_tier`**:

| Уровень | Оборудование и стек | Роль | `κ_tier` / цена | Контур | Доходность по Fee (без эмиссии) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Tier 1: Nano** | Смартфоны/планшеты (Snapdragon 8 Gen3+, A17+, NPU); `Rust + Flutter + MLC/CoreML`; только на зарядке, пауза при >38 °C, RAM ≤800 МБ | `Onion Relay`, лёгкая верификация, нано-инференс 0.5B–1.5B | `κ = 0.1`<br>**$0.02 / 1M** | `Private`, `Extended` | **~$0.31 / мес** (25 ток/с, 25% load, ~0.54M ток/сут) |
| **Tier 2: Core** | Домашние ПК, мини-ПК, Mac Mini M1–M4, RTX 3060/4070; `Node.js / Python + llama.cpp + WebSocket` | Роевой инференс 1.5B–7B + LoRA, `Experience Buffer`, сжатие адаптера (Trim/INT8/CSR) | `κ = 1.0` (base)<br>`κ = 4.0` (expert)<br>**$0.20 – $0.80 / 1M** | `Private`, `Extended`, `Enterprise` | **CPU 7B** (12 ток/с, 30%): **$1.77**<br>**RTX 3060** (50, 40%): **$9.85**<br>**RTX 4070** (80, 40%): **$15.76** |
| **Tier 3: Heavy** | GPU-узлы и риги (1×–2× RTX 3090/4090, A5000, HiveOS/RaveOS) | Экспертный инференс 7B–70B + LoRA, `Benchmark Gate`, `Critic-Aggregator` | `κ = 4.0` (expert)<br>**$0.80 / 1M** | `Private`, `Enterprise` | **1× RTX 4090** (120, 50%): **$118.20 / мес**<br>**2× RTX 4090** (240, 50%): **$236.39 / мес** |
| **Tier 4: Client** | Любое устройство (`Synapse Chat` Web/Desktop/Mobile, OpenAI-совместимый SDK) | `DAG Planner`, локальный `PII-фильтр`, сборка ответа, фидбек | Плательщик (`N/A`) | выбор в UI | Скидки стейкинга до 20% + Free Tier за свой вклад |
| **Tier 5: Cloud Anchor** `[SPEC Фаза 3]` | Облачные анклавы (`AWS Nitro`, Confidential VMs) через `Synapse Labs` | SLA 99.99%, пики, модели 70B+ | `κ = 10.0`<br>**$2.00 / 1M**<br>`[SPEC]` — в коде нет | **только `Enterprise`** *(в `Private` запрещён)* | Фиат по SLA + обязательный `Buyback & Burn $TAR` |
| **Tier 6: External API** `[SPEC Фаза 2.5]` | Внешние API (`Gemini`, `OpenAI`, `Claude`, `DeepSeek`) по ключу пользователя (`BYOK`) | Мета-оркестрация (`Best-of-Breed`) для не-PII задач | по тарифу провайдера | **только `Extended`** *(бинарный structured-PII гейт: совпадение → `422`, см. §Б.8 и `docs/PII-DECISION.md`)* | `$TAR`-потребление: **ставка B′ — `ORCHESTRATION_FEE_TAR: 0.0002`** (кэшбэк `0.0001`), с 2.17.8. ~~5% Orchestration Fee (2.5% + 2.5%)~~ — **устарело**, это доля от fee, а не фиксированная сумма TAR |

> **Сноска к Tier 3.** Тир «heavy» (`κ = 10.0` → `$2.00/1M`) и доход `$330+/мес` **в коде отсутствуют**: `TIER_WEIGHTS = { nano: 0.1, base: 1.0, expert: 4.0 }`, потолок — `$0.80/1M`. Даже при `κ = 5.0` 2× RTX 4090 дают **$295.49/мес**, а не `$330`. Tier 3 Heavy (70B) — Фаза 3 `[SPEC]`, отдельный тариф по рыночному прайсу. Повышение `κ` — решение владельца, а не факт кода. ~~Tier 6 в коде отсутствует (grep `tier6|orchestration|byok` → 0 совпадений).~~ **[устарело, см. §Б.8]** Tier 6 реализован: таблицы `tier6_calls` / `tier6_receipts` / `tier6_reserves`, `reserveTier6Fee` (`server.js:1747`, вызов `6246`); на 30.10 — `conservationTier6 {calls:12, holds:true}`.

---

## 3. ТРИ ИЗОЛИРОВАННЫХ ПРОДУКТОВЫХ КОНТУРА (PRIVACY CIRCUITS)

| Продукт | Разрешённые узлы | Приватность и правила PII | Назначение |
| :--- | :--- | :--- | :--- |
| **1. Synapse Private** | строго Tier 1–3 | Обязательный `Onion Routing` + `TEE` + шифрование обратного пути (`response_aes_key`). **PII разрешены**, данные не покидают рой | Частные лица, юристы, врачи, разработчики — максимум защиты |
| **2. Synapse Extended** | Tier 1–3 + Tier 6 (BYOK) | Tier 6 по TLS **только если structured-PII гейт не нашёл совпадений** (карта, IBAN, SSN, email, IPv4, телефон) и есть явное согласие в UI | Единое окно: приватное — в рой, открытый код/креатив — во внешний API |
| **3. Synapse Enterprise** | Tier 1–3 + Tier 5 Cloud (+ Tier 6 по политике) | SLA 99.99%, `Direct Encrypted Channel` в облачные TEE, аудит, маркировка `Processed by Cloud Anchor` | B2B и корпорации, оплата в фиате через `Synapse Labs` (GDPR Data Controller) |

> **Инвариант безопасности (приведён к коду 30.10).** Гейт Tier 6 **бинарный**: структурный regex нашёл совпадение → `422 PII_BLOCKED`, не нашёл → запрос идёт дальше. Порога `0.95` в решении нет: `LLM.piiCheck` (`llm-adapter.js:42`) возвращает `confidence` 0 или 1 и сравнивает только наличие совпадений. Поле `required_confidence: 0.95` в теле `422` — унаследованное и вводит в заблуждение. Имена в свободном тексте **не блокируются** (NER не поднят, см. `docs/PII-DECISION.md`). Смешивание трафика `Private` и `Extended/Enterprise` в одном графе запрещено.

### 3.1. Хранение промптов при дистилляции (`[SPEC Фаза 2.5]`)

Промпты хранятся на сервере только для opt-in пользователей (по умолчанию выключено), зашифрованы AES-256-GCM и используются исключительно для улучшения сети. Отзыв согласия — `DELETE` из `distillation_buffer`.

**Чего это обещание НЕ означает.** Сервер способен расшифровать промпт — иначе обучение невозможно, ключ у него. Формулировка «мы не можем прочитать ваш промпт» **ложна** и в материалах запрещена. Верная: «мы не храним его, если вы не разрешили, и удаляем по вашему требованию».

**Статус в коде:** таблицы `distillation_buffer` **нет** — Фаза 2.5. Работает только `pii-classifier.js`: regex-ветка; ONNX NER — при `TARNET_PII_ONNX=1`, по умолчанию `ready: false`.

---

## 4. ДЕЙСТВУЮЩЕЕ ЯДРО ФАЗЫ 1 (`2.22.0-p2p-peer-auth`) — ЧТО РЕАЛЬНО РАБОТАЕТ В КОДЕ СЕГОДНЯ

Проверяется запросами к `localhost:3001` и прогоном `node test-dpouw.js --test` (**1103 проверки, 0 провалов**) и `node test-mesh.js` (**25 проверок, 0 провалов**) и `node proof-treasury-gate.js` (**13 проверок, 0 провалов**), итого **1130**, снимок 05.11.2026 15:45 (§Б.13). Исторические цифры: на 05.11 днём — **1091 + 25 + 13 = 1129** (§Б.12), на 05.11 утром — **1086 + 25 + 13 = 1124** (§Б.11), на 02.11 — **988 + 25 + 12 = 1025** (§Б.9), на 30.10 — **987 + 25 + 12 = 1024**, на 29.10 — **980 + 25 = 1005**. Флаг `--test` поднимает изолированный сервер на временной БД (`mktemp`) с отдельным `TARNET_SECRETS_DIR` и свободным портом: приёмка не требует запущенного стенда и не затрагивает его БД. Адреса и `actionId` уникальны по суффиксу `RUN`, поэтому прогон воспроизводим.

### 4.1. Матрица живой функциональности

| Компонент | Статус `2.22.0-p2p-peer-auth` | Проверка |
| :--- | :--- | :--- |
| Реестр узлов, стейк, репутация | ✅ работает | `GET /nodes`, `POST /node` |
| Антимонопольный роутинг `√stake × reputation` | ✅ работает | `routingWeight` в `POST /inference` |
| Детерминированный учёт работы (dPoUW) | ✅ работает, лотереи удалены | `POST /work` → `GET /receipt/:worker` |
| Подпись чеков Ed25519 | ✅ работает (`node:crypto`) | `POST /receipt/verify` |
| Ключи в БД at rest | ✅ `AES-256-GCM` | `ledger.js` |
| Двойная запись, балансы, списание с клиента | ✅ `debit()` + `credit()` | `GET /balances`, `GET /ledger` |
| Инвариант сохранения стоимости | ✅ `delta === 0`, `holds: true` | `GET /health` → `conservation` |
| Суточные эпохи, непрерывное затухание эмиссии, потолок чека 25% | ✅ работает | `GET /epoch` |
| Аудит качества (5% работ) | ✅ выбор по хешу `actionId` (для клиента с ключом idемпотентности и отпечаток spot-check — одна и та же строка) | `ledger.js` -> `economics.js` |
| LoRA-адаптеры и роялти 5% | ✅ 3 фикстуры по доменам, роялти начисляется автору | `GET /adapters`, `totalLoraRoyaltyTar` |
| Батчинг коротких работ | ✅ порог генерации чека — `max(50, tokens_for_nonzero_payout(tier))`: `base` = 50, `nano` = 500, `expert` = 13. Работы ниже порога копятся в `pending_work` и объединяются в следующий чек | `POST /work` → `202 {queued, pending_work, threshold}`; чек несёт `batchedFrom[]` |
| Идемпотентность `actionId` | ✅ работает: `POST /work` — ключ, а не подсказка. Повтор → `200 {duplicate:true, existing:'receipt'}` (тот же `seq`, без второго начисления); повтор короткой работы → `202 {reason:'already_pending'}`, накопление не удваивается; повтор работы из `batchedFrom` → тот чек, `batchedInto = seq`; тот же ключ на другого воркера → `409`; без `actionId` ключа нет — два одинаковых запроса дают две работы | `POST /work` → раздел 8.11 приёмки |
| Soft delete адаптеров | ✅ `DELETE /adapter/:id` ставит `deleted_at`; физического удаления нет, история роялти цела, новые работы → 409 | `GET /adapters` → `deleted_at`; чек несёт `adapterDeletedAt` |
| Реальный LLM-инференс | ⚠️ **механика работает, сеть не постоянна**: на замере 29.10 14:41 — `active_workers: 1`, `llm_mode: worker` (воркер `0xe56c…`, `qwen2.5-coder:1.5b`, 4343 опроса). Окно жизни воркера — 60 с, поэтому «сейчас 1» не значит «сеть». Это по-прежнему **один узел, включаемый руками** | `GET /worker/status`, `GET /health` → `llm_mode`. Сквозной путь доказан 28.10 (телефон → VPS → дом → Ollama) |
| **Внутренняя утилизация токена (`TAR_UTILITY`)** | ✅ **в коде с 2.17.0**: `paymentMode: TAR_UTILITY` в `POST /work` и `/inference` списывает **2%**, поровну в burn и казну. **Ставка берётся НЕ из `TAR_UTILITY_FEE_BPS`:** эта константа объявлена в `config.js:129`, но не читается нигде (`grep` по всему репо → 1 вхождение, само объявление). Рабочие константы — `TAR_UTILITY_BURN_RATE: 0.01` + `TAR_UTILITY_TREASURY_RATE: 0.01` (`config.js:130-131`), единственное место применения — `economics.js:115-116` | `economics.js:115-116`; ~~`config.js:122-124`; `server.js:2215, 4698, 6940`~~ **ссылки протухли 03.11: 2215 = `below_min_payout`, 4698 = `license_restricted`, 6940 = fallback-цепочка моделей, ни одна не про ставку**; приёмка 43.14. **[срез 03.11]** `totalUtilizedTar: 1.2e-05`, `totalUtilizedCount: 3` — механизм сработал трижды |
| **Подпись `POST /work`** | ✅ **в коде с 2.17.15**: Ed25519 над `TARNET_WORK_SUBMIT:<address>:<tokens>:<tier>:<actionId>:<ts>`; без подписи — `403 HANDSHAKE_REQUIRED`. **Это НЕ JCS (RFC 8785):** `grep -c 'canonicalize\|JCS\|8785'` по коду → **0**, канонизации JSON нет, подпись считается над позиционной склейкой через `:` | `server.js:4984-5025` |
| **Входящий WS воркера (`/p2p/worker`)** | ✅ **в коде с 2.17.0**: `ws-inbound.js` — Ed25519-хендшейк с nonce (`AUTH_PREFIX = TARNET_WS_AUTH`), TOFU по адресу (`ADDRESS_KEY_MISMATCH` при подмене ключа). Воркер держит **исходящее** соединение и получает задачу кадром `TASK`, фолбэк на `/worker/poll` сохранён | `ws-inbound.js`; `worker-demo.js:671` (`new WebSocket`); `GET /worker/ws`. Портов воркер не открывает → `registry.total: 0` остаётся верным |
| Onion Routing | ✅ работает: `onion.js` (289 строк) — RSA-2048-OAEP-SHA256 шифрует 32-байтный ключ AES, нагрузка идёт AES-256-GCM; TTL слоя, защита от replay, шифрование обратного пути. `app/` — полная PWA (веб-манифест, service worker, 3 иконки). Остаётся: `archive/python-app/crypto.py` — `Wallet`, `generate_wallet()`, `sign_message()` на **SHA-256** (хеш-заглушка, **не Ed25519**) | `POST /inference/onion` → `delivered: true`, `hops: 3`; `test-mesh.js` → 25 ✅ |
| Аппаратная проверка TEE Quote | ⏳ Фаза 2–3, в БД лишь флаг `isTeeAttested` | `nodes.isTeeAttested` |
| Смарт-контракты L1/L2 и DAO | ⏳ `[SPEC]`, **0 файлов `.sol`**, письменной спеки нет | `/settlements` — синтетический `txHash` |

**Адаптеры.** 3 фикстуры (`lora-coder-v1` / `lora-math-v1` / `lora-medical-v1`) сеются при старте для проверки роялти по доменам. Публичная регистрация — Фаза 2 `[SPEC]`: маршрут `POST /adapter` есть, но реестра авторов, валидации качества адаптера и антифрода в нём нет.

### 4.2. Канонические формулы экономики (из `config.js` и `ledger.js`)

1. **Единица полезной работы (CWU):**
   $$W_i = N_{\text{tokens}} \times \kappa_{\text{tier}} \times \gamma_{\text{verify}}, \qquad \gamma \in \{0, 1\}$$
   Расширение ($0.25N_{\text{in}} + 1.0N_{\text{out}}$ и доменный $\delta_{\text{domain}}$) — RFC Фазы 2, в `2.17.0-ws-utility` не применяется, чтобы не искажать инвариант эмиссии.

2. **Двухпоточная награда (`Dual-Stream`):**
   $$\text{Reward}_i = \text{Fee\_Reward}_i + \text{Block\_Reward}_i$$
   $$\text{Fee\_Gross}_i = \frac{W_i \times \text{PRICE\_USD\_PER\_1M}}{10^6 \times \text{USD\_PER\_TAR}}, \qquad \text{Fee\_Reward}_i = \text{Fee\_Gross}_i \times (1 - \phi)$$
   $$E_{\text{epoch}}(t) = E_0 \cdot 2^{-t / T_{\text{halving}}}, \qquad \omega_i = \sqrt{\text{Stake}_i} \times \text{Reputation}_i$$
   $$\text{Block\_Reward}_i = \min\!\left( E_{\text{epoch}} \cdot \frac{W_i \omega_i}{\sum_k W_k \omega_k},\; E_{\text{epoch}} \cdot \text{MAX\_RECEIPT\_SHARE\_OF\_EPOCH} \right)$$

3. **Константы `config.js`:**
   * `PRICE_USD_PER_1M_TOKENS = 0.20` — базовая цена и Protocol Price Floor.
   * `USD_PER_TAR = 20` (**1 TAR = $20**; сумма в USD делится на 20).
   * `TIER_WEIGHTS = { nano: 0.1, base: 1.0, expert: 4.0 }` → `$0.02 / $0.20 / $0.80` за 1M.
   * `PROTOCOL_FEE_RATE (φ) = 0.05`: `BURN_RATE = 0.025` сжигается навсегда + `TREASURY_RATE = 0.025` в казну.
   * `LORA_ROYALTY_RATE = 0.05` — 5% **от `Fee_Reward`** автору адаптера; с `Block_Reward` роялти не берётся.
   * `INITIAL_BLOCK_REWARD (E_0) = 50 TAR/сут`, `HALVING_PERIOD_EPOCHS = 365`. **Это не ступенчатый халвинг, а непрерывное затухание:** `E(epoch) = 50 × 2^(-epoch/365)` (`economics.js:85`). На эпохе 368 — 24.86 TAR, на 373 — 24.62 TAR; значения меняются каждую эпоху, а не скачком раз в 365.
   * `MAX_RECEIPT_SHARE_OF_EPOCH = 0.25` — потолок одного чека, защита пула от захвата первым чеком суток.
   * `DECIMALS = 6` — точность расчётов, гарантирует `delta === 0`. `MIN_RECEIPT_TOKENS = 50` — нижняя граница порога.
   * **Батчинг:** порог генерации чека — `max(50, tokens_for_nonzero_payout(tier))`. Для `base` это 50, для `nano` — 500, для `expert` — 13. Работы ниже порога накапливаются в `pending_work` и объединяются в следующий чек. Ключ накопления — воркер + тир + адаптер: `W_i = tokens × κ`, поэтому 45 токенов `nano` и 5 `expert` — не 50 эквивалентных токенов, смешение занизило бы выплату в κ раз. Причина порога — `round(DECIMALS)`: при `κ = 1.0` граница ненулевой выплаты ровно на 50 токенах, при `expert` — 13, при `nano` — 500.

4. **Замкнутый цикл (`Earn → Spend`).** При `POST /inference` с `clientAddress` списывается `100% Fee_Gross`: исполнителю `95%` (или `90.25%` с роялти), протоколу `5%` (`2.5% Burn + 2.5% Treasury`). Полный круг самопотребления стоит ровно **5%**. Доли эмиссии и оплаты **не константы** — считать из `/summary` в момент публикации: `totalBlockRewardTar / totalRewardTar` и `totalFeeRewardTar / totalRewardTar`. По мере затухания эмиссии сеть переходит на 100% обеспечение платящим спросом.

---

## 5. ТЕХНИЧЕСКАЯ АРХИТЕКТУРА CORE-МОДУЛЕЙ (ФАЗА 2 — СПЕЦИФИКАЦИЯ РАЗРАБОТКИ)

### 5.1. Нативный безгазовый DAG-леджер (`PoUWReceipt`)

**Статус: реализовано.** Подписанные Ed25519-чеки и связывание в цепочку работают (`ledger.js`). Хеш-цепочка `prevReceiptHash` / `receiptHash` **реализована**: модуль `dag-chain.js`, колонки добавляются через `ensureColumn` и пишутся при выпуске чека (`server.js`), `cumulativeCwu` / `cumulativeTar` считаются независимо от накопленных итогов.

Целостность держится **на двух механизмах сразу**: `prevSignature` предыдущего чека воркера входит в подписываемый payload (`receiptPayload()`), а `prevReceiptHash` связывает чеки по хешу. Чеки, выпущенные после Волны 2, несут `payloadVersion: 2` — хеш-сцепка внутри подписи. **Остаточное ограничение, которое нельзя замалчивать:** исторические чеки на `payloadVersion: 1` проверяются только сравнением с хранимым `receiptHash`, их подписи не перевыпускаются (история append-only). DAG-ветвления (несколько родителей) по-прежнему нет — цепочка линейна.

**Фактическая структура чека (по `ledger.js` → `decorate()`), проверено `GET /receipt/:worker`:**

```typescript
interface PoUWReceipt {          // ФАКТ: build 2.19.2-p0-p1-security
  seq: number;                   // глобальный монотонный счётчик
  workerId: string;              // дубль workerAddress для API
  workerAddress: string;
  cwu: number;                   // N_tokens × κ_tier × γ_verify
  tier: 'nano' | 'base' | 'expert';   // 'heavy' в коде НЕТ
  feeGrossTar: number;
  feeRewardTar: number;
  blockRewardTar: number;
  rewardTar: number;             // итог исполнителю
  cumulativeTotal: number;       // нарастающий итог по воркеру
  burnTar: number;               // 2.5% от feeGrossTar
  treasuryTar: number;           // 2.5% от feeGrossTar
  royaltyTar: number;            // 5% от feeRewardTar
  epoch: number;
  omega: number;                 // √stake × reputation
  share: number;                 // доля в пуле эпохи
  adapterId: string | null;
  actionId: string | null;
  timestamp: number;             // мс epoch
  prevSignature: string;         // фактическая связь с предыдущим чеком
  signature: string;             // Ed25519
  signatureAlg: 'ed25519';
  batchedFrom: string[];         // actionId слитых коротких работ (вне payload)
}
```

**Хеш-поля реализованы, отсутствуют два поля учёта.** `prevReceiptHash` и `receiptHash` пишутся в БД и входят
в подпись у чеков `payloadVersion: 2` (`dag-chain.js`). Чего в коде нет:

```typescript
interface PoUWReceiptV2 {        // ЧАСТИЧНО: хеши есть, поля ниже — нет
  prevReceiptHash: string;       // ✅ SHA-256 предыдущего чека (dag-chain.js)
  receiptHash: string;           // ✅ SHA-256 текущего чека (dag-chain.js)
  clientAddress?: string;        // ❌ не хранится — [SPEC / ROADMAP]
  tokensGenerated: number;       // ❌ не хранится (только cwu) — [SPEC / ROADMAP]
}
```
## ПРИЛОЖЕНИЕ Б. ЖУРНАЛ СВЕРКИ С КОДОМ (РЕВИЗИЯ 22.10.2026)

Ревизия по директиве владельца: каждое утверждение приведено к коду либо помечено `[SPEC / ROADMAP]`. **Константы экономики (`κ`, цены, `φ`, роялти) не изменялись** — расхождения исправлены на стороне документа.

### Б.1. Устранённые расхождения

| № | Было | Стало | Доказательство |
| :-- | :--- | :--- | :--- |
| 1 | Tier 3: `κ = 10.0` (heavy), `$2.00/1M` | `κ = 4.0` (expert), `$0.80/1M`; heavy → `[SPEC]` | `TIER_WEIGHTS = {nano:0.1, base:1, expert:4}`; grep «heavy» → 0 |
| 2 | Onion Routing «готов в Python (`app/crypto.py`)» | ⏳ `[SPEC / ROADMAP]` **на 22.10**; ⚠️ факт обновлён 24.10 — см. Б.6 (в Node `onion.js` реализован) | каталога `app/` нет **на 22.10** `[снимок 22.10; на 30.10 — `app/app.js` 2626 строк, `GET /app/` → 200, см. §Б.8]`; `archive/python-app/crypto.py` — `Wallet`, `generate_wallet()`, `sign_message()` на SHA-256 |
| 3 | Контракты «спецификация готова (Solidity)» | ⏳ `[SPEC / ROADMAP]` | `find -name '*.sol'` → **0 файлов** |
| 4 | `prevReceiptHash` / `receiptHash` (DAG) | ✅ **закрыто 24.10:** `dag-chain.js` + `server.js` пишут хеш-поля | `receiptPayload()` включает `prevSignature`; `payloadVersion: 2` несёт хеш-сцепку внутри подписи |
| 5 | 2× RTX 4090 «$330+/мес при `κ=5.0`» | **$236.39** при `κ=4.0`; при `κ=5.0` → `$295.49` (см. Б.2) | `240 × 0.5 × 86400 × 30 / 1e6 × $0.20 × κ × 0.95` |
| 6 | Tier 6 «5% Orchestration Fee» как факт | ~~`[SPEC]`, Tier 6 в коде нет~~ **[устарело, см. §Б.8]**: Tier 6 в коде с 2.12.0 | ~~grep → 0~~; на 30.10 `grep tier6` → 5 файлов, `conservationTier6.calls: 12` |

### Б.2. Пересчёт доходности Tier 3

`ток/мес × $0.20 × κ × (1 − φ)`, где `φ = 0.05`, `ток/мес = TPS × duty × 86400 × 30`:

| Конфигурация | TPS | duty | κ | Доход/мес |
| :--- | --: | --: | --: | --: |
| 1× RTX 4090 | 120 | 50% | 4.0 | **$118.20** |
| 2× RTX 4090 | 240 | 50% | 4.0 | **$236.39** |
| 2× RTX 4090 (гипотеза) | 240 | 50% | 5.0 | **$295.49** — всё ещё `< $330` |

`$330+/мес` неверно даже при повышенном `κ`. Повышение `κ.expert` до `5.0` — решение владельца, в коде не применено.

### Б.3. Сверка с живым стендом

Замер `24.10.2026 20:45 MSK`, `localhost:3001` на боевом VPS (он же `https://v1107336.hosted-by-vdsina.com`), сборка `2.12.0-tier6-byok` (commit `3ff5034`, схема `2.1.0-dpouw`). Всё ниже — **снимок, а не константа**: в отчётах пересчитывать из `/summary`.

> **Сноска о среде замера.** `localhost:3001` — это стенд на VPS. Локальная dev-копия на машине агента слушает тот же порт, но у неё **другая база**: при сверке 24.10 утром там было `688` чеков и `37.925244 TAR` против боевых `702` и `50.237216`. Снимать цифры для документа с dev-копии нельзя — они уедут в отчёт как боевые.

| Источник | Значение |
| :--- | :--- |
| `GET /config` | `tierWeights {nano:0.1, base:1, expert:4}` · `price {usdPer1MTokens:0.2, usdPerTar:20}` · `fee {protocol:0.05, burn:0.025, treasury:0.025, loraRoyalty:0.05}` · `decimals:6` · `minReceiptTokens:50` |
| `GET /health` | `conservation {gross:56.929946, distributed:56.929946, delta:0, holds:true, inconsistentRows:0}` · эпоха `368` · `buildVersion 2.12.0-tier6-byok` · `active_workers: 0`, `llm_mode: deterministic_fallback` |
| `GET /health` | `conservationTier6 {calls:0, gross:0, distributed:0, delta:0, holds:true, fundedByClient:0, fundedByEmission:0}` |
| `GET /summary` | чеков `705` · воркеров `78` · CWU `739 193 616` · выплачено `56.546920 TAR` |
| `GET /summary` | Fee `7.008914` (**12.4%**) · Block `49.538006` (**87.6%**) · сожжено `0.184863` · казна `0.184863` · settlements `17` |
| `GET /p2p/status` | 3 узла, у каждого блок `stats` (`framesIn/framesOut/requests/responses/dropped/replays`) |
| `GET /adapters` | 3 фикстуры (`code` / `math` / `medical`), `totalLoraRoyaltyTar: 0.0133` |
| Автотесты | ~~`node test-dpouw.js --test` → **624 ✅ / 0 ❌** · `node test-mesh.js` → **25 ✅ / 0 ❌** — итого **649**~~ **[устарело, см. §Б.8]** На 30.10: **987 ✅ / 0 ❌** + **25 ✅ / 0 ❌** + **12 ✅ / 0 ❌** = **1024** |

Доля эмиссии — не константа: `totalBlockRewardTar / totalRewardTar` из `/summary` в момент публикации (для доли оплаты — `totalFeeRewardTar / totalRewardTar`).

### Б.4. Правило для последующих ревизий

1. Цифры §4 проверяются запросом к `localhost:3001` **в день публикации**; вчерашние — исторические.
2. Наличие кода подтверждается `grep`/`find` по `backend-api/`, а не ссылкой на документ.
3. Поле, которого нет в `decorate()` (`ledger.js`), не описывается как существующее — только `[SPEC / ROADMAP]`.
4. Изменение `κ`, цен, `φ` или роялти требует решения владельца и правки `config.js`, а не только документа.

### Б.5. Changelog сверки

- **2026-10-22** — аудит OpenClaw: 6 расхождений закрыто (см. Б.1). `crypto.py` подписывает SHA-256, а не Ed25519; тир `heavy` вынесен в Фазу 3, `κ = 10.0` в код не добавлен.
- **2026-10-22 (actionId)** — 89/89 тестов. Исправлено расхождение кода и API: `POST /work` принимал `actionId`, но не передавал его в `recordWork()`, поэтому ключ терялся и клиент не мог получить ни дубликат-защиты, ни повтора. Теперь `actionId` доходит до ядра и работает как ключ идемпотентности (см. §4.1); поиск идёт по трём местам — `work_receipts.actionId`, `work_receipts.batchedFrom`, `pending_work.actions` — иначе повтор уже слитой короткой работы выпустил бы второй чек. `POST /inference` и `POST /batch-test` не менялись: первый ключа не принимает, второй передаёт свой. Живой стенд: `conservation delta 0`.
- **2026-10-22 (batching)** — 69/69 тестов. Батчинг коротких работ: `MIN_RECEIPT_TOKENS = 50`, `pending_work`, `batchedFrom`; порог per-tier `base = 50`, `nano = 500`, `expert = 13`. 3 фикстуры адаптеров с доменами. Удалено 2 тестовых адаптера; 6 чеков ссылаются на них — исторически корректно, роялти выплачены, инвариант сохранён. Введён soft delete (`deleted_at`, `DELETE /adapter/:id`, снимок `adapterDeletedAt` в чеке); физическое удаление запрещено. Приёмка `--test` изолирована: чистая БД, рабочая не затрагивается.

### Б.6. Аудит 24.10.2026 — расхождения, найденные после ревизии 22.10

Ревизия 22.10 искала только завышения. Полный аудит 24.10 нашёл расхождения **в обе стороны**: три места
**занижали** проект (функция работала, а документ объявлял её отсутствующей), два — **завышали**.

| # | Что утверждал документ | Факт кода на 24.10 | Направление |
| :--- | :--- | :--- | :--- |
| 1 | Onion Routing — `[SPEC]`, «каталога `app/` нет» | `onion.js` 289 строк, RSA-OAEP + AES-256-GCM, 3 хопа; `app/` — полная PWA | 📉 занижал |
| 2 | `prevReceiptHash` / `receiptHash` «в коде отсутствует (grep → 0)» | `dag-chain.js` есть, колонки пишутся, чек `#696` несёт реальные хеши при `payloadVersion: 2` | 📉 занижал |
| 3 | Схема стенда `2.1.0-dpouw`, 369 проверок | `2.12.0-tier6-byok`, 649 проверок (624 + 25) **[историч. снимок 24.10; на 30.10 — 1024, см. §Б.8]** | 📉 занижал |
| 4 | Реальный LLM-инференс ✅ `source: live_llm` | `llm_mode: deterministic_fallback`, `active_workers: 0` | 📈 завышал |
| 5 | Tier 5 / Tier 6 как часть архитектуры | ~~в коде отсутствуют~~ **[устарело, см. §Б.8]**: Tier 6 в коде есть, 12 вызовов на 30.10 | 📈 завышал (на дату 24.10) |

**Следствие для позиционирования.** Проект — не «работающая сеть роевого ИИ», а **работающий протокол,
ожидающий сети исполнителей**. Ядро экономики и криптографии проверяемо; распределённого инференса нет.
Формулировка «мы не можем прочитать ваш промпт» остаётся запрещённой (см. §3.1).

**Что осталось незакрытым в коде, а не в документе:** `active_workers: 0`; P2P только на `localhost`, приём потока задач защищён подписью
(3 узла на одной машине, `framesIn: 0`); комитет валидаторов — 0 членов при `REQUIRED_COMMITTEE_SIZE = 5`
и `VALIDATOR_STAKE_LOCK_TAR = 10` (нужно 50 TAR стейка); 86.2% награды — эмиссия при 13.8% fee;
0 файлов `.sol`; GPU-обучения нет (`pending_gpu`).

### Б.7. Аудит 29.10.2026 — сверка всех документов с кодом и продом

Срез `29.10.2026 14:41 MSK`, стенд `https://v1107336.hosted-by-vdsina.com`, сборка `2.17.0-ws-utility`.
Проверено (снимок 29.10): `node test-dpouw.js --test` → ~~**980 ✅ / 0 ❌**~~ → **[устарело, см. §Б.8]** на 30.10 — **987 ✅ / 0 ❌**; `node test-mesh.js` → **25 ✅ / 0 ❌**; `proof-treasury-gate.js` → **12 ✅ / 0 ❌**.

| Источник | Значение |
| :--- | :--- |
| `GET /health` | `buildVersion 2.17.0-ws-utility` · `conservation {gross:80.772805, distributed:80.772805, delta:0, holds:true, inconsistentRows:0}` · `active_workers: 1`, `llm_mode: worker` |
| `GET /health` | `conservationTier6 {calls:9, gross:0.0045, distributed:0.0045, delta:0, holds:true, fundedByClient:9, fundedByEmission:0}` |
| `GET /health` | эпоха `373` · выпущено `24.623064` · роздано `8.228295` · невостребовано `5.109733` · `halvingPeriodEpochs: 365` |
| `GET /summary` | чеков `750` · воркеров `90` · CWU `744 298 062` · выплачено `80.387229 TAR` |
| `GET /summary` | Fee `7.057418` (**8.78%**) · Block `73.329811` (**91.22%**) · сожжено `0.186138` · казна `0.186138` · роялти `0.0133` |
| `GET /summary` | `burnAudit.holds: true` · `treasuryAudit.holds: true` · `treasuryBalanceTar: 0.1947` · `onchainSettlements: 17` · `onchain.simulated: true` |
| `GET /summary` | ~~`totalUtilizedTar: 0`~~, `totalUtilizedCount: 0` **[устарело, см. §Б.8]** — на 30.10 `totalUtilizedTar: 0.00001`, `totalUtilizedCount: 1` |
| `GET /models` | **18** моделей: 15 облачных у 8 вендоров + 3 локальные (`provider: local` считается отдельной строкой → 9 значений `provider`) |
| `GET /worker/status` | `active_workers: 1`, `mode: worker`, воркер `0xe56c…`, `qwen2.5-coder:1.5b`, 4343 опроса |

**Что изменилось против Б.6.** Механизм утилизации токена, объявленный отсутствующим в 24.10, **появился в коде**
(`TAR_UTILITY`, 2%, `config.js:122-124`) — и на 30.10 сработал один раз (`totalUtilizedTar: 0.00001`, см. §Б.8). Входящий WS
воркера (`/p2p/worker`, `ws-inbound.js`) добавлен в 2.17.0: `registry.total: 0` по-прежнему верен, потому что
воркер не открывает портов, а держит исходящее соединение.

**Что не изменилось.** Сеть — один узел, включаемый руками: `active_workers: 1` на замере не означает
постоянного исполнителя (окно жизни 60 с). `registry.total: 0` — ни одного узла с внешним адресом.
Комитет валидаторов — 0 членов. `0` файлов `.sol`. GPU-обучения нет. Onion через WS-воркеры не реализован:
у воркера нет RSA-ключа, `worker-demo.js` onion-логики не содержит.

### Б.8. Аудит 30.10.2026 — срез после `2.17.4-cloud-llm-backend`

Срез `30.10.2026 06:45 MSK`, стенд `https://v1107336.hosted-by-vdsina.com`, сборка `2.17.5-manifest-pii-contract`
(commit `d880b90`, схема `2.1.0-dpouw`). Прогон трёх наборов, которые гоняет `scripts/verify.sh`:
`node test-dpouw.js --test` → **987 ✅ / 0 ❌** (RC=0), `node test-mesh.js` → **25 ✅ / 0 ❌** (RC=0),
`node proof-treasury-gate.js` → **12 ✅ / 0 ❌** (RC=0). **Итого 1024.**

**Направление дрейфа изменилось.** В Б.5–Б.7 документ **завышал** возможности. На 30.10 он **занижает** уже
сделанное: Tier 6 объявлен отсутствующим при 12 живых вызовах, утилизация — нулевой при сработавшей ставке,
тесты — 649 при 1024. Занижение дороже завышения: завышение проверяется запросом за секунды, а занижение
толкает следующего исполнителя строить то, что уже работает.

| Тема | Было в документе | Факт на 30.10 | Источник |
| :--- | :--- | :--- | :--- |
| Tier 6 | «в коде отсутствует, `grep tier6\|orchestration\|byok` → 0» | таблицы `tier6_calls` / `tier6_receipts` / `tier6_reserves`; `reserveTier6Fee` (`server.js:1747`, вызов `6246`); `grep tier6` → 5 файлов | `GET /health` → `conservationTier6` |
| Tier 6 (деньги) | «`[SPEC]`, не факт» | `{calls:12, gross:0.006, distributed:0.006, delta:0, holds:true, fundedByClient:12, fundedByEmission:0}` — комиссия **не печаталась**, платил клиент | `GET /health` |
| Утилизация `TAR_UTILITY` | «`totalUtilizedTar: 0`, `count: 0` — экономически не использован» | **`totalUtilizedTar: 0.00001`, `totalUtilizedCount: 1`** — механизм сработал на живой ставке | `GET /summary` |
| Автотесты | `624 + 25 = 649`; позже «980 + 25 = 1005» | **`987 + 25 + 12 = 1024`** (985 базовых + 2 новых по onion; treasury — 12) | `verify.sh`: 3 набора, RC=0 |
| `app/` (PWA) | «каталога `app/` нет на 22.10» | `app/app.js` — 2626 строк, `GET /app/` → `200`, веб-манифест + service worker + 3 иконки | `wc -l`, `curl` |

**Инварианты на срезе.** `conservation {gross:89.115042, distributed:89.115042, delta:0, holds:true}` ·
`burnAudit.holds:true` · `treasuryAudit.holds:true` · эпоха `374` · чеков `755`, воркеров `91` · выплачено
`88.724466 TAR` (block `81.572034` + fee `7.152432`) · казна `0.1978 TAR` при OPEX `517 $/мес` →
`reserveStatus: critical`.

**Что по-прежнему не работает — и это не дефект документа.** `active_workers: 0` и
`llm_mode: deterministic_fallback` (`reason: no_workers`): живого инференса нет, ответы собирает
детерминированный обработчик. `onchain.simulated: true` — 17 settlement'ов синтетические. P2P — 3 узла
на `127.0.0.1` (`framesIn: 0`), то есть один хост, а не сеть. `0` файлов `.sol`, комитета 0 членов,
GPU-обучения нет.

**PII-гейт Tier 6.** `pii_classifier {enabled:false, ready:false, modelId:Xenova/bert-base-NER,
minConfidence:0.95}`. Модели на проде физически нет: `/opt/tarnet/backend-api/.model-cache` отсутствует,
пакеты (`@xenova/transformers@2.17.2`, `onnxruntime-node`) установлены. Вес по HF: `model.onnx` 411.2 MB,
`model_quantized` 103.9 MB, `int8` 103.5 MB; код грузит `{quantized:true}` → **103.9 MB**. Замер на проде:
kэш **105 MB**, пиковый RSS **687 MB** (`VmHWM`), загрузка **4.6 с**; RAM `1642` всего, `1165` доступно,
swap `0`, порог `minFreeMb: 900`.

**Решение было принято раньше — 22.10.2026, а не в этой директивой.** ONNX NER выключен
`ebc461d` (`README.md:129`), `610dcbc` (`docs/DEMO-RUNBOOK.md:444`); границы хранения промптов — `cc570c3`
(`docs/LEGAL-DISTILLATION-PIPELINE.md:100`, **К1 = вариант A**, владелец). Этот раздел **подтверждает** его
замером и исправляет два ложных утверждения, живших в документах восемь дней: «с 4+ ГБ RAM включён
по умолчанию» (авто-включения в коде нет — только `TARNET_PII_ONNX === '1'`, `pii-classifier.js:48`) и
«532 МБ RSS» (замер — **687 MB**, `VmHWM`).

**Обоснование варианта B — точность, не память.** Включать NER нельзя не из-за RAM, а из-за точности:
при пороге `0.95` модель `bert-base-NER` размечает `Explain how TCP handshake works` как `B-ORG: T (0.94)`,
`React and Vue` — мусором из `MISC`, `Berlin`/`Munich` — как `LOC (1.00)`, то есть блокировала бы обычные
вопросы. ФИО ловит (`PER`), но обмен массовых отказов на редкий пропуск имён — плохая сделка.

**Факт, который меняет постановку:** гейт Tier 6 `server.js:6169` вызывает `LLM.piiCheck`, а тот читает
**только** `STRUCTURED_PATTERNS` (`llm-adapter.js:40-56`). `piiClassifier.classify` с NER вызывается в двух
других местах — `/distill/record` (`4455`) и внешняя ветка (`6955`). «Включить ONNX» **не изменило бы гейт
Tier 6**: он regex-only по устройству. Порог доступа к Tier 6 в документе «`pii_confidence ≥ 0.95`» приведён
к коду: гейт бинарный (совпадение → `422`).

**Проверено живьём (30.10).** `POST /inference` с `modelId: deepseek/deepseek-chat`:
карта `4532015112830366` → `422 {error:"PII_BLOCKED", matches:["card"], required_confidence:0.95}`;
**ФИО «Иван Иванович Петров» → `401 AUTH_MISSING_KEY`** — то есть при наличии ключа имя ушло бы провайдеру
в открытом виде. Это записанное ограничение, не скрытое.

**Что осталось:** имена, адреса, паспортные данные в свободном тексте **не блокируются**; NER — Фаза 3
за отдельным сервисом. Tier 6 нельзя подавать как безопасный для произвольных пользовательских промптов.

**Контракт onion.** `POST /inference/onion` читает `{routeNodes, prompt, clientAddress, model}`
(`server.js:5090`). Документация **уже верна**: `docs/DEMO-RUNBOOK.md` шаг 4 шлёт `prompt`, PWA тоже
(`app/app.js:1154`). Вызов с `messages` → `400`; с `prompt` + `routeNodes` → `200 {"delivered":true,"hops":3}`.
Значит контракт **не менялся** — исправлена только диагностика: вместо общего «prompt must be a non-empty
string» на `messages[]` теперь `400 {error:"expected_field_prompt", expected:"prompt", received:"messages"}`.
Закреплено тестами 8.15 (2 новые проверки).

**Метод.** Каждое число выше воспроизводится одной командой: `GET /health`, `GET /summary`,
`node test-dpouw.js --test`, `node test-mesh.js`. Значения **не переносить в новые отчёты копированием** —
пересчитывать из прода на дату отчёта: это снимок, не константа.

### Б.9. Срез 02.11.2026 — `/config` стал отдавать ставку Tier 6

Правило Code-First требует, чтобы работающее было видно в endpoint'е. С 2.17.8 оно нарушалось
ровно в одном месте: ставка B′ `0.0002` существовала в `config.js` и применялась в расчётах,
но в `GET /config` её не было — проверить её снаружи можно было только `grep` по исходнику.

| Было (до 2.17.9) | Стало |
| :--- | :--- |
| `GET /config` → `fee {protocol, burn, treasury, loraRoyalty}`, блока Tier 6 нет | `GET /config` → `TIER6 {ORCHESTRATION_FEE_TAR: 0.0002, CASHBACK_TAR: 0.0001, cashbackRate: 0.5}` |
| Ставку B′ можно подтвердить только чтением `config.js` | Подтверждается запросом; `verify.sh` сверяет endpoint с `config.js` и краснеет при расхождении |

**Имена полей — `UPPER_SNAKE`, как в `config.js`,** хотя остальной payload — `camelCase`. Размен
сознательный: аудитор делает буквальный построчный `diff` без перевода регистра.

**Ставка B′ экономически ещё не проверена.** Все `13` вызовов в `tier6_calls` имеют
`feeGrossTar = 0.0005` (единственная группа в `GROUP BY`), последний — `2026-10-29T16:51:30Z`,
то есть до раскатки B′ 01.11. Вызовов по `0.0002` — **ноль**. Правильная формулировка:
«B′ раскатана и подтверждается через `/config`; экономически не проверена, потому что после
неё не было ни одного вызова». Доказательством станет первое `feeGrossTar = 0.0002` в таблице.

**Утилизация `TAR_UTILITY`** на этом срезе: `totalUtilizedTar: 0.00001`, `totalUtilizedCount: 1`
(было `0` на 30.10). Механизм сработал один раз — этого достаточно, чтобы перестать говорить
«никем не включён», и недостаточно для ✅: одна операция на `1e-5` TAR при `759` чеках —
не замкнутый цикл.

**Инварианты на 02.11:** `conservation {gross:89.559498, delta:0, holds:true}` ·
`conservationTier6 {calls:13, gross:0.0065, delta:0, holds:true, fundedByClient:13, fundedByEmission:0}` ·
чеков `759`, воркеров `91` · автотесты **`988 + 25 + 12 = 1025`**, три набора, `RC=0`.
`active_workers: 0` — живых узлов по-прежнему нет, это не изменилось.

### Б.10. Срез 03.11.2026 — проверка директивы по четырём векторам

Срез `03.11.2026 21:45 MSK`, сборка **`2.17.15-work-sig-attest`** (HEAD `ec94a46`, VPS = GitHub = локально,
`verify.sh` зелёный, sha256 91/91). Проверено **11 предпосылок директивы**; **7 не подтвердились**.

| Тема | В директиве | Факт кода / прода | Источник |
| :--- | :--- | :--- | :--- |
| Подпись `/work` | «JCS-подписи (RFC 8785)» | **JCS нет.** `grep -c 'canonicalize\|JCS\|8785'` по коду → **0**. Подпись — Ed25519 над позиционной склейкой `TARNET_WORK_SUBMIT:<address>:<tokens>:<tier>:<actionId>:<ts>` | `server.js:4984-5025` |
| Утилизация `TAR_UTILITY` | «ни разу не применилась» | **Применялась 3 раза**: `totalUtilizedTar: 1.2e-05`, `totalUtilizedCount: 3` | `/summary` |
| Ставка утилизации | `TAR_UTILITY_FEE_BPS` = рабочая | **Мёртвая константа** (`config.js:129`, 0 чтений). Работают `TAR_UTILITY_BURN_RATE` / `TAR_UTILITY_TREASURY_RATE` в `economics.js:115-116` | `grep` по всему репо |
| Комиссия Tier 6 | `0.0005 TAR` | **`0.0002`** (ставка B′ с 2.17.8), кэшбэк `0.0001` | `config.js:44` |
| `Planner` / `Map-Reduce` | есть в системе | **Нет кода.** `grep` → 0. `model-router.js` — 124 строки, только `classifyDomain` + `selectModel`; `Promise.all` → 0 | `model-router.js` |
| Ключ BYOK | идёт из браузера напрямую | **Идёт через наш VPS**: `X-Provider-Key` → `server.js:6805` → `Authorization: Bearer` провайдеру | `app/app.js:1226`, `llm-adapter.js:108` |
| Теги на VPS | отстают | **44 = 44, наборы идентичны** (`diff` — только порядок строки `v2.1.0-stable`) | `git tag` локально и на VPS |
| Диск | `/dev/vda2`, риск | Устройство — **`overlay`**, Inodes 41% — упор в байты. На момент среза `26M avail / 100%`; **актуальное состояние — в блоке «Диск» ниже**, не здесь | `df -h /`, `df -i /` |

**P2P подтверждён как локальный стенд:** `listenHost: "127.0.0.1"`, `publicUrl: "ws://127.0.0.1:4001"`,
`announced_public: false`, `registry: {total: 0, has_public_nodes: false}`; у всех трёх узлов
`framesIn`/`framesOut`/`requests`/`responses` = **0**. `P2P_*` в systemd не заданы. Код при этом умеет
внешние соединения — `wildcardBind` для `0.0.0.0` (`p2p-transport.js:157`), приоритет
`P2P_PUBLIC_URL → P2P_ADVERTISE_IP` (`:220-225`) — **возможность есть, конфигурация её не включает**.

**Приватность.** Ключ BYOK проходит через наш сервер в открытом виде — концепт «ключ не покидает
устройство» не выполняется (прямого вызова из браузера не может быть из-за CORS). Сделано правильно:
`endpointFor()` разрешает подмену адреса только на loopback (`llm-adapter.js:195-225`), ключ не попадает
в историю и кэш (`app/app.js:1217`), серверных ключей нет. **Ed25519 с 2.17.18 живёт в
IndexedDB объектом `CryptoKey` с `extractable: false`** (`app/app.js:88-135`) — выгрузить его
через `exportKey` нельзя (`InvalidAccessError`, проверено запуском), поэтому XSS не унесёт ключ
с машины. В `localStorage` остались только адрес и публичный ключ. Чего это **не** даёт: XSS на
той же странице всё ещё может попросить подпись через `crypto.subtle.sign`.

**Ключ агента закрыт тем же способом с 2.17.19.** Раньше `app/agents.js:73` импортировал ключ
с `extractable: true` и брал публичную часть через `exportKey('jwk')` (`:79`) — то есть JWK-путь
требовал извлекаемости. Теперь ключ импортируется с `extractable: false`, а публичный ключ
**вычисляется из seed** вендорным `noble-ed25519` (`app/vendor/ed25519.js`, classic-скрипт без
сборщика); `exportKey` на приватном ключе отвечает `InvalidAccessError` по всем четырём форматам.
Адрес и `agentId` не изменились — сверено с `identity.js` на четырёх seed'ах, поэтому
существующие аккаунты не теряются. Стенд `proof-agent-key.js` (исполняет вырезанный блок из
самого `agents.js`): **57 ✅ / 0 ❌**.

**Мастер-энтропия агентов с 2.17.21 в IndexedDB, а не в `localStorage`.** Раньше там лежала
открытая hex-строка `tarnet.masterEntropy` — то есть компрометация хранилища отдавала ВЕСЬ
аккаунт, поскольку и кошелёк, и ключ агента выводятся из неё. Теперь энтропия импортируется
HKDF-ключом с `extractable: false` и хранится в IndexedDB (`tarnet-agents`): `deriveBits`
работает, `exportKey` — нет. Сырых байт «в покое» в браузере не остаётся. **Чего это не даёт:**
пока XSS выполняется на живой странице, он вызовет `deriveBits` и получит те же seed'ы. Закрыт
вынос хранимого материала, не активная инъекция; полное закрытие — passkey/SE. Таблица
`device_links` с nonce-защитой **существует** (`server.js:573, 582`) — утверждение «механизма
привязки нет» неверно.

**Баг 402 — реальный дефект другой.** Новый адрес не блокируется: faucet `0.01 TAR` в 50 раз больше
комиссии `0.0002`; есть второй плательщик — владелец из `device_links` (`server.js:6845-6858`).
Настоящий дефект: **PWA не обрабатывает 402 вообще** (`grep -c '402\|INSUFFICIENT_FUNDS' app/app.js` → **0**) —
пользователь видит отказ без причины и без кнопки faucet.

**Инварианты на 03.11:** `conservation {delta: 0, holds: true}` · чеков `774` · адресов `91` ·
CWU `754 300 692` · выплачено `109.56319 TAR` · Block `102.410739` против Fee `~7.15` — условие
«спрос > эмиссия» **не выполнено**, эмиссия доминирует · казна `0.19815 TAR`, `reserveStatus: critical` ·
`active_workers: 0`, `llm_mode: deterministic_fallback`.

**Протухшие ссылки, исправленные в этом срезе.** `config.js:122-124` и `server.js:2215, 4698, 6940`
указывались как место применения ставки `TAR_UTILITY`. Проверено построчно: `2215` — `below_min_payout`,
`4698` — `license_restricted`, `6940` — fallback-цепочка моделей. **Ни одна не про ставку.**

**Чего в репозитории нет, но директивы считают готовым:** JCS-канонизация (0 вхождений),
`Planner`/`MapReduce` (0), WebRTC в клиенте (0). Всё это — `[SPEC / ROADMAP]`.

**Осталось после среза:** тега `v2.17.15` **нет** (последний — `v2.17.14-e2e-network-contract`);
диск 26 МБ — блокер для следующего `npm install`; `TAR_UTILITY_FEE_BPS` — удалить либо начать читать;
402 в PWA — обработать.

### Б.11. Срез 05.11.2026 — сверка с продом `2.19.2-p0-p1-security`

Срез `05.11.2026 09:38:50 MSK`, стенд `https://v1107336.hosted-by-vdsina.com`,
`buildVersion 2.19.2-p0-p1-security` (совпадает с `package.json`, схема леджера `2.1.0-dpouw`).
Автотесты: `test-dpouw.js` **1086 ✅ / 0 ❌**, `test-mesh.js` **25 ✅ / 0 ❌**,
`proof-treasury-gate.js` **13 ✅ / 0 ❌** → **итого 1124**, три набора, `RC=0`
(логи `/tmp/tarnet-verify-{dpouw,mesh,treasury}.log`, 09:20 MSK).

| Источник | Значение |
| :--- | :--- |
| `GET /health` | `conservation {gross:124.290924, distributed:124.290924, delta:0, holds:true, reservedTar:0, inconsistentRows:0}` |
| `GET /health` | `conservationTier6 {calls:16, gross:0.0071, distributed:0.0071, delta:0, holds:true, fundedByClient:16, fundedByEmission:0}` |
| `GET /health` | эпоха `380` · выпущено `24.297910` · роздано `8.079641` · невостребовано `8.079641` · `halvingPeriodEpochs:365` |
| `GET /health` | `active_workers: 0`, `llm_mode: deterministic_fallback`, `reason: no_workers` |
| `GET /health` | `pii_classifier {enabled:false, ready:false, modelId:Xenova/bert-base-NER, minConfidence:0.95}` |
| `GET /health` | `treasuryBalanceTar 0.19815` · `reserveStatus: critical` · OPEX `517 $/мес` |
| `GET /health` | `faucetEmission {claims:10, totalTar:0.1, emission:true}` — эмиссия, отдельно от `conservation` |
| `GET /health` | `onchain {simulated:true, settlements:17}` — блокчейна нет |
| `GET /summary` | чеков `779` · воркеров `92` · CWU `754 301 138` · выплачено `123.900348 TAR` |
| `GET /summary` | Fee `7.152457` (**5.77%**) · Block `116.747891` (**94.23%**) · сожжено `0.188638` · казна `0.188638` · роялти `0.0133` |
| `GET /summary` | `burnAudit.holds:true` · `treasuryAudit.holds:true` · `totalUtilizedTar 0.000012`, `count 3` |

**Ставка B′ наконец применена — впервые.** В §Б.9 стояло «вызовов по `0.0002` — ноль», и это было верно
на 02.11. На 05.11 арифметика `/summary` доказывает обратное: `13 × 0.0005 + 3 × 0.0002 = 0.0071`,
то есть три вызова прошли по новой ставке, средняя новых — ровно `0.000200`. Формулировка меняется с
«раскатана, но экономически не проверена» на «раскатана и сработала трижды».

**Главное расхождение с прошлыми срезами — число тестов.** В шапке документа стояло
`2.17.0-ws-utility` и 988/1024/1025 проверок в разных местах; на 05.11 их **1124**.
Прирост дали секции Private Swarm (2.18.x) и P0/P1-фиксов (2.19.2).

**Направление дрейфа снова «занижение».** Документ объявлял сборку `2.17.0`, тогда как
прод четыре минорные версии впереди. Занижение опаснее: следующий исполнитель начинает
строить уже сделанное (Swarm Synthesis, CANCEL-кадры, потолок токенов).

**Что изменилось в коде против Б.10.** Появились и работают:
`swarm-synthesis.js` (выбор лучшего из двух ответов, режим `race`, оплата выбранному);
`CANCEL`-кадр в `ws-inbound.js` для проигравшего воркера (в манифесте до этого среза
слова `CANCEL` не было вовсе); потолок генерации `maxTokens` на сабмишн с клампингом
награды (`tokens_clamped`, `tokens_declared`); Tier 6 — платёж **только с устройства**
(`TIER6_OWNER_FALLBACK_ENABLED = false`), владелец больше не платит за привязанный ПК.

**JCS: уточнение, а не отзыв.** `jcs.js` (74 строки) существует с 2.18+ и применяется
в **Device Linking** (`server.js:38` → `server.js:4108` `jcs.stringify(link)`,
проверка `test-dpouw.js:8501`). Подпись `POST /work` по-прежнему идёт над позиционной
склейкой `TARNET_WORK_SUBMIT:<address>:<tokens>:<tier>:<actionId>:<ts>` (`server.js:5528`),
`grep -c canonicalize server.js` → **0**. Формулировка «JCS-подписи» без оговорки,
что это только link-челлендж, остаётся ложной применительно к `/work`.

**Что по-прежнему не работает и не должно подаваться как работающее.**
`active_workers: 0` — живого инференса нет, ответы собирает детерминированный обработчик.
`onchain.simulated: true` — 17 settlement'ов синтетические, файлов `.sol` в репозитории 0.
P2P — 3 узла на `127.0.0.1`. Комитет валидаторов — 0 членов. GPU-обучения нет.

**Мост к libp2p (05.11.2026) — узел объявлен, discovery нет.** `p2p-node/`
перенесён внутрь репозитория (был вне git, то есть до VPS не доезжал никогда)
и получил `bridge.js`: отдельный процесс на Unix-socket
`/tmp/tarnet-p2p-bridge.sock` (права `0600`, JSON Lines). `server.js`
объявляет себя через `p2p-bridge-client.js` при старте и переобъявляется
циклом 60 с, если мост перезапустился.

**На проде работает.** `p2p-bridge.service` — `active`, `enabled`,
`NRestarts=0`; libp2p слушает `0.0.0.0:4001`, порт открыт в ufw (IPv4 + IPv6).
Живой ответ сокета: `peerId 12D3KooWRjbDE4rzafznjsd4aDu3S4Z1exHcPKSw2MeH4WcVEZpy`,
`listen /dns4/v1107336.hosted-by-vdsina.com/tcp/4001/p2p/<peerId>`,
`peer_id_persistent: true`, `announced_total: 1`.

**`peerId` постоянный, а не `unassigned`.** Ключ узла генерируется один раз
(`p2p-node/peer-id-store.js`) и лежит в `/var/lib/tarnet/p2p/peer-id.bin`
с правами `0600`; проверено двумя рестартами сервиса — идентификатор не
меняется, `peer_id_created_on_start: false` со второго старта. Ключ
закрыт `.gitignore` (`data/`) и в репозиторий не попадает.

**Чего мост НЕ делает:** не ищет пиров в Kademlia DHT (kad-dht в
`clientMode`, запросов 0), не передаёт координацию, не снимает зависимость
от единого `server.js`. Условие готовности P1.1 (`has_public_nodes: true`
и `framesIn > 0`) им **не закрыто**: один объявленный узел сети не создаёт.
Считать это «P2P работает» нельзя.

**Приём потока задач защищён подписью (2.22.0).** До этой версии
`taskClient.attach()` принимал поток от **любого** пира и сразу клал его в
общий набор каналов, а `send()` берёт первый живой канал из набора. При
`P2P_HOST=0.0.0.0` и открытом 4001 это означало: посторонний, открывший
протокол первым, получал промпт, предназначенный воркеру владельца.
Проверки личности не было вовсе — peer ID доказывает лишь владение ключом
libp2p-узла, а не принадлежность к сети TarNet.

Теперь первый кадр потока — `hello` с Ed25519-подписью тем же ключом, что
воркер уже предъявил в WS-рукопожатии (`ws_worker_auth`, TOFU). Адрес и
ключ сверяются по списку `authorized-peers.json`, который backend-api
выгружает из `ws_worker_auth` (атомарно: временный файл + `rename`), а мост
перечитывает на **каждый** новый поток — привязанный минуту назад воркер
получает доступ без перезапуска моста. Отказ — не флагом, а **отсутствием
канала в наборе**: `send` его не видит, и `NO_TASK_CHANNEL` физически не
даёт отправить задачу наружу. Поток при отказе закрывается, а не висит.

Три умолчания выбраны в сторону запрета: нет файла списка — запрет (иначе
защита снималась бы удалением файла), битый JSON — запрет (иначе опечатка
отключала бы аутентификацию), просроченный `hello` (>120 с) — запрет (иначе
перехваченный кадр предъявлялся бы вечно). Префикс подписи отдельный —
`TARNET_P2P_HELLO`, не `TARNET_WS_AUTH` и не `TARNET_WORKER_POLL`: подпись,
выпущенная для опроса работы, не даёт права на поток задач.

Тесты 51.1–51.11 (`test-dpouw.js`) проверяют **следствие**, а не флаг:
у отклонённого пира канала нет и задача не уходит, у авторизованного —
уходит и получает ответ. Тест на флаг прошёл бы и тогда, когда `send` его
игнорирует.

**`GET /p2p/bootstrap` (2.21.0) — адрес сети отдаёт тот, кто слушает.**
Воркер на чужой машине не знает ни домена, ни `peerId`; зашивать их в код
значило бы ломать всех воркеров при переезде узла. Эндпоинт спрашивает мост
через сокет и возвращает `multiaddrs` **из живого `status.listen`**, а не из
`P2P_PUBLIC_URL`: переменная может быть задана при выключенном libp2p, и
тогда мы выдали бы адрес, на котором никто не слушает. Отказы разделены:
`503 P2P_BRIDGE_UNAVAILABLE` (мост не ответил) и `503 P2P_NODE_NOT_LISTENING`
(мост жив, узел не слушает) — лечатся по-разному, поэтому и коды разные.

**Счётчик соединений перестал быть двусмысленным.** Действие `peers` в мосте
возвращало `announced` — сколько раз `server.js` сказал «я здесь» по сокету.
Один сервер объявится десять раз и даст десять записей при нуле сетевых
соединений. Добавлены `connections` и `connected_peers` из
`node.getConnections()`; при выключенном узле — `null`, а не `0`, потому что
«ноль пиров» и «p2p не поднят» — разные факты.

**`p2p-node/p2p-worker.js` — клиент, который находит сеть сам.** Берёт адрес
из bootstrap, поднимает узел на `/ip4/127.0.0.1/tcp/0` (порт 0, иначе второй
запуск на машине падал бы `EADDRINUSE`), делает `dial` и держит соединение,
переподключаясь при `getConnections().length === 0`. `--once` возвращает код
0/1 — для внешних скриптов без разбора логов по словам.

**Привязка ПК кодом — ввод в окне воркера (`2.21.2`).** Код из шести цифр
выпускается в PWA (`POST /devices/link-code`, подпись владельца) и гасится
подписью ПК (`POST /devices/link/claim`). До `2.21.2` это требовало второго
терминала и `--link`, а установщик запускал `start.cmd` через `start /min` —
окно было **свёрнуто**, и подсказку нельзя было увидеть. Теперь: `node`
работает в видимом окне (`title TarNet Worker`, `pause` после падения),
`startLinkListener()` читает строки событием `line` **после** старта цикла,
погашение идёт без `await` в обработчике (опрос не блокируется), после
неудачи подсказка возвращается, после удачи слушатель снимается. Слушатель
включается только при `stdin.isTTY`: в pipe и в фоне ожидание ввода
подвесило бы воркер, который при этом выглядел бы живым. `--link <код>` и
`TARNET_LINK_CODE` остались путём для скриптов. Проверка: `node worker-demo.js`
печатает `[Чтобы привязать ПК к аккаунту, введите 6-значный код из PWA и
нажмите Enter]`; неверный формат отбивается `CODE_FORMAT` до сети.
Кэш PWA `tarnet-app-v35` — без бампа клиент получил бы старый HTML с
инструкцией про `--link`.

**Воркер ставится одним самодостаточным файлом (`2.21.3`).** `/download/worker.js`
отдаёт **сборку** `dist/tarnet-worker.js` (`node build-worker.js`), а не
`worker-demo.js`. Причина — реальный отказ: исходник требует `./worker-box`
(шифрование `sessionKey` на ключ воркера), а установщик качал ровно один
файл, поэтому в `%LOCALAPPDATA%\TarNet` второго файла не было **никогда** и
запуск падал `Cannot find module './worker-box'` у каждого пользователя.
Сборка вшивает локальные модули в таблицу фабрик и переписывает обращения на
`__localRequire('worker-box')`; внешних пакетов у воркера нет вообще (только
`node:*`), поэтому `esbuild` не нужен. Если сборки нет, она делается на лету;
исходник вместо неё не отдаётся — это вернуло бы отказ молча. `dist/` в
`.gitignore`: закоммиченная копия протухла бы при первой правке исходника.
`worker-demo.js --self-check` (код 0/1, без сети) гоняется **установщиком**
в той же папке, куда скачали, и при отказе останавливает установку
(`fail_selfcheck`) — раньше о поломке узнавал только пользователь.

Казна `0.19815 TAR` против OPEX `517 $/мес` — `reserveStatus: critical`.
Эмиссия доминирует: Block `116.75` против Fee `7.15` = **94.2% награды из эмиссии**,
условие «спрос > эмиссия» не выполнено.

**Диск — разгружен 05.11.2026, но остаётся тесным.** Было `~447M avail / 96%`.
Удалены `failed`-сессии из `openclaw-agent.sqlite` и свободные страницы
возвращены ОС (`auto_vacuum=2` → `PRAGMA incremental_vacuum`, плюс
`wal_checkpoint(TRUNCATE)`): база `884 → 619 МБ`, `freelist 0`,
`integrity_check: ok`, диск **`739M avail / 93%`**. Следующий `npm install`
требует ≥208 МБ — запас есть. Транскрипты растут ~100–190 МБ/сутки,
так что это отсрочка, а не решение: нужна ротация сессий.

**Замер 05.11 меняет адрес проблемы.** Оценка «87 МБ в `failed`» не подтвердилась —
там **6,8 МБ**. Разложение 332 МБ текста `transcript_events` по типам:
`custom:openclaw.cache-ttl` (метаданные кэша инструментов) — **176,5 МБ = 53%**,
`message` (переписка) — 147,8 МБ, `compaction` — 6,8 МБ. То есть больше половины
базы — не история, а кэш. Плюс **форки**: сессии лежат цепочкой, ветка содержит
полную копию родителя; 259 `done`-сессий целиком дублируются (31,7 МБ), 28 774 из
54 542 сообщений — дубли (49,6%). Рычаг — `cache-ttl` и форки, а не «старые сессии».
Инструмент выжимки перед удалением: `scripts/extract-session-summary.js` (только чтение).

### Б.12. Срез 05.11.2026 — `2.21.4-ux-same-address`

Срез `05.11.2026 15:20 MSK`, `buildVersion 2.21.4-ux-same-address`,
схема леджера `2.1.0-dpouw`. Тесты: `test-dpouw.js` **1091 ✅ / 0 ❌**,
`test-mesh.js` **25 ✅ / 0 ❌**, `proof-treasury-gate.js` **13 ✅ / 0 ❌**
→ **итого 1129**, три набора, `RC=0`.

**Что появилось в коде и проверено запуском.**

| Механизм | Где | Проверка |
| :--- | :--- | :--- |
| P2P-задача `ping` → `pong` | `p2p-node/task-protocol.js`, `bridge.js` (`handlers.task`), `p2p-worker.js` | RTT **1–4 мс**, `via: "p2p"`; неизвестная задача → `UNKNOWN_TASK` |
| Установщик без адреса браузера | `GET /install/:file` (`addr` необязателен), `install/*.tpl` | `200` без `addr`, `400` на `addr=0xZZZ` |
| SAME_ADDRESS как успех | `worker-demo.js` (`applyLinkCode`), `app/app.js` (`refreshLinks`) | воркер снимает приглашение; PWA даёт зелёную `text-ok` строку |
| Ввод кода с пробелами | `worker-demo.js` (`startLinkListener`) | `4 6 6 0 6 7` проходит валидацию |
| Архивация транскриптов | `scripts/archive-transcripts.js` | 13431 строка → 9 МБ архив, база **628 → 605 МБ**, `integrity_check: ok` |

**Направление потоков в P2P задано ограничением, а не вкусом.** Узел воркера
слушает `/ip4/127.0.0.1/tcp/0` (loopback, случайный порт), поэтому мост не может
дозвониться: `dialProtocol` возвращает «no valid addresses for peer». Поэтому
**воркер открывает поток сам**, мост принимает через `handle()` и отвечает в тот
же поток. Второй канал не нужен: обмен двусторонний в одном потоке.

**Дефект диспетчера моста, который существовал до этой версии.** `reply(socket,
fn(msg, socket))` на `async`-обработчике писал `{}` — `JSON.stringify(Promise)`
не видит полей. Ответ выглядел как «пустые данные», а не как ошибка, и `exit`
был 0. Исправлено на `reply(socket, await fn(...))`; колбэк `socket.on('data')`
стал `async`.

**Диск: ожидание «вернуть 1 ГБ» отозвано.** Оно опиралось на
`incremental_vacuum`, но `freelist_count` был 76 страниц (**0.3 МБ**), и прогон
вернул **0.00 МБ** — удалять было нечего. Честные цифры на 05.11:
каталог агента `985 МБ` при `df` **9163 МБ занято / 608 МБ свободно**; разница —
данные хоста вне контейнера, недоступные изнутри. База после архивации
**605 МБ** + WAL **50 МБ**; `wal_checkpoint(TRUNCATE)` вернул `busy:1`.
Причина названа тогда неверно («вернётся после рестарта gateway»): позже
доказано, что журнал держит `litestream-tarnet` — см. Б.14, проверка на проде
05.11.2026. Рестарт gateway ничего не освобождает. Потолок наших действий здесь
≈1 ГБ, а не «сколько нужно».

### Б.13. Срез 05.11.2026 — `2.21.5-worker-bundle-fresh`

Срез `05.11.2026 15:45 MSK`, `buildVersion 2.21.5-worker-bundle-fresh`,
тесты **1092 + 25 + 13 = 1130**, `RC=0` на всех трёх наборах.

**Найденный дефект: раздавалась протухшая сборка воркера.** `ensureWorkerBundle()`
собирал бандл только при **отсутствии** файла (`if (fs.existsSync(file)) return file`).
`dist/` в `.gitignore`, rsync привозит исходники, но не сборку — поэтому после
любой правки `worker-demo.js` сервер продолжал отдавать прошлый `dist`.
Замер: сборка `14:26`, `worker-demo.js` `15:12`, `/download/worker.js` —
**88766 байт** без `SAME_ADDRESS` и без чистки пробелов.

**Почему это опаснее P0 из `2.21.3`.** Тот отказ был громким — `Cannot find module`,
человек видел красную ошибку. Здесь пользователь получает файл, который
**запускается и работает**, но без исправлений: привязка по коду с пробелами
отклоняется, `SAME_ADDRESS` считается отказом. Симптом неотличим от «фикс не
сработал», и искать будут не в сборке. Версия в `/health` при этом поднялась,
тесты 31.21–31.24 зелёные: они проверяют самодостаточность и запуск, но не
происхождение файла. Проверка «файл есть» — не проверка свежести.

**Исправление.** Пересборка по `mtime` исходников (`worker-demo.js`,
`worker-box.js`, `build-worker.js`). Если сборка не удалась, но прошлая на диске
есть — отдаётся она с предупреждением в лог: `503` на весь маршрут лишил бы
скачивания из-за опечатки в одной строке.

**Ловушка замера, которую стоит помнить.** Первое сравнение дало «88766 → 69026»
и выглядело как потеря 20 КБ кода. На деле `88766` — **байты**, `69026` —
**символы**: кириллица в UTF-8 занимает два байта. В байтах новая сборка
**91140**, и построчный diff без комментариев даёт **1 удаление / 33 добавления**:
удалена ровно строка `const raw = String(line || '').trim();`, которую заменила
чистка `\s+`. Сравнивать размеры сборок в байтах и символах нельзя.

**Тест 31.25** закрывает именно эту дыру: каждый маркер последних правок обязан
быть и в исходнике, и в раздаваемом файле. Маркер, которого нет в исходнике,
тоже валит тест — иначе проверка стерегла бы пустоту.

### Б.14. Срез 05.11.2026 — `2.22.0-p2p-peer-auth`

Срез `05.11.2026 16:40 MSK`, `buildVersion 2.22.0-p2p-peer-auth`,
тесты **1103 + 25 + 13 = 1141**, `RC=0` на всех трёх наборах.

**Закрытая дыра: посторонний пир получал задачу.** `taskClient.attach()`
принимал поток от любого пира и немедленно добавлял его в общий набор
каналов; `send()` берёт **первый живой** канал из набора. То есть при
`P2P_HOST=0.0.0.0` и порту 4001, открытом в ufw, посторонний, открывший
протокол первым, получал промпт, адресованный воркеру владельца. Проверки
личности не было вовсе.

**Почему не peer ID.** Peer ID доказывает владение ключом **libp2p-узла**,
а не принадлежность к сети TarNet: узел поднимает кто угодно и получает
любой peer ID. Значимый признак — адрес кошелька из `ws_worker_auth` плюс
Ed25519-подпись ключом, к этому адресу привязанным. Ключ тот же, что в
WS-рукопожатии, — иначе появилась бы вторая идентичность, которую надо
содержать отдельно.

**Как устроено.** Первый кадр потока — `hello {action,address,ts,signature}`,
payload `${TARNET_P2P_HELLO}:${address}:${ts}`. Мост читает список
`authorized-peers.json` (пишет backend-api из `ws_worker_auth`) и
перечитывает его **на каждый** новый поток: воркер, привязанный минуту
назад, получает доступ без перезапуска моста, а не «уже привязан, но ещё
не пущен».

**Отказ — отсутствием канала, а не флагом.** До успешной проверки канал в
наборе не появляется, `send` его не видит и бросает `NO_TASK_CHANNEL`.
Флаг `authorized:false` в наборе рано или поздно кто-то забыл бы проверить
— именно так и выглядела исходная дыра. Поток при отказе закрывается, а не
висит: иначе посторонний удерживал бы соединение и в сети выглядел бы
«подключённым воркером».

**Три умолчания в сторону запрета.** Нет файла списка — запрет (обратное
означало бы, что защита снимается удалением файла). Битый JSON — запрет
(иначе опечатка отключала бы аутентификацию). `hello` старше 120 с —
запрет (иначе перехваченный кадр предъявлялся бы вечно).

**Ловушка замера: `wal_checkpoint(TRUNCATE)` возвращает `log: 0`.** Первая
версия лога печатала `log` из ответа — и молчала бы всегда, потому что
TRUNCATE обнуляет счётчик в самом вызове. Проверено на 4 МБ журнала:
ответ `{"busy":0,"log":0,"checkpointed":0}`, файл `0` байт. Отчитываться
можно только замером файла до/после.

**Замер на проде до правки:** база `2256896` Б, а `tarnet.db-wal` —
`675712` Б, то есть треть размера базы жила в журнале. Копия «одного файла
`.db`» при таком раскладе теряет последние транзакции: их видно только
через WAL. Чекпоинт при старте переносит их и усекает журнал.

**Проверка на проде 05.11.2026 — чекпоинт НЕ выполняется: причина найдена,
это litestream.** После деплоя `2.22.0` в логе: «WAL: checkpoint не завершён
(busy) — журнал 675712 Б остался». Код раскатан (`server.js:278`), функция
верна — блокирует внешний процесс. `lsof` показал: `/var/lib/tarnet/tarnet.db`
держит `litestream` (PID 148002, юнит `litestream-tarnet.service`, `v0.3.13`,
репликация БД в S3). 8 попыток `TRUNCATE` из отдельного процесса — 8 раз
`busy:1, checkpointed:0`. `PASSIVE` проходит (`busy:0`), но даёт
`checkpointed:0`: чекпоинтить нечего, и файл всё равно не усекается.

**Доказательство, что дело в litestream, а не в коде:** остановили
`litestream-tarnet` → `TRUNCATE` вернул `busy:0`, журнал `675712 → 0` Б;
`litestream` подняли → WAL вырос до `4152` Б (новые записи), `quick_check: ok`,
45 таблиц, `NRestarts=0`, репликация продолжилась (`write snapshot`, `wal segment`).

**Вывод:** на проде автоматический чекпоинт при старте фактически не срабатывает —
litestream держит читательскую транзакцию, без которой репликация потеряла бы
позицию. Это не поломка кода и не повод убирать litestream: он защищает БД,
а чекпоинт — вторичная гигиена. Рабочая последовательность для усечения:
`systemctl stop litestream-tarnet` → чекпоинт → `start`. На сервере это
осознанно не автоматизировано: остановка репликации на время старта сервиса
расширяет окно без бэкапа молча.

### Б.15. Срез 05.11.2026 — `2.22.1-worker-transport-tag`

Срез `05.11.2026 17:55 MSK`, `buildVersion 2.22.1-worker-transport-tag`,
тесты **1103 + 25 + 13 = 1141**, `RC=0` на всех трёх наборах.

**Что сделано: транспорт виден в момент приёма задачи, а не только при ответе.**
`runTask(task, via)` принимает метку `'ws'` (кадр `TASK` по сокету) или `'http'`
(`/worker/poll`), и строка приёма печатает `[WS]` / `[HTTP]`. Раньше по логу нельзя
было понять, каким путём пришёл промпт: `отдал … по ws` печатается **после**
генерации и говорит о доставке ответа. Для приёмки «задача идёт через push» нужен
именно момент приёма.

**Почему не метка `p2p`.** В этом воркере канала libp2p нет вовсе: он ходит
HTTP-опросом и WS-сокетом. Надпись `p2p` означала бы транспорт, которого в файле
не существует, — ровно та ошибка, из-за которой документы уже расходились с кодом.

**Пересборка обязательна.** Правка в `worker-demo.js` без `node build-worker.js`
до клиента не доходит: `/download/worker.js` отдаёт `dist/tarnet-worker.js`
(`92033` Б, собран `17:39`). Кэш PWA поднят `v38 → v39`.

**Третий набор называется `proof-treasury-gate.js`, а не `test-treasury.js`.**
`scripts/verify.sh:99` запускает именно его; файла `test-treasury.js` в репозитории
нет. Запуск по неверному имени даёт `MODULE_NOT_FOUND` с `RC=1` — это не провал
проверок, и принимать его за красный тест нельзя.

### Б.16. Срез 05.11.2026 — `2.22.2-ux-copy-and-p2p-route`

Срез `05.11.2026 18:2x MSK`, `buildVersion 2.22.2-ux-copy-and-p2p-route`,
тесты **1103 + 25 + 13 = 1141**, `RC=0` на всех трёх наборах.

**Кнопка «Копировать» у кода привязки.** `setLinkCode()` держит чистый код в
`lastLinkCode`, на экран отдаёт разрядку (`2 6 7 7 4 2`), а в буфер кладёт
**без пробелов**. Копирует существующий `copyText` (`app.js:1062`): он пробует
`navigator.clipboard` в secure context и падает на `execCommand` в остальных —
второй механизм копирования не заводился. Копировать можно и кнопкой, и кликом
по самим цифрам. Подтверждение — `✓ Скопировано!` плюс строка подсказки на 1.6 с.

**P2P-маршрут доставки задачи — работает, но не так, как предполагала директива.**
Директива просила «добавить в `p2p-worker.js` обработчик TASK и слать задачу через
libp2p». Три факта кода задали другую форму:

| Факт | Где | Следствие |
| :--- | :--- | :--- |
| Сборка воркера **запрещает** внешние пакеты | `build-worker.js:127-137` | libp2p (105 МБ) в раздаваемый файл не влезет никогда |
| libp2p стоит только у `p2p-node` | `p2p-node/package.json` | путь через libp2p возможен только в p2p-процессе |
| Исполнитель моделей один | `worker-demo.js` `generate` | второй исполнитель разъехался бы с первым |

Поэтому вместо второго исполнителя сделан **локальный вход**: `worker-demo.js`
поднимает `startP2pExecutor()` на `127.0.0.1` со случайным портом и токеном
32 байта, дескриптор `~/.tarnet/p2p-exec.json` пишется с правами `0600`.
`p2p-node/p2p-worker.js` принимает кадр `task` и проксирует его на этот вход,
печатая строку `задача <id> → локальный исполнитель` под префиксом `[p2p-worker]`.
Метки `[P2P]` в коде нет — в приёмке она значилась по предположению, а печатается
именно эта строка.

**Проверено изолированно** (без модели, без сети): дескриптор создан `0600`,
чужой токен → `401 BAD_TOKEN`, пустое тело → `400 BAD_TASK`, другой путь →
`404`. То есть граница и разбор работают до генерации.

**Порядок маршрутов: WS → P2P → poll.** WS первый (сокет уже открыт), P2P второй
(нужно сходить в мост за списком каналов), poll — отступление, работает всегда.
Выбор P2P — по **состоянию строки**, а не по признаку «WS не сработал»: WS-ветка
возвращает задачу в `pending` при закрытом сокете, и ровно там P2P ещё может её
доставить. Строка уже `claimed` — второй маршрут не пробуется, иначе двойная
генерация.

**Таймаут P2P (25 с) намеренно меньше `WORKER_TASK_TTL_MS` (30 с).** Ждущий цикл
отваливается на `TTL+5с`; запросить больше значило бы получить ответ после
`expired` и потерять работу воркера.

**Возврат в очередь только на безопасных отказах.** `P2P_SAFE_TO_REQUEUE` =
`BRIDGE_UNREACHABLE`, `NO_TASK_CHANNEL`, `BAD_TOKEN`, `NO_LOCAL_EXECUTOR`,
`UNKNOWN_TASK`, `CHANNEL_GONE`. Чего там **нет** намеренно: `EXEC_TIMEOUT` и
`TASK_TIMEOUT` — к этому моменту генерация могла начаться, и возврат дал бы
вторую работу и двойной расход.

**Мост: добавлена команда `channels`.** Без неё сервер не знал адрес воркера, а
без адреса нечем заполнить `workerAddress` при claim, и приём результата
отклонил бы его как чужой (`409`). Отдаются только авторизованные и живые каналы.

**`p2p-bridge-client.js`: добавлен `task()`.** Проксирует `{action:'task'}` мосту
с сокетным дедлайном на 2 с выше сетевого, чтобы «воркер не уложился» пришёл от
моста с причиной, а не как обрыв без объяснения.
