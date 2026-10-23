# 🌐 TARNET & SYNAPSE (SWARM-GRID CORE)
# ЕДИНЫЙ ЭТАЛОННЫЙ СТАНДАРТ АРХИТЕКТУРЫ, ЭКОНОМИКИ И МАНИФЕСТ ПРОЕКТА
**Версия:** 3.4-UNIFIED (Consensus Standard: Gemini + Qwen + OpenClaw)  
**Дата:** 22 октября 2026 г. | **Схема живого стенда:** `2.1.0-dpouw`  
**Ревизия:** 22.10.2026 — сверка с кодом (6 расхождений устранены, см. Приложение Б)  
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
2. **Knowledge Scaling:** умнее не от «слепого обучения», а через воронку селекции: `Experience Buffer` $\to$ `Preference Dataset` (DPO) $\to$ ночное дообучение (`Micro-LoRA / MeZO`) $\to$ **TIES-Merging** $\to$ **Benchmark Gate / Ratchet Rule** с авто-откатом `Rollback`.

---

## 2. ШЕСТИУРОВНЕВАЯ АРХИТЕКТУРА УЗЛОВ (6-TIER HETEROGENEOUS NETWORK)

Отдельной константы цены на тир нет: базовая ставка в коде едина (`PRICE_USD_PER_1M_TOKENS = $0.20`), а стоимость и вознаграждение масштабируются коэффициентом **`κ_tier`**:

| Уровень | Оборудование и стек | Роль | `κ_tier` / цена | Контур | Доходность по Fee (без эмиссии) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Tier 1: Nano** | Смартфоны/планшеты (Snapdragon 8 Gen3+, A17+, NPU); `Rust + Flutter + MLC/CoreML`; только на зарядке, пауза при >38 °C, RAM ≤800 МБ | `Onion Relay`, лёгкая верификация, нано-инференс 0.5B–1.5B | `κ = 0.1`<br>**$0.02 / 1M** | `Private`, `Extended` | **~$0.31 / мес** (25 ток/с, 25% load, ~0.54M ток/сут) |
| **Tier 2: Core** | Домашние ПК, мини-ПК, Mac Mini M1–M4, RTX 3060/4070; `Node.js / Python + llama.cpp + WebSocket` | Роевой инференс 1.5B–7B + LoRA, `Experience Buffer`, `TIES-Merging` | `κ = 1.0` (base)<br>`κ = 4.0` (expert)<br>**$0.20 – $0.80 / 1M** | `Private`, `Extended`, `Enterprise` | **CPU 7B** (12 ток/с, 30%): **$1.77**<br>**RTX 3060** (50, 40%): **$9.85**<br>**RTX 4070** (80, 40%): **$15.76** |
| **Tier 3: Heavy** | GPU-узлы и риги (1×–2× RTX 3090/4090, A5000, HiveOS/RaveOS) | Экспертный инференс 7B–70B + LoRA, `Benchmark Gate`, `Critic-Aggregator` | `κ = 4.0` (expert)<br>**$0.80 / 1M** | `Private`, `Enterprise` | **1× RTX 4090** (120, 50%): **$118.20 / мес**<br>**2× RTX 4090** (240, 50%): **$236.39 / мес** |
| **Tier 4: Client** | Любое устройство (`Synapse Chat` Web/Desktop/Mobile, OpenAI-совместимый SDK) | `DAG Planner`, локальный `PII-фильтр`, сборка ответа, фидбек | Плательщик (`N/A`) | выбор в UI | Скидки стейкинга до 20% + Free Tier за свой вклад |
| **Tier 5: Cloud Anchor** `[SPEC Фаза 3]` | Облачные анклавы (`AWS Nitro`, Confidential VMs) через `Synapse Labs` | SLA 99.99%, пики, модели 70B+ | `κ = 10.0`<br>**$2.00 / 1M**<br>`[SPEC]` — в коде нет | **только `Enterprise`** *(в `Private` запрещён)* | Фиат по SLA + обязательный `Buyback & Burn $TAR` |
| **Tier 6: External API** `[SPEC Фаза 2.5]` | Внешние API (`Gemini`, `OpenAI`, `Claude`, `DeepSeek`) по ключу пользователя (`BYOK`) | Мета-оркестрация (`Best-of-Breed`) для не-PII задач | по тарифу провайдера | **только `Extended`** *(при `pii_confidence ≥ 0.95`)* | `$TAR`-потребление: **5% Orchestration Fee** (2.5% Burn + 2.5% Treasury) |

> **Сноска к Tier 3.** Тир «heavy» (`κ = 10.0` → `$2.00/1M`) и доход `$330+/мес` **в коде отсутствуют**: `TIER_WEIGHTS = { nano: 0.1, base: 1.0, expert: 4.0 }`, потолок — `$0.80/1M`. Даже при `κ = 5.0` 2× RTX 4090 дают **$295.49/мес**, а не `$330`. Tier 3 Heavy (70B) — Фаза 3 `[SPEC]`, отдельный тариф по рыночному прайсу. Повышение `κ` — решение владельца, а не факт кода. Tier 6 в коде отсутствует (grep `tier6|orchestration|byok` → 0 совпадений).

---

## 3. ТРИ ИЗОЛИРОВАННЫХ ПРОДУКТОВЫХ КОНТУРА (PRIVACY CIRCUITS)

| Продукт | Разрешённые узлы | Приватность и правила PII | Назначение |
| :--- | :--- | :--- | :--- |
| **1. Synapse Private** | строго Tier 1–3 | Обязательный `Onion Routing` + `TEE` + шифрование обратного пути (`response_aes_key`). **PII разрешены**, данные не покидают рой | Частные лица, юристы, врачи, разработчики — максимум защиты |
| **2. Synapse Extended** | Tier 1–3 + Tier 6 (BYOK) | Tier 6 по TLS **только если локальный PII-классификатор даёт `confidence ≥ 0.95`** и есть явное согласие в UI | Единое окно: приватное — в рой, открытый код/креатив — во внешний API |
| **3. Synapse Enterprise** | Tier 1–3 + Tier 5 Cloud (+ Tier 6 по политике) | SLA 99.99%, `Direct Encrypted Channel` в облачные TEE, аудит, маркировка `Processed by Cloud Anchor` | B2B и корпорации, оплата в фиате через `Synapse Labs` (GDPR Data Controller) |

> **Инвариант безопасности:** при `confidence < 0.95` запрос **автоматически блокируется для Tier 6** и уходит в `Synapse Private` (Tier 1–3). Смешивание трафика `Private` и `Extended/Enterprise` в одном графе запрещено.

### 3.1. Хранение промптов при дистилляции (`[SPEC Фаза 2.5]`)

Промпты хранятся на сервере только для opt-in пользователей (по умолчанию выключено), зашифрованы AES-256-GCM и используются исключительно для улучшения сети. Отзыв согласия — `DELETE` из `distillation_buffer`.

**Чего это обещание НЕ означает.** Сервер способен расшифровать промпт — иначе обучение невозможно, ключ у него. Формулировка «мы не можем прочитать ваш промпт» **ложна** и в материалах запрещена. Верная: «мы не храним его, если вы не разрешили, и удаляем по вашему требованию».

**Статус в коде:** таблицы `distillation_buffer` **нет** — Фаза 2.5. Работает только `pii-classifier.js`: regex-ветка; ONNX NER — при `TARNET_PII_ONNX=1`, по умолчанию `ready: false`.

---

## 4. ДЕЙСТВУЮЩЕЕ ЯДРО ФАЗЫ 1 (`2.1.0-dpouw`) — ЧТО РЕАЛЬНО РАБОТАЕТ В КОДЕ СЕГОДНЯ

Проверяется запросами к `localhost:3001` и прогоном `node test-dpouw.js --test` (**369 проверок, 0 провалов**, снимок 2026-10-23). Флаг `--test` поднимает изолированный сервер на временной БД (`mktemp`) с отдельным `TARNET_SECRETS_DIR` и свободным портом: приёмка не требует запущенного стенда и не затрагивает его БД. Адреса и `actionId` уникальны по суффиксу `RUN`, поэтому прогон воспроизводим.

### 4.1. Матрица живой функциональности

| Компонент | Статус `2.1.0-dpouw` | Проверка |
| :--- | :--- | :--- |
| Реестр узлов, стейк, репутация | ✅ работает | `GET /nodes`, `POST /node` |
| Антимонопольный роутинг `√stake × reputation` | ✅ работает | `routingWeight` в `POST /inference` |
| Детерминированный учёт работы (dPoUW) | ✅ работает, лотереи удалены | `POST /work` → `GET /receipt/:worker` |
| Подпись чеков Ed25519 | ✅ работает (`node:crypto`) | `POST /receipt/verify` |
| Ключи в БД at rest | ✅ `AES-256-GCM` | `ledger.js` |
| Двойная запись, балансы, списание с клиента | ✅ `debit()` + `credit()` | `GET /balances`, `GET /ledger` |
| Инвариант сохранения стоимости | ✅ `delta === 0`, `holds: true` | `GET /health` → `conservation` |
| Суточные эпохи, халвинг, потолок чека 25% | ✅ работает | `GET /epoch` |
| Аудит качества (5% работ) | ✅ выбор по хешу `actionId` (для клиента с ключом idемпотентности и отпечаток spot-check — одна и та же строка) | `ledger.js` -> `economics.js` |
| LoRA-адаптеры и роялти 5% | ✅ 3 фикстуры по доменам, роялти начисляется автору | `GET /adapters`, `totalLoraRoyaltyTar` |
| Батчинг коротких работ | ✅ порог генерации чека — `max(50, tokens_for_nonzero_payout(tier))`: `base` = 50, `nano` = 500, `expert` = 13. Работы ниже порога копятся в `pending_work` и объединяются в следующий чек | `POST /work` → `202 {queued, pending_work, threshold}`; чек несёт `batchedFrom[]` |
| Идемпотентность `actionId` | ✅ работает: `POST /work` — ключ, а не подсказка. Повтор → `200 {duplicate:true, existing:'receipt'}` (тот же `seq`, без второго начисления); повтор короткой работы → `202 {reason:'already_pending'}`, накопление не удваивается; повтор работы из `batchedFrom` → тот чек, `batchedInto = seq`; тот же ключ на другого воркера → `409`; без `actionId` ключа нет — два одинаковых запроса дают две работы | `POST /work` → раздел 8.11 приёмки |
| Soft delete адаптеров | ✅ `DELETE /adapter/:id` ставит `deleted_at`; физического удаления нет, история роялти цела, новые работы → 409 | `GET /adapters` → `deleted_at`; чек несёт `adapterDeletedAt` |
| Реальный LLM-инференс | ✅ режим `worker` | `source: live_llm`, `provider: home_worker`, `model: qwen2.5-coder-7b` |
| Onion Routing | ⏳ `[SPEC]`. Каталога `app/` нет. `archive/python-app/crypto.py` — `Wallet`, `generate_wallet()`, `sign_message()` на **SHA-256** (хеш-заглушка, **не Ed25519**); Ed25519 только в `ledger.js` | проверено 22.10.2026 |
| Аппаратная проверка TEE Quote | ⏳ Фаза 2–3, в БД лишь флаг `isTeeAttested` | `nodes.isTeeAttested` |
| Смарт-контракты L1/L2 и DAO | ⏳ `[SPEC]`, **0 файлов `.sol`**, письменной спеки нет | `/settlements` — синтетический `txHash` |

**Адаптеры.** 3 фикстуры (`lora-coder-v1` / `lora-math-v1` / `lora-medical-v1`) сеются при старте для проверки роялти по доменам. Публичная регистрация — Фаза 2 `[SPEC]`: маршрут `POST /adapter` есть, но реестра авторов, валидации качества адаптера и антифрода в нём нет.

### 4.2. Канонические формулы экономики (из `config.js` и `ledger.js`)

1. **Единица полезной работы (CWU):**
   $$W_i = N_{\text{tokens}} \times \kappa_{\text{tier}} \times \gamma_{\text{verify}}, \qquad \gamma \in \{0, 1\}$$
   Расширение ($0.25N_{\text{in}} + 1.0N_{\text{out}}$ и доменный $\delta_{\text{domain}}$) — RFC Фазы 2, в `2.1.0-dpouw` не применяется, чтобы не искажать инвариант эмиссии.

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
   * `INITIAL_BLOCK_REWARD (E_0) = 50 TAR/сут`, халвинг вдвое каждые `HALVING_PERIOD_EPOCHS = 365`: 50 → 25 → 12.5 → 6.25 TAR.
   * `MAX_RECEIPT_SHARE_OF_EPOCH = 0.25` — потолок одного чека, защита пула от захвата первым чеком суток.
   * `DECIMALS = 6` — точность расчётов, гарантирует `delta === 0`. `MIN_RECEIPT_TOKENS = 50` — нижняя граница порога.
   * **Батчинг:** порог генерации чека — `max(50, tokens_for_nonzero_payout(tier))`. Для `base` это 50, для `nano` — 500, для `expert` — 13. Работы ниже порога накапливаются в `pending_work` и объединяются в следующий чек. Ключ накопления — воркер + тир + адаптер: `W_i = tokens × κ`, поэтому 45 токенов `nano` и 5 `expert` — не 50 эквивалентных токенов, смешение занизило бы выплату в κ раз. Причина порога — `round(DECIMALS)`: при `κ = 1.0` граница ненулевой выплаты ровно на 50 токенах, при `expert` — 13, при `nano` — 500.

4. **Замкнутый цикл (`Earn → Spend`).** При `POST /inference` с `clientAddress` списывается `100% Fee_Gross`: исполнителю `95%` (или `90.25%` с роялти), протоколу `5%` (`2.5% Burn + 2.5% Treasury`). Полный круг самопотребления стоит ровно **5%**. Доли эмиссии и оплаты **не константы** — считать из `/summary` в момент публикации: `totalBlockRewardTar / totalRewardTar` и `totalFeeRewardTar / totalRewardTar`. По мере халвинга сеть переходит на 100% обеспечение платящим спросом.

---

## 5. ТЕХНИЧЕСКАЯ АРХИТЕКТУРА CORE-МОДУЛЕЙ (ФАЗА 2 — СПЕЦИФИКАЦИЯ РАЗРАБОТКИ)

### 5.1. Нативный безгазовый DAG-леджер (`PoUWReceipt`)

**Статус: частично реализовано.** Подписанные Ed25519-чеки и связывание в цепочку работают (`ledger.js`). Хеш-цепочка `prevReceiptHash` / `receiptHash` — `[SPEC / ROADMAP]`, в коде отсутствует (grep по репозиторию → 0 совпадений).

Целостность в `2.1.0-dpouw` держится **не на хешах, а на предыдущей подписи**: `prevSignature` предыдущего чека воркера входит в подписываемый payload (`receiptPayload()`), плюс монотонный `seq` и `cumulativeTotal`. Это защищает от подмены истории, но **не** даёт DAG-ветвления и адресации по хешу.

**Фактическая структура чека (по `ledger.js` → `decorate()`), проверено `GET /receipt/:worker`:**

```typescript
interface PoUWReceipt {          // ФАКТ: schema 2.1.0-dpouw
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

**Целевая структура Фазы 2 `[SPEC / ROADMAP]`** — хеш-адресация и недостающие поля учёта:

```typescript
interface PoUWReceiptV2 {        // SPEC: не реализовано
  prevReceiptHash: string;       // SHA-256 предыдущего чека — в коде нет
  receiptHash: string;           // SHA-256 текущего чека — в коде нет
  clientAddress?: string;        // не хранится в 2.1.0-dpouw
  tokensGenerated: number;       // не хранится (только cwu)
}
```
## ПРИЛОЖЕНИЕ Б. ЖУРНАЛ СВЕРКИ С КОДОМ (РЕВИЗИЯ 22.10.2026)

Ревизия по директиве владельца: каждое утверждение приведено к коду либо помечено `[SPEC / ROADMAP]`. **Константы экономики (`κ`, цены, `φ`, роялти) не изменялись** — расхождения исправлены на стороне документа.

### Б.1. Устранённые расхождения

| № | Было | Стало | Доказательство |
| :-- | :--- | :--- | :--- |
| 1 | Tier 3: `κ = 10.0` (heavy), `$2.00/1M` | `κ = 4.0` (expert), `$0.80/1M`; heavy → `[SPEC]` | `TIER_WEIGHTS = {nano:0.1, base:1, expert:4}`; grep «heavy» → 0 |
| 2 | Onion Routing «готов в Python (`app/crypto.py`)» | ⏳ `[SPEC / ROADMAP]` | каталога `app/` нет; `archive/python-app/crypto.py` — `Wallet`, `generate_wallet()`, `sign_message()` на SHA-256 |
| 3 | Контракты «спецификация готова (Solidity)» | ⏳ `[SPEC / ROADMAP]` | `find -name '*.sol'` → **0 файлов** |
| 4 | `prevReceiptHash` / `receiptHash` (DAG) | связь через `prevSignature`; хеш-поля → `[SPEC]` | `receiptPayload()` включает `prevSignature`; в `decorate()` хешей нет |
| 5 | 2× RTX 4090 «$330+/мес при `κ=5.0`» | **$236.39** при `κ=4.0`; при `κ=5.0` → `$295.49` (см. Б.2) | `240 × 0.5 × 86400 × 30 / 1e6 × $0.20 × κ × 0.95` |
| 6 | Tier 6 «5% Orchestration Fee» как факт | `[SPEC]`, Tier 6 в коде нет | grep `tier6\|orchestration\|byok` → 0 |

### Б.2. Пересчёт доходности Tier 3

`ток/мес × $0.20 × κ × (1 − φ)`, где `φ = 0.05`, `ток/мес = TPS × duty × 86400 × 30`:

| Конфигурация | TPS | duty | κ | Доход/мес |
| :--- | --: | --: | --: | --: |
| 1× RTX 4090 | 120 | 50% | 4.0 | **$118.20** |
| 2× RTX 4090 | 240 | 50% | 4.0 | **$236.39** |
| 2× RTX 4090 (гипотеза) | 240 | 50% | 5.0 | **$295.49** — всё ещё `< $330` |

`$330+/мес` неверно даже при повышенном `κ`. Повышение `κ.expert` до `5.0` — решение владельца, в коде не применено.

### Б.3. Сверка с живым стендом

Замер `23.10.2026`, `localhost:3001` на боевом VPS (он же `https://v1107336.hosted-by-vdsina.com`), схема `2.1.0-dpouw`. Всё ниже — **снимок, а не константа**: в отчётах пересчитывать из `/summary`.

> **Сноска о среде замера.** `localhost:3001` — это стенд на VPS. Локальная dev-копия на машине агента слушает тот же порт, но у неё **другая база**: на момент замера там было `688` чеков и `37.925244 TAR` против боевых `693` и `43.519994`. Снимать цифры для документа с dev-копии нельзя — они уедут в отчёт как боевые.

| Источник | Значение |
| :--- | :--- |
| `GET /config` | `tierWeights {nano:0.1, base:1, expert:4}` · `price {usdPer1MTokens:0.2, usdPerTar:20}` · `fee {protocol:0.05, burn:0.025, treasury:0.025, loraRoyalty:0.05}` · `decimals:6` · `minReceiptTokens:50` |
| `GET /health` | `conservation {gross:43.89602, distributed:43.89602, delta:0, holds:true, inconsistentRows:0}` · эпоха `367` |
| `GET /summary` | чеков `693` · воркеров `72` · CWU `725 192 968` · выплачено `43.519994 TAR` |
| `GET /summary` | Fee `6.875905` (**15.8%**) · Block `36.644089` (**84.2%**) · сожжено `0.181363` · казна `0.181363` · settlements `17` |
| `GET /adapters` | 3 фикстуры (`code` / `math` / `medical`), `totalLoraRoyaltyTar: 0.0133` |
| Автотесты | `node test-dpouw.js --test` → **369 ✅ / 0 ❌** · `node test-mesh.js` → **25 ✅ / 0 ❌** (снимок 2026-10-23) |

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
