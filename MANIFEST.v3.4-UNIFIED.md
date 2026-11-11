# 🌐 TARNET & SYNAPSE (SWARM-GRID CORE)
# ЕДИНЫЙ ЭТАЛОННЫЙ СТАНДАРТ АРХИТЕКТУРЫ, ЭКОНОМИКИ И МАНИФЕСТ ПРОЕКТА
**Версия:** 3.4-UNIFIED (Consensus Standard: Gemini + Qwen + OpenClaw)  
**Дата:** 22 октября 2026 г. (ревизия 11.11.2026) | **Сборка живого стенда:** `2.28.4` (схема леджера — `2.1.0-dpouw`), сверено 11.11.2026 20:0x MSK по `curl /health` → `buildVersion: 2.28.4`, `status: ok`; `2.28.1` (§Б.68), `2.28.2` (§Б.70), `2.28.3` (§Б.71), `2.28.4` (§Б.72) задеплоены; A3 закрыт (§Б.73)
**Ревизия:** 22.10.2026 — сверка с кодом (6 расхождений устранены, см. Приложение Б) · **24.10.2026** — полный аудит: 5 расхождений (3 занижали проект, 2 завышали), см. Приложение Б.6 · **05.11.2026** — сверка с продом `2.19.2`, см. Приложение Б.11 · **10.11.2026** — `2.26.5-final-pre-nat` (§Б.55), `2.26.6` (§Б.56), `2.26.7-honest-flags` (§Б.57), `2.26.8-tee-migration` (§Б.58), `2.26.9-audit-p1-fixes` (§Б.59), `2.26.10-pre-nat-final` (§Б.60), `2.26.11`–`2.26.13` (§Б.62–Б.63), `2.27.0` (§Б.64), `2.27.1` (§Б.65), `2.27.2` (§Б.66)  
**Основатель и Главный Архитектор:** Илья Тарасов  

> ⚠️ **ДИРЕКТИВА ДЛЯ ВСЕХ ИИ-АГЕНТОВ (GEMINI, QWEN, OPENCLAW):** этот документ — **единственный канонический источник истины**. Он объединяет проверенный код Фазы 1 (`OpenClaw v3.3`), интерфейсы (`Qwen v2.4`) и физику роевого ИИ (`Gemini Swarm-Grid`).  
> **Code-First Rule:** работающее на стенде (`порт 3001`) описывается строго по `config.js` и `ledger.js`; всё из Фаз 2, 2.5, 3 и 4 маркируется `[SPEC / ROADMAP]`. Возврат к отозванным мифам (лотерейные билеты, `$330/мес` на офисном CPU, `$3/день` на смартфоне) запрещён.
>
> **Карта прогресса — [`MASTER-PLAN.md`](MASTER-PLAN.md):** путь от идеи до цели, 15 этапов, что впереди. Этот документ описывает, **что работает сейчас**; `MASTER-PLAN` — **где мы на пути** и **что дальше**. Дублировать факты между ними нельзя.
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

**Статус в коде (сверено 08.11.2026, сборка `2.23.3`).** Таблица `distillation_buffer` существует и используется `POST /distill/record`. Что работает по факту:

| Механизм | Факт в коде |
| :--- | :--- |
| Opt-in гейт | `user_consent.is_opt_in !== 1` → `{status:'ignored', reason:'no_opt_in'}` (`server.js:5392`). По умолчанию согласия нет |
| Лицензия модели | `model_registry.allowsTraining !== 1` → `reason:'license_restricted'` |
| PII-гейт | `piiClassifier.classify(promptText)`; при недоступности классификатора — **отказ** (`pii_check_unavailable`), а не пропуск |
| Ограничение размера | `DISTILL_TEXT_MAX` на `promptText` и `response` |
| **Шифрование обоих полей** | `encryptSecret()` → `enc:v1:…` для `promptText` **и** `response` до `INSERT` (`server.js:5498-5518`), AES-256-GCM |
| **Миграция старых строк** | `migratePlaintextDistillation()` на старте (`server.js:1629`) перешифровывает открытые строки; возвращает счётчик в лог |
| **Хеш промпта** | `promptHash` = SHA-256 **открытого** текста, считается ДО шифрования (`server.js:5497`) — после шифрования его не пересчитать |
| Отзыв согласия | `DELETE FROM distillation_buffer WHERE userId=? AND usedInTraining=0` + затирание `promptText = NULL` |

**Шифрование промпта ВЫПОЛНЕНО с `2.23.3`.** Ранее (§Б.31, срез 18:25) `promptText` писался открытым текстом — обещание не имело механизма. Теперь это закрыто, и закрыто проверяемо: тест 62.5 читает **файлы** БД (включая WAL) и ищет в них байты открытого промпта. Проверка через `startsWith('enc:v1:')` в одиночку не годилась бы — SQLite держит старые версии строк в свободных страницах.

**Граница обещания.** Шифрование at rest защищает от чтения файла БД и от бэкапа, уехавшего не туда. Оно **не** защищает от самого сервера: ключ у него, `decryptText()` в `knowledge-loop.js` расшифровывает перед сборкой датасета (тест 62.8/62.9 проверяет, что в JSONL попадает открытый текст, а не `enc:v1`).

**Чего ещё нет:** ни одна строка не дошла до обучения — `mock_train.py` возвращает `pending_gpu`. Работает только `pii-classifier.js`: regex-ветка; ONNX NER — при `TARNET_PII_ONNX=1`, по умолчанию `ready: false`.

---

## 4. ДЕЙСТВУЮЩЕЕ ЯДРО ФАЗЫ 1 (`2.23.3-prompt-integrity`) — ЧТО РЕАЛЬНО РАБОТАЕТ В КОДЕ СЕГОДНЯ

Проверяется запросами к `localhost:3001` и прогоном `node test-dpouw.js --test` (**1209 проверок, 0 провалов**) и `node test-mesh.js` (**25 проверок, 0 провалов**) и `node proof-treasury-gate.js` (**13 проверок, 0 провалов**), итого **1247**, снимок 08.11.2026 00:30 (§Б.32). Исторические цифры: на 07.11 18:25 — **1191 + 25 + 13 = 1229** (§Б.31), на 07.11 12:14 — **1182 + 25 + 13 = 1220** (§Б.26), на 07.11 11:35 — **1169 + 25 + 13 = 1207** (§Б.25), на 06.11 10:31 — **1132 + 25 + 13 = 1170** (§Б.22), на 06.11 06:05 — **1121 + 25 + 13 = 1159** (§Б.21), на 05.11 днём — **1091 + 25 + 13 = 1129** (§Б.12), на 05.11 утром — **1086 + 25 + 13 = 1124** (§Б.11), на 02.11 — **988 + 25 + 12 = 1025** (§Б.9), на 30.10 — **987 + 25 + 12 = 1024**, на 29.10 — **980 + 25 = 1005**. Флаг `--test` поднимает изолированный сервер на временной БД (`mktemp`) с отдельным `TARNET_SECRETS_DIR` и свободным портом: приёмка не требует запущенного стенда и не затрагивает его БД. Адреса и `actionId` уникальны по суффиксу `RUN`, поэтому прогон воспроизводим.

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
| Реальный LLM-инференс | ⚠️ **механика работает, сеть не постоянна**: на замере 29.10 14:41 — `active_workers: 1`, `llm_mode: worker` (воркер `0xe56c…`, `qwen2.5-coder:1.5b`, 4343 опроса). **На замере 10.11 16:1x — `active_workers: 1`, `llm_mode: worker`, ПК владельца `0x3b7928c8…`; `POST /inference` вернул `source: live_llm`, `provider: home_worker`, «Париж», `promptHashVerified: true`, `emulated: false`, чек `seq 794`** (§Б.61). Окно жизни воркера — 60 с, поэтому «сейчас 1» не значит «сеть». Это по-прежнему **один узел, включаемый руками** | `GET /worker/status`, `GET /health` → `llm_mode`. Сквозной путь доказан 28.10 (телефон → VPS → дом → Ollama) и повторён 10.11 с домашнего ПК |
| **Внутренняя утилизация токена (`TAR_UTILITY`)** | ✅ **в коде с 2.17.0**: `paymentMode: TAR_UTILITY` в `POST /work` и `/inference` списывает **2%**, поровну в burn и казну. Ставка берётся из `TAR_UTILITY_BURN_RATE: 0.01` + `TAR_UTILITY_TREASURY_RATE: 0.01` (`config.js:130-131`), единственное место применения — `economics.js:115-116`. **Мёртвая константа «ставка в bps» УДАЛЕНА в 2.22.7** — она объявлялась с 2.17.0 и не читалась нигде; `grep` по всему коду → **0** (тест 54.9) | `economics.js:115-116`; приёмка 43.14 + 54.9/54.10. **[срез 03.11]** `totalUtilizedTar: 1.2e-05`, `totalUtilizedCount: 3` — механизм сработал трижды |
| **Подпись `POST /work`** | ✅ **в коде с 2.17.15**: Ed25519 над `TARNET_WORK_SUBMIT:<address>:<tokens>:<tier>:<actionId>:<ts>`; без подписи — `403 HANDSHAKE_REQUIRED`. **Это НЕ JCS (RFC 8785):** `grep -c 'canonicalize\|JCS\|8785'` по коду → **0**, канонизации JSON нет, подпись считается над позиционной склейкой через `:` | `server.js:4984-5025` |
| **Входящий WS воркера (`/p2p/worker`)** | ✅ **в коде с 2.17.0**: `ws-inbound.js` — Ed25519-хендшейк с nonce (`AUTH_PREFIX = TARNET_WS_AUTH`), TOFU по адресу (`ADDRESS_KEY_MISMATCH` при подмене ключа). Воркер держит **исходящее** соединение и получает задачу кадром `TASK`, фолбэк на `/worker/poll` сохранён | `ws-inbound.js`; `worker-demo.js:671` (`new WebSocket`); `GET /worker/ws`. Портов воркер не открывает → `registry.total: 0` остаётся верным |
| Onion Routing | ✅ работает: `onion.js` (289 строк) — RSA-2048-OAEP-SHA256 шифрует 32-байтный ключ AES, нагрузка идёт AES-256-GCM; TTL слоя, защита от replay, шифрование обратного пути. `app/` — полная PWA (веб-манифест, service worker, 3 иконки). ⚠️ Остаётся только **несуществующий** `archive/python-app/crypto.py`: каталога `archive/python-app/` в репозитории **нет** (в `archive/` только `lottery-tests/`), файла `crypto.py` нет — Python-версия `Wallet`/`generate_wallet()`/`sign_message()` утрачена, сохранилась лишь в истории. Текущие подписи — Ed25519 (`jcs.js`), не SHA-256 | `POST /inference/onion` → `delivered: true`, `hops: 3`; `test-mesh.js` → 25 ✅ |
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
| 2 | Onion Routing «готов в Python (`app/crypto.py`)» | ⏳ `[SPEC / ROADMAP]` **на 22.10**; ⚠️ факт обновлён 24.10 — см. Б.6 (в Node `onion.js` реализован) | каталога `app/` нет **на 22.10** `[снимок 22.10; на 30.10 — `app/app.js` 2626 строк, `GET /app/` → 200, см. §Б.8]`; ⚠️ `archive/python-app/crypto.py` — **файла нет** (каталог `archive/python-app/` отсутствует, `find -name crypto.py` → 0). Описание `Wallet`/`generate_wallet()`/`sign_message()` на SHA-256 — по историческому тексту, не по коду |
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
| Ставка утилизации | `TAR_UTILITY_BURN_RATE` + `TAR_UTILITY_TREASURY_RATE` = 1% + 1% | **Живые ставки** (`config.js:130-131`), применяются в `economics.js:115-116`. Мёртвая константа «в bps» **удалена в 2.22.7**, `grep` → 0 | `grep` по коду → 0 (тест 54.9) |
| Комиссия Tier 6 | `0.0005 TAR` | **`0.0002`** (ставка B′ с 2.17.8), кэшбэк `0.0001` | `config.js:44` |
| `Planner` / `Map-Reduce` | есть в системе | **Нет кода.** `grep` → 0. `model-router.js` — 124 строки, только `classifyDomain` + `selectModel`; `Promise.all` → 0 | `model-router.js` |
| Ключ BYOK | идёт из браузера напрямую | **Идёт через наш VPS**: `X-Provider-Key` → `server.js:6805` → `Authorization: Bearer` провайдеру | `app/app.js:1226`, `llm-adapter.js:108` |
| Теги на VPS | отстают | **44 = 44, наборы идентичны** (`diff` — только порядок строки `v2.1.0-stable`) | `git tag` локально и на VPS |
| Диск | `/dev/vda2`, риск | Устройство — **`overlay`**, Inodes 41% — упор в байты. На момент среза `26M avail / 100%`; **актуальное состояние — в блоке «Диск» ниже**, не здесь | `df -h /`, `df -i /` |

**P2P: мост — это транспорт, демо-меш — это стенд.** `listenHost: "127.0.0.1"`,
`publicUrl: "ws://127.0.0.1:39193"`, `announced_public: false` относятся к
**демо-мешу** и остаются в силе: три узла на loopback сетью не являются.
С 2.22.8 в том же ответе есть отдельный блок `bridge` — снимок настоящего
моста: `peerId`, `libp2p`, `connections`, `connected_peers`, `tasks`.
Готовность сети считается по нему: `bridge.connections >= 1` и
`bridge.tasks.framesIn > 0`. `registry.has_public_nodes` как критерий
**отменён 07.11.2026** — у воркера за NAT публичного адреса нет.
Проверка: `curl -s https://v1107336.hosted-by-vdsina.com/p2p/status | jq .bridge`.
Срез 07.11.2026 11:08 MSK — **P1.1 закрыт живым фактом**: `bridge.connections: 1`,
`connected_peers: ["12D3KooWFSUMfAJRrS3YjLGSyhB1sYkcmdz3CUEornefi9M4qW1b"]`,
`tasks.framesIn: 2`, `tasks.framesOut: 1`, `tasks.channels: 1`, `tasks.rejected: 0`.
Задача `wt_9a0a0e938efc79c36c995fcb` выполнена воркером `0x209a5200…` **через мост**
(журнал `p2p-bridge`: «p2p: задача wt_9a0a0e93… выполнена воркером 0x209a5200…»),
ответ `/inference` — `source: live_llm`, «Токио». Соединение пришло **снаружи**
(контейнер агента за NAT → `v1107336…:4001`), то есть NAT-сценарий P1.1 проверен.

**Чего этот факт не означает.** Воркер поднят вручную и живёт в контейнере агента —
он не постоянный узел владельца. Критерий «`active_workers ≥ 1` без ручного запуска»
и «узел переживает перезапуск хоста» остаются открытыми. P1.1 закрыт как вопрос
**«ходит ли задача по P2P между двумя машинами»** — да, ходит.

**Обязательное условие, без которого факта не было (найдено 07.11.2026).**
`p2p-bridge.service` **не перезапускался `deploy.sh`** и двое суток работал на коде
от 05.11: `bridge.js` на диске уже знал action `channels`, процесс в памяти — нет,
и отвечал `{"ok":false,"error":"UNKNOWN_ACTION","known":["announce","status","peers","ping","task"]}`.
Следствие тихое: `p2pTaskChannels()` всегда получал пусто, `dispatchTaskOverP2p`
возвращал `channels_failed`, задачи уходили по WS, `framesIn` стоял на 0.
Внешне это выглядело как «путь P2P не работает» при формально зелёном деплое.
С 07.11 `deploy.sh` шаг **5b** перезапускает мост (не роняя деплой, если юнита нет).

**Второй, независимый гейт: WS забирает задачу первым.** P2P-маршрут стартует
только если строка осталась `pending` после WS-ветки (`server.js:7215`).
Воркер с живым WS поэтому всегда получает задачу по WS, и `framesIn` не растёт
даже при рабочем мосте. Чтобы проверить P2P-путь честно, воркера запускают
с `node --no-experimental-websocket` (глобального `WebSocket` нет → «работаю на опросе»).

**`p2p-worker.js` — транспортный прокси, а не исполнитель (уточнено `2.22.9`).**
Своих моделей у него нет: задачу он передаёт на loopback (`127.0.0.1/p2p/execute`,
токен из `~/.tarnet/p2p-exec.json`, права `0600`) в `worker-demo.js`, где живёт
`runTask`. Убив p2p-процесс, вы теряете канал, но не исполнитель. При этом
формулировка «задачи по P2P ещё не идут» **неверна**: идут с `2.22.5`,
`via: 'p2p'` доказан `scripts/test-p2p-e2e.js` (RTT 13.6 с, включая `CANCEL`).
Открыт не переход, а второй хост (P1.1).

**Привязка устройства (`2.22.9`).** `linkFromCli` вызывался раньше `connectWs`, а ключ
пишется в `ws_worker_auth` только после WS-рукопожатия — при упавшем HTTP-рукопожатии
claim получал `403 DEVICE_KEY_UNKNOWN` при **уже погашенном** коде. Теперь отказ
откладывает код в `linkState.pendingCode`, `retryPendingLink()` после `AUTH_OK`
гасит его ровно один раз; успех или иной код очищают ожидание.

**Тестопись §56–§57.** `/p2p/bootstrap` проверяется в трёх ветвях (живой узел,
узел не слушает, моста нет). Приёмка: `node test-dpouw.js --test` →
**1164 ✅ / 0 ❌ / EXIT=0**. Долгие прогоны запускать через `setsid` и не убивать
по шаблону `pkill -f` — шаблон совпадает с командной строкой собственного шелла.

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
диск 26 МБ — блокер для следующего `npm install`; ~~мёртвая константа ставки~~ — **удалена в 2.22.7**;
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

**Демо-меш уведён с порта моста (09.11.2026).** После раскатки `2.25.0` мост
падал в цикл рестартов (`NRestarts=28`), при этом `tarnet.service` был `active`
и `/health` отвечал `200` — отказ был невидим снаружи. Причин оказалось две,
и первая маскировала вторую:

1. **`deploy.sh` не ставил зависимости моста.** `p2p-node/` — отдельный
   npm-пакет со своим `package.json` внутри репозитория; `npm ci` для
   `backend-api` его не покрывает. `bridge.js` импортирует `@libp2p/gossipsub`,
   модуля на диске не было → `ERR_MODULE_NOT_FOUND`. Теперь шаг 5b делает
   `npm ci` в `WorkingDirectory` юнита **до** рестарта, и провал установки
   валит деплой (`exit 9`), а не оставляет тихий цикл.
2. **Конфликт порта `4001`.** Демо-меш (`p2p-demo.js`) стартует из `server.js`
   раньше моста и занимал `PREFERRED_PORTS.relay1 = 4001` — тот самый порт,
   на котором слушает настоящий libp2p. Мост падал с `EADDRINUSE 0.0.0.0:4001`.
   Демо-стенду номер безразличен: порты уведены на `4101`/`4102`.

Проверено на VPS после раскатки `3fcb979`: `p2p-bridge` — `active running`,
`NRestarts=0`, `4001` держит только `bridge.js` (pid моста), демо-меш на
`127.0.0.1:4101`/`4102`, `/p2p/status` отдаёт `publicUrl ws://127.0.0.1:4101`,
`/health` — `200`. Приёмка: **1227 ✅ / 0 ❌**.

**`peerId` постоянный, а не `unassigned`.** Ключ узла генерируется один раз
(`p2p-node/peer-id-store.js`) и лежит в `/var/lib/tarnet/p2p/peer-id.bin`
с правами `0600`; проверено двумя рестартами сервиса — идентификатор не
меняется, `peer_id_created_on_start: false` со второго старта. Ключ
закрыт `.gitignore` (`data/`) и в репозиторий не попадает.

**Чего мост НЕ делает:** не ищет пиров в Kademlia DHT (kad-dht в
`clientMode`, запросов 0), не передаёт координацию, не снимает зависимость
от единого `server.js`. Условие готовности P1.1 (`bridge.connections >= 1`
и `bridge.tasks.framesIn > 0`) им **не закрыто**: один объявленный узел сети не создаёт.
Считать это «P2P работает» нельзя.

**Счётчики трафика появились в 2.22.8 (`task-protocol.js`).** `stats()` отдаёт
`{framesIn, framesOut, rejected, channels}`; `framesIn` растёт на **любом**
разобранном кадре, включая первый `hello`, — он и есть первое доказательство,
что поток живой. До этого "трафик" можно было оценить только по логам: в ответе
моста `status` счётчиков кадров не было вовсе.

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

**Диск — разгружен 05.11.2026 и ещё раз 06.11.2026, но остаётся тесным.**
Было `~447M avail / 96%`. Удалены `failed`-сессии из `openclaw-agent.sqlite`
и свободные страницы возвращены ОС (`auto_vacuum=2` → `PRAGMA incremental_vacuum`,
плюс `wal_checkpoint(TRUNCATE)`): база `884 → 619 МБ`, `freelist 0`,
`integrity_check: ok`, диск `739M avail / 93%`.

**Повтор 06.11.2026 20:45 — тот же рычаг, другая причина.** Сухой прогон
`archive-transcripts.js --days=30` → «нечего архивировать, 0 строк старше 30 дней»,
но `freelist` = **32654 страницы (128 МБ)**. `incremental_vacuum` вернул их:
`page_count` `117269 → 84575`, `freelist 0`, `wal_checkpoint(TRUNCATE)` → `busy:0`
(WAL 0 Б), `integrity_check: ok`. База **458 → 330 МБ**, диск **`802M avail / 92%`**.
Следующий `npm install` требует ≥208 МБ — запас есть.
**Транскрипты растут ~100–190 МБ/сутки, так что это отсрочка, а не решение:
нужна ротация сессий, и рычаг по объёму — на хосте (`docker system prune`,
старые слои/образы), а не внутри контейнера.** Внутри overlay видно 3.3 ГБ
файлов при 8.8 ГБ занятых — 5.8 ГБ лежат вне видимости контейнера.

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
| Архивация транскриптов | `scripts/archive-transcripts.js` | 13431 строка → 9 МБ архив, база **628 → 605 МБ**, `integrity_check: ok`; с 06.11 заголовок `seq=0` исключён (`WHERE_OLD_ROWS ... AND seq <> 0`) и проверяется финально — иначе сессия теряет право читаться |
| Заголовки транскриптов | `repair-session-header.mjs` (workspace) → `noteSessionTranscriptHeaderHealth` из `/app/dist/doctor-session-transcript-headers-*.mjs` | 06.11: DM `921098636` восстановлена, `repaired: 1`, `383 → 384` события, заголовки **43/43**. Повторный dry-run: `found: 0` |

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

Метка `[P2P]` **есть, но собирается динамически**: `worker-demo.js:815`
печатает ``log(`[${String(via).toUpperCase()}] задача …`)``, а p2p-вход зовёт
`runTask(task, 'p2p')` (`worker-demo.js:1480`). Поэтому `grep '[P2P]'` по
исходникам даёт ноль вхождений — это не отсутствие метки, а её сборка из
`via`. Ошибка была в методе проверки: искать литерал там, где строка
склеивается из частей.

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

---

### Б.17. Срез 05.11.2026 — `2.22.3-p2p-e2e-proof`

**Сквозной проход P2P доказан тестом, а не рассуждением.** `scripts/test-p2p-e2e.js`
поднимает три процесса (мост, `p2p-worker.js`, локальный исполнитель), гонит
задачу через `p2pBridge.task` и проверяет шесть фактов:

| Факт | Значение прогона |
| :--- | :--- |
| мост ответил | `ok=true` |
| `via` | `p2p` |
| канал | `channels=1` |
| воркер выполнил | `result.ok=true` |
| ответ по сети | `rtt_ms=10652` |
| метка у исполнителя | `[P2P] задача <id>` есть |

**Почему тест нельзя обмануть.** `via:'p2p'` ставит сам мост
(`bridge.js` `handlers.task`) только в ветке после успешного
`taskClient.send`, то есть после кадра от воркера по libp2p. Без потока
вернётся `NO_TASK_CHANNEL`, при молчании — `TASK_TIMEOUT`; ни один из этих
исходов `via` не даёт.

**Изоляция от прода.** `HOME` подменяется на временный каталог (дескриптор
`~/.tarnet/p2p-exec.json` и ключи не пересекаются с живыми), сокет и каталог
данных свои, порт моста свободный, bootstrap — локальная HTTP-заглушка,
отдающая адрес тестового моста. Боевой процесс не затрагивается, тест можно
гонять при живом мосте.

**Границы доказанного.** Проверен loopback. Боевая топология (мост на VPS,
воркер на ПК, адрес из `/p2p/bootstrap`) тем же тестом не покрыта — нужна
вторая машина и опубликованный `P2P_PUBLIC_URL`.

**Метка `[P2P]` — уточнение метода проверки.** Она есть, но собирается
динамически: `worker-demo.js:815` печатает ``[${String(via).toUpperCase()}]``,
p2p-вход зовёт `runTask(task,'p2p')`. `grep '[P2P]'` по исходникам даёт ноль
вхождений — это сборка из частей, а не отсутствие метки.

### Б.18. Срез 05.11.2026 — `2.22.4-geo-p2p-and-disk`

**География P2P: транспорт доказан, доставка задачи — нет.** Мост поднят на VPS
(`P2P_PUBLIC_URL=https://v1107336.hosted-by-vdsina.com`, `P2P_HOST=0.0.0.0`,
порт 4001 в listen). С **другого хоста** (не VPS, отдельный контейнер) выполнен
`node p2p-node/p2p-worker.js`: `bootstrap` → `dial` по
`/dns4/v1107336.hosted-by-vdsina.com/tcp/4001/p2p/12D3KooWRj…`. Мост, опрошенный
снаружи через `https://…/p2p/bootstrap`, показал `connections=1` и чужой peer ID
`12D3KooWGvFAyvdZqdRY4mD4J9se2576hE9GDm17eRvk1STcH6ak` — то есть это не self-loop.

| Факт | Значение |
| :--- | :--- |
| `P2P_PUBLIC_URL` на VPS | `https://v1107336.hosted-by-vdsina.com` |
| порт 4001 снаружи | `OPEN` (проверено TCP с другого хоста) |
| соединение worker → bridge | установлено, `моих соединений: 1` |
| мост видел пира | `connections=1`, peer `12D3KooWGvFAyvd…` |
| поток задач | **НЕ открыт**: `NO_WORKER_KEY` |

**Почему поток не открылся — и это не дефект сети.** Для `hello` нужен seed из
`~/.tarnet/worker-key.json` (`peer-hello.js:65`). На этом хосте есть только
`worker.json` с `address`; seed создаётся при WS-рукопожатии воркера
(`worker-demo.js:661`, `randomBytes(32)`), которого здесь не было. Мост корректно
отказал в приёме потока без подписи — защита `peer-auth.js` сработала как задумано.

**Важно про `connections: 2`.** В постановке ожидалось `connections: 2`
(VPS-воркер + ПК). По факту мост считает соединения **только с пирами**: на VPS
воркера нет, поэтому потолок здесь — 1 внешний пир. `connections: 2` появится
лишь когда второй воркер подключится одновременно; это не признак поломки.

**`swarm` + `CANCEL` уже реализованы (не требуют новой работы).** В `server.js`
(8831+) при `swarm:true` берутся две ветки через `wsInbound.pickLeastBusy(tier)`
и `pickLeastBusy(tier, new Set([first]))`, проигравший получает кадр `CANCEL`
с `reason:'swarm_loser'` (8986) **только в режиме гонки** — в `synthesis`
второй ответ прочитан, и снятие было бы ложью. Покрыто тестами 47.5b/c/d.
Ограничение: и ветки, и `cancelTask` работают по **WS**; в P2P кадра `CANCEL`
нет вовсе (`grep cancel p2p-node/` → пусто).

**`scripts/prune-archives.js` — удаляет только подтверждённое базой.**
Отбор: `.zst` старше 7 дней **и** SHA-256 файла побайтово равен
`session_transcript_archives.archive_sha256`. Нет записи или хеш не совпал —
файл остаётся и печатается в отчёт. По умолчанию dry-run, удаление только
с `--apply`. Возраст берётся из метки `.deleted.<ISO>` в имени, а не из mtime
(mtime меняется при копировании и защитил бы именно то, что надо удалить).

Прогон 05.11.2026: 32 файла, `sha256` совпал у всех, удалено 32,
освобождено **75.3 КБ**, ошибок 0.

**Диск: `.zst` — не причина.** Свободно было 700 МБ, стало 700 МБ. Реальный
потребитель — база OpenClaw: `agents/main/agent/openclaw-agent.sqlite` **589 МБ**
+ WAL **50 МБ**; крупнейшая таблица `transcript_events` — 371 МБ. `freelist_count`
= 103 страницы (0.4 МБ), то есть `VACUUM` без предварительного удаления строк
даст копейки. Порог 700 МБ держится на грани и будет пробит ростом транскриптов.

**Расписание очистки.** В контейнере **нет `crontab`** (`crond` отсутствует),
поэтому расписание — automation `tarnet-prune-archives`
(id `cc5492f0-d14a-4b90-8634-ce53b79e763c`), cron `30 3 * * *` Europe/Moscow,
`--apply --days 7`. Проверено принудительным прогоном: `status: ok`, 810 мс.
Первый прогон упал с `cron script payload must return an object` — скрипт
возвращал строку; исправлено на объект `{ok, rc, output}`.

**Урок метода: `pkill -f 'p2p-worker.js'` убивает собственный shell.** Шаблон
совпал с командной строкой самой команды, и вместе с воркером умерли три
запущенных в том же вызове теста. Гасить по шаблону, который не встречается в
собственной команде, либо через сохранённый PID.

### Б.19. Срез 05.11.2026 — `2.22.5-p2p-key-sync`

**Ключ теперь переживает разделение процессов.** Корень `NO_WORKER_KEY` был не
в сети и не в правах: `worker-demo.js` при seed из `TARNET_WORKER_SEED` держал
его только в памяти, а `p2p-worker.js` — **другой процесс** — читал файл и не
находил его. Мост корректно отказывал без подписи, и это выглядело как поломка
транспорта.

| Что изменилось | Где | Проверка |
| :--- | :--- | :--- |
| seed из env пишется на диск при отсутствии файла | `worker-demo.js` `loadOrCreateSeed` → `writeSeedFile(seed,'env')` | 52.1, 52.3 |
| режим файла `0600` | там же | 52.2 |
| путь переопределяем | `peer-hello.js` `workerKeyFile({home,env})`, `P2P_WORKER_KEY_FILE` | 52.4 |
| воркер ждёт ключ, а не падает сразу | `peer-hello.js` `waitForWorkerIdentity`, `P2P_KEY_WAIT_MS` (5000) | 52.5, 52.6 |

**Уже привязанный ключ НЕ перезаписывается — это защита, а не лень.** Смена seed
при живом `address` дала бы `ADDRESS_KEY_MISMATCH` на каждом запросе: адрес
привязан к ключу через TOFU ещё в WS-рукопожатии. Поэтому env задаёт ключ только
когда файла нет; 52.3 держит это поведение.

**`CANCEL` в P2P: кадр есть, но управляющий, а не задачный.** В
`task-protocol.js` появились `CONTROL_FRAME='cancel'`, `isControlFrame(msg)` и
`cancel({address,taskId,reason})`; `serveTaskStream` получил `onControl` и
**отделил чтение управления от цепочки задач**. Это не косметика: до 2.22.5 цикл
ждал `onTask`, и `CANCEL` лежал в буфере, пока модель считала минуту, — отменять
было уже нечего. 52.10 проверяет отмену **во время** задачи (задача держится
гейтом), 52.11 — что ответ при этом не потерян, 52.12 — что порядок ответов
сохранён: без цепочки очередь ожиданий сопоставила бы ответ не с той задачей.

**Доставка отмены до исполнителя.** `p2p-worker.js` → `proxyCancelToLocalExecutor`
→ `POST /p2p/cancel` в `worker-demo.js` (Bearer-токен, `127.0.0.1`); мост —
`bridge.cancel(msg)` → `taskClient.cancel()` → `{ok,cancelled[],channels}`.
`cancelled` содержит только адреса, куда кадр **реально записан**, — по нему
приёмка отличает «отмена ушла» от «отмена не нашла канал».

**`server.js` не меняет поведение WS.** Сначала пробуется `wsInbound.cancelTask()`;
`p2pBridge.cancel()` вызывается только если WS не отправил, и в
`cancelledAddrs` попадают лишь настоящие P2P-доставки. Иначе арендатор
отмены удвоился бы, а отчёт показывал бы доставку, которой не было.

**Доказательства.** `scripts/test-p2p-e2e.js`: 10/10 ✅, `RC=0`,
`via=p2p`, `channels=1`, отмена дошла до воркера и до исполнителя. Полный набор:
**1115 ✅ / 0 ❌** (`RC=0`), из них 12 — новая секция 52.

**Диск: директива снова указывала не туда.** `docker system prune -a -f` на VPS
неприменим — Docker там **не установлен** (`which docker` → пусто, `/var/lib/docker`
отсутствует), а свободно **32 ГБ (17%)**. Тесный диск — **локальный**: overlay
9.8 ГБ, занято 8.9 ГБ, свободно **686 МБ (93%)**; крупнейшее —
`agents/` 673 МБ. Чистить надо базу агента, а не Docker на VPS.

### Б.20. Срез 05.11.2026 — `2.22.6-p2p-flag`

**Транспорт поднимается из того же окна.** До этой версии человек запускал
`worker-demo.js` и `p2p-worker.js` двумя командами в двух окнах. Забыть вторую —
обычное дело, и симптом обманчив: воркер жив, `ws активен`, а мост показывает
`connections: 0`. Флаг `--p2p` убирает эту категорию «я всё запустил, а не работает».

| Что изменилось | Где | Проверка |
| :--- | :--- | :--- |
| `--p2p` или `TARNET_P2P=1` поднимает транспорт | `worker-demo.js` `P2P_WANTED` | 53.1, 53.2, 53.3 |
| дочерний процесс — `spawn`, а не `fork` (ESM + `stdio:'inherit'`) | `startP2pChild` | — |
| запуск **после** `bindKey`: ключ уже на диске | `main()` | 52.1 ← ключ |
| `SIGINT` гасит ребёнка (нет осиротевшего libp2p на порту) | `main()` → `stopP2pChild` | — |
| нет `p2p-node` рядом → `null` и честный текст, не падение | `findP2pWorker` | 53.5, 53.6 |

**Multiaddr НЕ захардкожен — и это осознанно.** `p2p-worker.js` спрашивает
`GET /p2p/bootstrap` и получает адрес того, кто реально слушает порт. Хардкод
молча протухает при переезде узла; через bootstrap расхождение видно сразу.
Переопределить сервер можно `TARNET_PUBLIC_URL`, а не правкой кода. Директива
предлагала хардкод как вариант — выбран bootstrap, потому что он уже работал.

**Почему дочерний процесс, а не libp2p внутри воркера.** Сборка воркера запрещает
внешние `require` (`build-worker.js`), а libp2p — 105 МБ. Вшить его в один файл
значит сломать установку без зависимостей. Поэтому транспорт остаётся отдельным
процессом, но запускается сам.

**Установщик качает ОДИН файл — `p2p-node/` рядом не будет никогда.** Это не
дефект, а факт: `install.bat.tpl` тянет только `/download/worker.js`. Поэтому
отсутствие `p2p-node` обязано давать `null` и текст «нужен клон репозитория»,
а не `Cannot find module`, который человек прочитает как «воркер сломан».

**Swarm с ОДНИМ воркером не включается — это правильное поведение.**
`swarm.enabled: false` + названная причина (`no_workers` / `single_worker`).
`enabled: true` требует двух разных воркеров. Ждать `enabled` на одном
воркере — значит ждать того, чего код намеренно не делает.

**Доказательства.** Полный набор: **1121 ✅ / 0 ❌** (`RC=0`), из них 6 — новая
секция 53. Сборка `dist/tarnet-worker.js` 106 КБ, `--p2p` внутри.

### Б.21. Срез 06.11.2026 — `2.22.6-p2p-flag`, приёмка подтверждена, внешний узел ждёт подключения

**Четыре набора, а не один.** `node test-dpouw.js --test` → **1121 ✅ / 0 ❌**,
`node test-mesh.js` → **25 ✅ / 0 ❌**, `node proof-treasury-gate.js` →
**13 ✅ / 0 ❌**, итого **1159 ✅ / 0 ❌**. Секция 53 (6 проверок) — флаг `--p2p`.
Пропусков нет: `linkedom` установлен, поэтому 8 XSS-проверок в прогоне **шли**,
а не были `SKIP`. Прошлый срез показывал 1112 + 8 `SKIP` — это была не потеря
тестов, а отсутствие одной зависимости.

**`package-lock.json` больше не отстаёт.** `package.json`, `lock.version` и
`packages[""].version` — все три `2.22.6-p2p-flag`. `npm ci --dry-run` → `RC=0`.
Раньше лок держался на `2.21.3`; расхождение чинилось `npm install --package-lock-only`.

**P2P готов принять внешний узел — проверено снаружи, а не изнутри VPS.**

| Что проверено | Результат |
| :--- | :--- |
| `p2p-bridge.service` | `active`, `libp2p : listening 0.0.0.0:4001` |
| Порт `4001` снаружи (TCP-коннект, не `curl`) | **OPEN** |
| `https://v1107336.hosted-by-vdsina.com/p2p/bootstrap` | отдаёт `/dns4/.../tcp/4001/p2p/12D3KooWRjbDE4…` |
| `https://…/health` снаружи | `buildVersion 2.22.6-p2p-flag` (за Caddy, порт `3001` наружу **закрыт**) |
| `connections` в bootstrap | **0** — внешний узел ещё не подключался |
| `announced_total` | 1 — мост объявляет только себя |

**Ловушка, в которую я почти вписал ложный блокер.** `curl` к `195.63.131.172:3001`
снаружи не отвечает, и это легко прочитать как «сервер недоступен, поэтому ПК не
подключится». Неверно: перед Node стоит Caddy на `443`, `3001` слушается только
локально (`127.0.0.1`, а `*:3001` — внутри хоста), а наружу отдаётся `443`.
Правильная проверка — `https://…/health`, а не порт приложения.
**Вывод: `connections: 0` — это «воркер ещё не запущен», а не «сеть не пускает».**

**Диск: 635 МБ свободно (94%).** `npm cache clean --force` дал +126 МБ
(`509M → 635M`), `~/.npm` ужат до `2.2M`. Это единственный рычаг, который
сработал без риска: `.zst` и транскрипты уже проверялись ранее и места не дали.
Цель «1 ГБ» недостижима изнутри контейнера — измерено, а не предположено.

**Локальное дерево после аварийного `npm ci` неполное — и это надо знать до сборки.**
В `node_modules` есть `express`, `ws`, `cors`, `@noble/ed25519`, `linkedom`
(`14M`), но **нет** `esbuild`, `@xenova/transformers`, `onnxruntime-node`:
`npm ci` был убит нехваткой места и снёс каталог. На VPS эти пакеты на месте
(проверено: `148` каталогов, `onnxruntime-node` и `@xenova` присутствуют) —
прод не пострадал. Локальная сборка `dist/tarnet-worker.js` и PII-классификатор
(ONNX-путь) здесь **не запустятся**, пока зависимости не восстановлены на
свободном диске.

### Б.22. Срез 06.11.2026 10:31 — `2.22.7-installer-p2p-and-cleanup`: установщик привозит P2P

**Что было не так (и почему это был блокер сети, а не косметика).**
Флаг `--p2p` (2.22.6) поднимает libp2p дочерним процессом, но
`findP2pWorker()` ищет `p2p-node/p2p-worker.js` **рядом с воркером**. Установщик
качал ровно один файл `tarnet-worker.js`, поэтому в `%LOCALAPPDATA%\TarNet`
этого каталога не было никогда: флаг молча уходил в WS. Симптом совпадал с
«забыли второе окно» — воркер жив, `ws активен`, мост показывает
`connections: 0`. Сеть из двух узлов оставалась ручной сборкой на клоне
репозитория, то есть не продуктом.

**`GET /download/p2p-node.zip` — новый маршрут.** Собирается на `node:zlib`
своим zip-писателем (`p2p-bundle.js`): `zip` CLI нет ни локально, ни на VPS, а
`archiver` — лишняя прод-зависимость. CRC32 свой, потому что `zlib.crc32`
появился только в Node 22.2, а сервер объявляет `>=22`.

| Что в архиве | Почему |
| :--- | :--- |
| 8 модулей `*.js` + `package.json` + `package-lock.json` | Это и есть граф импортов p2p-node целиком |
| **нет** `node_modules` (105 МБ / 11 464 файла) | Ставится установщиком по lock: `npm ci --omit=dev` — 213 пакетов, 6 с, 101 МБ (проверено на VPS) |
| **нет** `data/` | Там `peer-id.bin` — приватный ключ узла. Раздача отдала бы личность узла каждому скачавшему |

Размер: **205 341 байт исходников → 52 740 байт архива**, 10 записей.
Проверка целостности: `python3 zipfile.testzip()` → `None`; `crc32("abc")` →
`352441c2` (эталонное значение).

**Установщики.** `install.bat.tpl` и `install.command.tpl` теперь качают архив,
распаковывают его в папку воркера, ставят зависимости `npm ci` и проверяют,
что `import('libp2p')` реально работает **на машине пользователя** — до
объявления установки успешной. Флаг `--p2p` попадает в `start.cmd` /
`start.sh` **только при `P2P_OK=1`**: флаг без транспорта оставил бы рабочий
WS-воркер плюс предупреждение в каждом логе запуска.

Отказ на любом шаге p2p — это `WARNING` и продолжение работы на WS, а не
падение установки: воркер без libp2p работоспособен, и человек не должен
остаться без установки из-за 105 МБ зависимостей.

**Мёртвая константа «ставка утилизации в bps» удалена.** Объявлялась в
`config.js` с 2.17.0, не читалась нигде (`grep` → 1 вхождение, само
объявление); ставка берётся из `TAR_UTILITY_BURN_RATE` +
`TAR_UTILITY_TREASURY_RATE`, единственное применение —
`economics.js:115-116`. Риск был не в лишней строке: следующий исполнитель
поправил бы её, перезапустил сервис и решил, что изменил ставку.

**Приёмка: 1170 ✅ / 0 ❌** — `test-dpouw.js --test` **1132** (+11 секции 54),
`test-mesh.js` **25**, `proof-treasury-gate.js` **13**. Все три набора `RC=0`.
Один `SKIP` (ONNX NER не загружен) — не потеря проверки, а отсутствие модели.

**Раскатано и проверено снаружи 06.11.2026 10:5x, а не только в коде.**

| Что проверено | Результат |
| :--- | :--- |
| `https://…/health` снаружи | `buildVersion 2.22.7-installer-p2p-and-cleanup` |
| `https://…/download/p2p-node.zip` | **HTTP 200, 52 485 байт** — маршрут живой на проде (был 404) |
| HEAD на VPS | совпал с GitHub и локальным, `git status --porcelain` → **0** |
| GitHub `refs/heads/main` | `25c57e8` — совпал с VPS и локальным |
| `tarnet` / `p2p-bridge` / `litestream-tarnet` | все три `active` |
| `p2p-bridge` announce | раз в минуту, `всего объявлено: 1` |

**Чего этот срез НЕ доказывает.** `connections: 0` на мосте по-прежнему
означает «внешний узел не подключался», а не «код не готов». Установщик чинит
**доставку** транспорта, но сеть из двух хостов появляется только когда
второй узел реально запустится. P1.1 не закрыт этим коммитом.

### Б.23. Аудит положения 07.11.2026 — `2.22.9-manus-audit-fixes`

Срез по живой БД (`/var/lib/tarnet/tarnet.db`), `/health`, `/summary`, `/nodes`,
суточным бэкапам `/tmp/tarnet-backup/` и `git log`. Читать вместе с §0 «Где
проект сейчас» в `ROADMAP.md`; здесь — то, что подтверждено прямым запросом.

**Что работает (проверяемо).** `buildVersion: 2.22.9-manus-audit-fixes`,
`conservation.delta: 0`, `holds: true`, `burnAudit.delta: 0`,
`treasuryAudit.delta: 0` (`accrued 0.191388` = `actualBalance 0.19815` минус
self-payout `0.006762`), `receipts: 784`, `onchainSettlements: 17`
(все `simulated: true`), приёмка `1164 ✅ / 0 ❌ / EXIT=0`. Мост
`bridge.ok: true`, `/p2p/bootstrap` отдаёт
`/dns4/v1107336.hosted-by-vdsina.com/tcp/4001/p2p/12D3KooWRjbDE4…`.

**Что остановилось.** Последний чек `seq 784` — `05.11.2026 20:51 UTC`; на срез
07.11 09:0x это **33 часа без квитанций**. `active_workers: 0`,
`mode_reason: no_workers`, `bridge.connections: 0`, `tasks.framesIn: 0`,
`registry: {total: 0, has_public_nodes: false}`. Рост по суточным бэкапам:
`04.11 → 778`, `05.11 → 781`, `06.11 → 784`, `07.11 → 784` — ноль за сутки.
`mtime` базы `08:11` — это рестарт при деплое, а не запись.

**Три числа, которые нельзя цитировать без базы.**

| Публикуемое | Значение | Что это НА САМОМ ДЕЛЕ |
| :--- | ---: | :--- |
| `workers: 94` | 94 | различных адресов **за всю историю**, не размер сети; `/worker/status` → `active_workers: 0` |
| «выплачено `138.98 TAR`» | 138.98 | сумма вместе с посевом и фикстурами: `padding` 37.8%, `malformed` 16.6%, `zero-tail` 17.1%, нормальные адреса — **28.6%** |
| «`94` воркера» / «`149` узлов» | 149 | строк в `/nodes` (реестр регистраций), `worker_presence` — 14 строк |

**Посев первого дня.** 654 из 784 чеков (83.4%) созданы 22.10 и дали лишь 8.0%
выплат (11.18 TAR). После 22.10 — **93 чека / 100.84 TAR / 26 адресов**, из них
только 2 адреса имеют ≥10 чеков. Крупнейшие балансы — фикстуры:
`0x0000…1a16045cd33` (44.196 TAR), `0xdemo…demo` (20.503), `0x7c0ffee…beef` (8.112).

**Дефект публичного поля `balances.stakedTar`, найденный этим аудитом.**
Сумма по таблице — **9 711 816 TAR** против **1 440 TAR** в `nodes.stake`
(144 узла × `BOOTSTRAP_STAKE 10`). Расхождение у 141 адреса, максимум
`0x2e448499…` — `stakedTar 235652.65` при `nodes.stake 10`. Наследие сборки, где
`stake` принимался из тела запроса. **Маршрутизация не затронута** — она читает
`node.stake` (`server.js:2311`), — но `GET /balance/:address` и `GET /balances`
(`server.js:3220, 3231`) отдают это число наружу, и по `usdPerTar 20` оно
читается как $194 млн застейканного. Поле требует либо пересчёта из `nodes`,
либо явной пометки в ответе; это задача, а не «цифра в доках».

**Слои (не усреднять).** Леджер/учёт — 95%. Экономика — 80% (инвариант
«≥50% внутренней утилизации» не выполняется: `0.000012 TAR` = 0.000009%).
Продуктовая поверхность — 50% (PWA, TarNet ID, 18 моделей, привязка).
Сеть исполнителей — **5%** (`connections: 0`, история на 83% посев).
Децентрализация — 2% (`0 .sol`, `simulated: true`, комитет 0 из 5 при
`validatorEligible: 23`). **Связывающее ограничение — сеть исполнителей.**
Леджер считает идеально то, чего пока не существует.

**Выживание.** Казна `0.19815 TAR` × `usdPerTar 20` = **$3.96** против
`monthlyOpexUsd: 517` = **0.77% одного месяца**. Проект живёт на хосте, который
уже оплачен, но операционного запаса нет.

### Б.24. Архитектурный аудит 07.11.2026 — где фундамент, а где фасад

**Зачем эта секция.** Б.23 ответила «сколько». Здесь — «из чего построено и что
не выдержит нагрузки». Проверено чтением кода и прямым чтением прод-БД
(`/var/lib/tarnet/tarnet.db`, 44 таблицы), а не по документам.

#### Б.24.1. Корень доверия — один ключ на всю историю

`GATEWAY = deriveGatewayKey()` (`server.js:244`) выводится через HKDF из
`MASTER_KEY` на том же хосте. Все **784 чека подписаны этим одним ключом**
(`signatureAlg: ed25519` — 784/784). Воркер свою работу подписывает, но **чек
выпускает шлюз**, а не воркер.

Что это значит архитектурно: цепочка `prevReceiptHash`/`receiptHash` защищает от
ретроактивной подмены (переписать чек = пересчитать всё после него). Но
**независимости подписанта нет**: ключ и БД лежат на одной машине. Это
«сервер с аудируемым журналом», а не «сеть с распределённым консенсусом».
Честная формулировка для внешних материалов: **auditable ledger, single issuer**.

#### Б.24.2. Что именно проверяется — форма, а не работа

`economics.js:52 verifyQuality()` проверяет четыре признака формы:
`positiveTokens`, `nonEmptyResponse`, `knownAdapter`, `plausibleVolume ≤ 1e8`.
**Перевыполнения нет**: ни один модуль не запускает работу повторно и не
сравнивает с эталоном (`grep recompute|referenceOutput|majority` → 0 совпадений).

Выборка — 5% (`SPOT_CHECK_SAMPLE_PCT`), детерминированно по хешу `actionId`.
Решение детерминированное, это правильно (не играет в вероятности). Но проверка
внутри выборки — та же проверка формы.

Следствие: **dPoUW сейчас означает «работа объявлена и оплачена по форме».**
Объём работы (`tokens`) приходит из тела запроса и воркер подписывает
собственное объявление: `TARNET_WORK_SUBMIT:<addr>:<tokens>:<tier>:<actionId>:<ts>`.
Подпись доказывает «я это заявил», а не «это произошло». Потолка на `tokens` в
`/work` нет; ограничение `1e8` живёт только в проверке формы.

Регистрация узла **требуется**, но барьером не является: `recordWork`
(`server.js:2151`) читает `SELECT ... FROM nodes WHERE address = ?` и при
отсутствии строки бросает `UNKNOWN_WORKER` («register it via POST /node first»).
Однако `POST /node` открыт и бесплатен, а `stake`/`reputation` при регистрации
принудительно заменяются на `BOOTSTRAP_STAKE 10` / `BOOTSTRAP_REPUTATION 0.5`
(до исправления клиент мог прислать `stake: 999999` и получить завышенный вес —
это и есть источник раздутого `balances.stakedTar`). Итог: **регистрация есть,
но ничего не удостоверяет** — ни личность, ни железо, ни stake.

#### Б.24.3. Механизмы, которые есть в коде, но мертвы численно

| Механизм | Где | Почему не работает |
| :--- | :--- | :--- |
| `reputation` в `√stake × reputation` | `economics.js:91 omega()` | **Не выводится из работы.** В коде прода нет ни одного `UPDATE nodes SET reputation` (есть только в `test-dpouw.js`). Значение присваивается один раз при регистрации: новый узел — `BOOTSTRAP_REPUTATION 0.5`, существующие — наследие до фикса, когда `reputation` брался из тела запроса (`0.9` в `proof-onion-*.js`). Текущее распределение: `0.9` — 76 узлов, `0.5` — 8, `0` — 4, остальные единичны. **Множитель не является сигналом качества — это замороженный артефакт регистрации** |
| Дифференциация маршрутизации | `server.js:2019 routingWeight()` | `stake` почти у всех = 10 (144 из 149, пять — 0), поэтому разброс веса создаётся **только репутацией**: 39 различных `routingWeight` из 149, диапазон **0 … 3.13**. Численно механизм работает, но **не на данных о качестве**: вес не меняется от исхода spot-check |
| Комитет валидаторов | `selectCommittee()` | `benchmark_runs` = **0 строк**. Жребий не тянулся ни разу |
| Slashing | — | **Механизма нет вообще** (`grep slash\|penal` → 0). Ставка ничем не обеспечена |
| «Ключ как воркер» (Фаза 2.5) | `server.js:827` | Схема создана намеренно: `key_limits`, `key_usage`, `user_keys` — **0 строк каждая** |
| Он-чейн | `server.js:3102` | `simulated: true` **захардкожен**, 17 записей с `txHash = randomBytes(32)` |

Итого: **9 из 44 таблиц пусты** (20% схемы инертно). Это не дефект —
схема-первой заявлена как осознанная практика. Дефект в другом: мёртвые
механизмы **перечислены в MANIFEST как работающие**.

#### Б.24.4. Несовместимость адреса с он-чейном

`address = '0x' + sha256(SPKI DER).slice(0, 40)` (`server.js:239`). Это
**SHA-256 от Ed25519-ключа**, обрезанный до 20 байт. Не `keccak256`, не
`secp256k1`. Визуально неотличим от Ethereum-адреса, но:

- восстановить из него ключ EVM нельзя — другая кривая;
- значит «перенос TAR в контракт» требует **новой схемы ключей**, а не бриджа;
- 0 файлов `.sol` в репозитории подтверждает: решение ещё не принято.

Это архитектурное решение, которое **надо принять до контрактов**, а не после.

#### Б.24.5. Двойной транспорт, из которых живёт один

| Путь | Где | Состояние |
| :--- | :--- | :--- |
| WebSocket-релеи (`relay1`/`relay2`) | `server.js:5964 tryOnionTransport` | `framesIn: 0` у всех трёх ролей; `listenHost: 127.0.0.1` |
| libp2p-мост | `p2p-node/` | `bridge.ok: true`, но `connections: 0` |

`p2p-worker.js` проксирует задачи в тот же `worker-demo.js` через
`POST /p2p/execute`. Две транспортные реализации для одного потока задач —
источник расхождений. **ROADMAP уже запрещает третью** — верно, и по той же
причине первую (websocket) пора либо назвать резервной, либо удалить.

#### Б.24.6. Что построено крепко (не переделывать)

- **`dag-chain.js` (185 строк)** — сцепка `prevReceiptHash`/`receiptHash`,
  `cumulativeCwu`/`cumulativeTar` считаются независимо. Это верный примитив.
- **Идемпотентность** через `actionId`: повтор не создаёт второй чек.
- **Детерминированный spot-check** по хешу, а не `Math.random()` — воспроизводимо.
- **Эмиссия с долей**: `share = (cwu × ω) / denominator`, `denominator` —
  накопленный Σ по эпохе. Формула корректна.
- **Шифрование промптов at rest**: `worker_tasks.encryptedPayload`, ключ в
  памяти процесса (`taskKeys`), `chat_messages` с `payload_enc`/`iv`/`mac_tag`.
  Инвариант «промпт не на сервере» соблюдён по схеме.
- **6 зависимостей** на 10.7k строк ядра; SQLite — встроенный `node:sqlite`.
- **Схема-первой** для Фазы 2.5 — осознанно и задокументировано.

#### Б.24.7. Структурный риск: монолит

`server.js` — **9909 строк, 69 эндпоинтов, 26 require**. Вся бизнес-логика в
одном файле: регистрация, леджер, фаусет, P2P, Tier 6, агенты, чаты, PWA.
Каждая фича расширяет радиус поражения. При 44 таблицах и 12 «волнах» фич это
главный источник будущих ошибок, а не архитектура данных.

#### Б.24.8. Вывод

**Проект построил учёт рынка, у которого нет верификации и нет участников.**
Леджер корректен. Приватность по схеме соблюдена. Транспорт работает, но пуст.
Фундаментальный вопрос — «откуда сеть знает, что работа выполнена» — **не решён
ни одним из трёх способов**, которые для него существуют: перевыполнение,
TEE-аттестация, пересчёт со слэшингом. Схема `node_attestations` (1 строка)
показывает, что третий путь задуман, но не подключён.

### Б.25. Срез 07.11.2026 11:35 — `2.22.10-p1.2-autostart`: узел, который не надо поднимать руками

**P1.1 закрыт живым фактом 07.11 11:08 MSK** (`bridge.connections: 1`,
`tasks.framesIn: 2`, `channels: 1`, задача выполнена воркером `0x209a5200…`).
**P1.2 открыт** — другой вопрос: есть ли узел, который не надо поднимать руками.

**Что работает сейчас (проверено кодом и тестами):**

- `install/install.bat.tpl` (386 строк) кладёт ярлык `TarNet Worker.lnk` в папку
  Startup через `[Environment]::GetFolderPath('Startup')`. Ярлык запускает
  `start.cmd`, **не** `node.exe`: `--p2p` добавляется в `start.cmd` только при
  `P2P_OK=1`, поэтому автозапуск и ярлык на рабочем столе имеют одно определение
  запуска и не расходятся.
- Отказ создания ярлыка **сообщается** (`goto autostart_failed`,
  «will NOT start by itself»), а не проглатывается.
- Тесты `31.26`–`31.26e` (5 проверок) читают **шаблон**, а не отдачу: баг живёт
  в шаблоне, рендер его маскирует. Держат: `GetFolderPath` вместо склейки
  `%APPDATA%` (папка локализована), цель `start.cmd` без `node.exe`, ветку
  `--p2p`, честный текст отказа, чистый ASCII и отсутствие CR.
- **Прогон:** `test-dpouw.js --test` — **1169 ✅ / 0 ❌**; `test-mesh.js` — 25/0;
  `proof-treasury-gate.js` — 13/0. Итого **1207**, EXIT=0. Изолированный сервер
  на временной БД, прод не затронут.

**Чего это НЕ даёт.** Автозапуск на машине владельца живым перезапуском **не
проверен** — только шаблон и тесты. Строка `Autostart: worker starts automatically`
в консоли подтверждает создание ярлыка, а не запуск. Автозапуск реализован
**только для Windows**: `install.command.tpl` (macOS/Linux) его не получил.

**Условие готовности P1.2:** после перезагрузки ПК владельца `active_workers ≥ 1`
и `bridge.connections ≥ 1` **без ручного запуска** в течение 10 минут.

**Правка нумерации.** Прежние `P1.2` (эмиссия против спроса) и `P1.3` (запас казны)
сдвинуты в `P1.3` и `P1.4`: автономность — это сеть, а не спрос, и она идёт раньше.

**Ошибка, найденная первым прогоном (полезно помнить).** `31.26` сначала падал с
`getFolderPath: 2`: фильтр теста брал **комментарий**, где тоже написана строка
`GetFolderPath('Startup')`, то есть проверялась проза. Два красных теста означали
неверный **тест**, а не неверный код — чинить надо было тест.

### Б.26. Срез 07.11.2026 12:14 — `2.22.11-p1.2-finalize`: задача уходит адресату, допуск — по ключу

**Что изменилось по существу (не косметика).**

- **Дефект адресации в мосте, найденный при разборе «кому уйдёт задача».**
  `taskClient.send` (`p2p-node/task-protocol.js`) брал **первый живой канал**
  (`[...channels].find(c => !c.closed)`), не глядя на адрес. С одним воркером
  это невидимо; с двумя — задача, выпущенная на `A`, уходила `B`, `B` её
  исполнял, а `POST /worker/submit` отвечал `409` «issued to another worker».
  Работа оплачена временем воркера, ответ потерян, строка висела до TTL.
  Теперь `send(msg, { address })` выбирает канал, у которого
  `String(c.address).toLowerCase() === want`; при отсутствии такого канала
  бросает **`NO_CHANNEL_FOR_WORKER`** (а не `NO_TASK_CHANNEL` — молчаливый
  фолбэк на чужой канал и был дефектом). Цепочка проброса: `bridge.js` берёт
  `msg.address` → `p2p-bridge-client.js task(payload, {address})` → мост.
  `NO_CHANNEL_FOR_WORKER` добавлен в `P2P_SAFE_TO_REQUEUE`: задача
  возвращается в очередь, а не сгорает.
- **`scripts/authorize-peer.js` — допуск по ключу, а не по адресу.**
  В `authorized-peers.json` лежат пары «адрес → 64-hex Ed25519-ключ», и мост
  проверяет **подпись** `hello`. Скрипт «просто дописать адрес» создал бы
  строку, которую `loadAllowlist` молча выбросит. Поэтому: адрес привязан →
  перепубликация списка из базы (код 0); не привязан и дан `--pubkey` →
  явная привязка (0); не привязан без ключа → честный отказ (3); к адресу
  привязан другой ключ → отказ (4), а не тихая замена. Публикация **из
  `ws_worker_auth`**, не дописыванием в файл: файл перезаписывается целиком
  при каждом handshake, и дописанная руками строка исчезла бы на первом же
  рукопожатии. Запись через temp+rename, режим `0600`, обратное чтение тем же
  фильтром, что у моста.
- **`scripts/check-autostart.js` — проверка следствия, а не причины.**
  Опрашивает `/health` и `/p2p/status`, ждёт `active_workers ≥ 1` **и**
  `bridge.connections ≥ 1` в окне (по умолчанию 600 с). Код 0 — узел в сети,
  1 — таймаут с названной причиной, 2 — плохой аргумент. Честное ограничение
  записано в самом выводе: факт перезагрузки сервер не знает (у него нет ни
  загрузок ОС, ни метки ребута), поэтому «без ручного запуска» — условие
  сценария, а не измеренный факт.

**Прогон:** `test-dpouw.js --test` — **1182 ✅ / 0 ❌**; `test-mesh.js` — 25/0;
`proof-treasury-gate.js` — 13/0. Итого **1220**, все три `EXIT=0`. Новые
секции: `58.1`–`58.7` (authorize-peer: отказ без ключа, привязка, права файла,
повтор без пересоздания, отказ при чужом ключе, ключ не сменился после отказа),
`59.1`–`59.3` (check-autostart: готовность по двум условиям, таймаут, названная
причина), `60.1`–`60.3` (адресация: задача ушла **только** A, ответ от A,
`NO_CHANNEL_FOR_WORKER` на чужой адрес). Проверено и отдельно пробой:
`ушло в A: true | в B: false`.

**Чего это НЕ даёт.** Условие готовности P1.2 (`active_workers ≥ 1` и
`bridge.connections ≥ 1` без ручного запуска после перезагрузки) **не
выполнено** — на 12:14 в проде `active_workers: 0`, `connections: 0`. Скрипты
готовы, но проверка требует, чтобы владелец перезагрузил ПК и не запускал
воркер руками.

### Б.27. Срез 07.11.2026 12:38 — `2.22.12-swarm-prep`: рой перестал быть «дважды одному»

**Что проверялось и почему это не формальность.** Директива просила «убедиться,
что `swarm: true` создаёт две задачи, раздаёт их двум разным воркерам по их
адресам и отправляет `CANCEL` проигравшему». Чтение кода показало, что
**раздачу по адресам рой не делал**, хотя правка моста (`2.22.11`) уже была
на проде.

- **Дефект 1: `dispatchTaskOverP2p` игнорировал адрес руки.** Стояло
  `channels[0]` — первый P2P-канал. С одним узлом невидимо; с двумя обе руки
  уходили **одному** воркеру, он считал два раза, а `workerAddress` второй
  строки перезаписывался на того же адресата. «Параллельно двум» оказывалось
  «дважды одному» — и оплачивалось как две работы. Исправлено:
  `preferAddress` передаётся из `forceWsAddr || workerAddress`, выбор — по
  совпадению адреса, при отсутствии — `NO_CHANNEL_FOR_WORKER` (строка остаётся
  `pending`, её заберёт `/worker/poll`).
- **Дефект 2: пара для роя бралась только из WS-реестра.** `pickLeastBusy`
  перебирает `this.workers`, а туда попадает лишь воркер с **открытым** сокетом
  `/p2p/worker`. Воркер, у которого WS не поднялся (штатный откат «работаю на
  опросе» — прокси, старый сервер), в реестре отсутствует, хотя получает задачи
  опросом и по libp2p. С двумя живыми узлами рой ответил бы `need_two_workers` —
  «сеть не умеет рой» при живой сети. Теперь пара собирается из **двух**
  источников: WS по загрузке, затем P2P-каналы, повтор адреса отсекается.

  **Поправка к первой редакции этой записи.** Сначала здесь было написано, что
  демо-воркер владельца работает с `--no-experimental-websocket`. Это **неправда,
  придуманная мной**: флага нет ни в одном лаунчере (`grep -rn
  no-experimental-websocket install/` → пусто), установщик запускает
  `node worker-demo.js --p2p`, и Node 24 имеет глобальный `WebSocket` — воркер
  владельца попадёт в WS-реестр. Дефект от этого не исчезает, но его причина
  другая: он про **отказ** WS, а не про конкретную конфигурацию. Флаг — способ
  воспроизвести отказ (и он остаётся в разделе про проверку P2P-маршрута), а не
  факт о чужой машине.

**`p2p-channel-pick.js` — почему отдельный модуль.** Оба дефекта жили в
`server.js` и проверялись только чтением: для живого прогона нужен мост и два
настоящих узла. `pickChannel` и `pickSwarmPair` — чистые функции, проверяются
обычным `node` и покрыты секцией `61`. Это не украшательство: одно и то же
правило ломалось дважды в двух разных местах, и второй раз — через час после
починки первого.

**CANCEL проигравшему — проверено, работает без правок.** `cancel` в
`task-protocol.js` уже фильтрует каналы по адресу (`c.address === want`), а
`server.js` берёт адрес **из строки задачи**, а не из «мы выбирали этого
воркера» — после requeue исполнитель мог смениться. Порядок «сначала WS, P2P
только если WS не ушёл» сохраняет один кадр отмены на один ПК. Закреплено
тестами `47.5b` (проигравший получил `CANCEL` со своим `taskId`), `47.5c`
(победитель не получил), `47.5d` (в ответе перечислены реальные адресаты).

**Прогон:** `test-dpouw.js --test` — **1209 ✅ / 0 ❌**; `test-mesh.js` — 25/0;
`proof-treasury-gate.js` — 13/0. Итого **1229**, все три `EXIT=0`. Новая
секция `61` — 9 проверок: адресная доставка, отказ вместо подмены, сохранение
поведения одиночной ветки, `excludeSet`, пустой список, пара из двух
источников, **два P2P-узла без WS**, один адрес без дубля, пустые источники.

**Чего это НЕ даёт.** Живой рой на двух узлах **не прогонялся**: второй узел —
ПК владельца — ждёт перезагрузки (P1.2). Проверены логика выбора, адресная
доставка и отмена; фактическая параллельная генерация на двух машинах —
следующий шаг, а не сделанное.

### Б.28. Срез 07.11.2026 13:35 — «только P2P» переключателя не существует, и флаг мосту не нужен

**Что просили проверить.** «Убедиться, что в `p2p-bridge.service` включён
`--no-experimental-websocket` (или его аналог), чтобы задача шла строго по P2P».

**Почему это невыполнимо — три независимые причины, каждая проверена:**

1. **Мосту флаг нечего выключать.** `p2p-node/bridge.js` не использует
   WebSocket вообще: транспорт — Unix-socket `/tmp/tarnet-p2p-bridge.sock`
   (0600) плюс libp2p. Единственное вхождение слова — комментарий
   «Не WebSocket: у нас нет…». У `p2p-node/p2p-worker.js` вхождений **ноль**.
   Флаг выключил бы глобальный `WebSocket` в процессе, который его не трогает.
2. **Выбора WS/P2P на сервере нет.** `grep -rn "P2P_ONLY|FORCE_P2P|disableWs|WS_DISABLED"`
   по репозиторию → пусто. Маршрут определяется **состоянием строки задачи**:
   WS-ветка идёт первой, P2P-путь стартует только если строка осталась
   `pending` (`server.js:7215`). Это защита от двойной генерации, а не флаг.
3. **Рычаг находится на воркере, а не на VPS.** Чтобы задача пошла строго по
   P2P, у воркера должен отсутствовать WS — это `--no-experimental-websocket`
   на ПК, а не настройка моста. Поэтому директива просила изменить не тот
   процесс.

**Следствие, которое важнее самой правки.** Воркер владельца запускается
установщиком как `node worker-demo.js --p2p`, а Node 24 имеет глобальный
`WebSocket` (`typeof WebSocket` → `function`) — значит его WS-ветка **жива**, и
задачу он получит по WS, а не по P2P. Это нормально: `2.22.6` поднимает
p2p-ребёнка после `bindKey`, и `bridge.connections` становится ≥ 1 независимо
от того, каким транспортом пришла задача. То есть критерий P1.2
(`bridge.connections ≥ 1`) достижим, а «задача строго по P2P» — нет, и требовать
этого от автозапуска не нужно.

**Проверено живьём (13:30 MSK):** снаружи `/p2p/bootstrap` отдаёт
`/dns4/v1107336.hosted-by-vdsina.com/tcp/4001/p2p/12D3KooWRjbDE4rzafznjsd4aDu3S4Z1exHcPKSw2MeH4WcVEZpy`,
порт 4001 открыт, мост `libp2p: listening 0.0.0.0:4001`, `peer_id_persistent: true`,
`connections: 0`. Второму узлу есть куда подключаться.

**Долг честности.** В первой редакции §Б.27 я написал, что демо-воркер владельца
работает с `--no-experimental-websocket`. Это выдумка: в `install/` флага нет ни
одного. Исправлено в MANIFEST, HISTORY, ROADMAP, `p2p-channel-pick.js`,
`server.js` и `test-dpouw.js`.

### Б.29. Срез 07.11.2026 15:15 — `2.23.0-reality-check`: Манифест против Whitepaper v1.0

**Что просили.** Остановиться, залезть под капот и зафиксировать, что реально
есть, сверив с изначальным видением. Отдельно — сверить три репозитория:
локально, GitHub, боевой VPS.

**1. Три репозитория идентичны — это проверено побайтово, а не «должно быть».**

| Место | Коммит | Версия |
| :--- | :--- | :--- |
| Локально | `78b6ab1c` | `2.22.13-wait-for-reboot` |
| GitHub `origin/main` | `78b6ab1c` | — |
| VPS `/opt/tarnet/backend-api` | `78b6ab1c` | `2.22.13-wait-for-reboot` |

Хеши `server.js`, `ledger.js`, `config.js`, `economics.js`, `jcs.js` совпали
во всех трёх местах. Грязного дерева нет нигде.

**Отдельная ловушка, на которую легко попасться:** каталог `/opt/tarnet` **не
является git-репозиторием**. Код лежит в `/opt/tarnet/backend-api`, репозиторий —
там. `cd /opt/tarnet && git log` → `fatal: not a git repository`. Это структура
каталогов, а не сломанный деплой.

**2. Whitepaper v1.0 в репозитории отсутствует.** `find . -iname "*whitepaper*"`
по всему workspace → пусто. Сверка идёт не с документом, а с его пересказом в
`PROJECT-HISTORY.md:17-18`. Называть это «сверкой с Whitepaper» было бы неточно.

**3. Gap Analysis — четыре категории, полная таблица в `docs/REALITY-CHECK-v3.md`.**

* **Реализовано:** реестр узлов, роутинг `√stake × reputation`, dPoUW, подписи
  Ed25519, `AES-256-GCM` at rest, инвариант `delta === 0`, эпохи с затуханием,
  батчинг, идемпотентность `actionId`, JCS в Device Linking, подпись
  `/worker/submit`, onion routing, P2P-мост, Swarm, Agent Runtime, LoRA-роялти.
* **Изменено:** лотереи → детерминированный леджер; чистый P2P → гибрид
  WS+P2P+poll; Python → Node; `$0.30–0.50/M` → `$0.20/$0.80/M`;
  Solidity+DAO → `onchain.simulated: true`.
* **Отложено:** TEE-аттестация (флаг в БД, не проверка), смарт-контракты
  (0 файлов `.sol`), реальное обучение LoRA (3 фикстуры), пул ключей.
* **Выброшено:** `$330/мес` с домашнего ПК (арифметика даёт ≈ `$2/мес`),
  полная анонимность, цены `$1.50–2.50/M`.

**4. Экономика — главный разрыв, цифры с `/summary`.**

| Показатель | Значение | Доля |
| :--- | ---: | ---: |
| Чеков / адресов с чеками / узлов в `/nodes` | 787 / 95 / 150 | — |
| Всего выплачено TAR | 147.045798 | 100% |
| — Block Reward (эмиссия) | 139.893324 | **95.14%** |
| — Fee Reward (заработок) | 7.152474 | **4.86%** |
| Внутренняя утилизация | 0.000012 | **0.0000082%** |

Инвариант требовал ≥50% утилизации. Фактически ноль с округлением: механизм
`TAR_UTILITY` исправен и сработал трижды на двенадцать микроТАР.

**5. P2P доказан в бою — и здесь я сначала ошибся.** Прочитал
`/p2p/status` → `framesIn: 0`, `channels: 0` и записал в черновике «P2P не
проверен». Журнал опроверг:

```
Nov 07 11:08:01  p2p: задача wt_9a0a0e938efc79c36c995fcb выполнена воркером 0x209a5200…
Nov 07 11:13:00  p2p: задача wt_75443b28f787bf1780a567f8 выполнена воркером 0x209a5200…
```

**Почему счётчик врал:** `p2p-bridge.service` перезапущен в 13:30:36 MSK — уже
*после* этих задач, а `framesIn`/`channels` живут в процессе и обнуляются при
рестарте. **Урок: счётчик в процессе — это «сейчас», а не «всегда». История
вопроса живёт в журнале.** Проверять надо `journalctl`, а не поле состояния.

Следствие для оценки: транспорт P2P **проверен**, рой из двух одновременных рук —
**нет** (задачи шли по одной с интервалом 5 минут).

**6. Что сделано по директиве.** Создан `docs/REALITY-CHECK-v3.md`; обновлены
`ROADMAP.md` §0 (сборка, чеков 787/95, диск 755M, P2P доказан),
`README.md` (версия `2.22.13`, ссылка на honest-срез вместо тупика на `v2.17`),
`PROJECT-MAP.md` §11 (новый документ в таблице «кто за что отвечает»).

**Честная формулировка итога:** работающий протокол с доказанным P2P-транспортом,
ожидающий сети исполнителей. Не «работающая сеть роевого ИИ». Децентрализации
нет: реестр, балансы, эмиссия и маршрутизация живут в одной SQLite на одном VPS.
Узлы исполняют работу распределённо — координация централизована, и это надо
называть в инвесторских материалах, а не сглаживать.


### Б.30. Срез 07.11.2026 18:10 — роёвый `CANCEL` доказан живым обрывом запроса (`2.23.0-reality-check`)

**Что было открыто.** Рой из двух одновременных рук числился «не проверенным в
бою»: задачи шли по одной с интервалом 5 минут. Кроме того, в прогоне 15:05
ответ содержал расхождение — `cancelled: 1` при `cancelledWorkers: []`.

**Расхождение объяснено, а не списано.** Поле `cancelled` считает
`loserIds.length`, то есть «сколько задач мы решили снять». Поле
`cancelledWorkers` перечисляет **адреса, куда кадр реально записан**. Пустой
список при `cancelled: 1` — не дефект кода, а честный ответ «снимать было
нечего»: при одинаковой задержке обе ветки финишировали за ~70 мс, проигравший
к моменту выбора победителя уже имел статус `done`, и `row.status === 'claimed'`
в `server.js` не выполнялось. Отмена не отправлялась потому, что отправлять её
было некому.

**Чтобы проверить доставку, нужна асимметрия.** Поставлена заглушка Ollama на
VPS с разной задержкой: **первый** запрос — 300 мс (победитель), **все
последующие** — 12 000 мс. Тогда проигравший в момент выбора победителя реально
ещё считает.

**Первый заход был сорван моим же дефектом заглушки.** Она слушала
`req.on('close')`, а в Node это событие срабатывает при дочитывании тела
запроса, а не при уходе клиента. Заглушка решала «клиент ушёл» и не отвечала ни
разу — оба воркера честно уходили в `deterministic_fallback` по таймауту.
Правильное событие — `res.on('close')` с проверкой, был ли ответ уже отдан.

**Второй заход: `llm_mode` остался `deterministic_fallback` с
`reason: ollama_offline`.** Заглушка отвечала на `/api/generate`, но не на
`GET /api/tags` — а воркер судит о живости Ollama именно по нему
(`worker-demo.js:86`, кэш 15 с). Без `/api/tags` медленная генерация не
начиналась вовсе.

**Третий заход — доказательство получено, три независимых источника:**

| Источник | Что показал |
| :--- | :--- |
| Ответ `/inference` | `"cancelledWorkers":["0xa1e49a4b2813ffbb9fc2c7d285247cf9bcfdbba2"]`, `"cancelled":1`, ответ за **0.43 с** при 12-секундной ветке |
| `worker_tasks` в боевой БД | проигравшая `wt_6516bbdb377e502437b42051` → `status: cancelled`, `finishedAt - createdAt = 406 мс`; победившая `wt_92f3ccac8f55d11544a4e7ec` → `done` |
| Лог проигравшего воркера | `[18:07:57] ws: CANCEL wt_6516bbdb… (swarm_loser)` → `задача … отменена сервером — генерация прервана` |
| Заглушка Ollama | `#2 соединение ЗАКРЫТО клиентом через 389 мс — отмена дошла` |

Последняя строка — самое сильное: 12-секундный HTTP-запрос к модели был
**физически оборван** на 389-й миллисекунде. Это не запись в базе и не кадр в
сокете, а прекращённая работа на исполнителе.

**Вывод по рою.** Рой из двух рук проверен в бою: две задачи выданы
одновременно двум разным адресам, победил первый ответивший, проигравшему
ушёл `CANCEL`, его генерация прервана, оплата ушла только победителю. Пункт
«рой не проверен» снимается; в `ROADMAP.md` §0 строка переписана.

**Что НЕ доказано и остаётся открытым.** Отмена проверена по **WS**. P2P-путь
отмены (`p2pBridge.cancel` → `task-protocol.js` → `proxyCancelToLocalExecutor`)
в этом прогоне не сработал, потому что оба воркера имели живой WS и кадр ушёл
первым путём — это и есть заложенный порядок (`wsInbound.cancelTask()` первым,
P2P только если WS не отправил). Проверка P2P-отмены требует воркера без WS,
то есть `node --no-experimental-websocket worker-demo.js --p2p`. Не выдавать
WS-успех за «обе ветки транспорта проверены».

**Временная инфраструктура снята.** Заглушка и оба воркера остановлены по PID
(`pgrep -f` в этой среде опасен: шаблон совпадает с собственной командой
шелла и убивает прогон — проверено дважды, второй раз с обрывом SSH, exit 255).
После снятия: `active_workers: 0`, `llm_mode: deterministic_fallback`, порт
11434 закрыт. Каталоги `/root/w1`, `/root/w2` с ключами временных воркеров
и сама заглушка `/tmp/ollama-stub.js` **удалены 07.11 в 18:2x** — проверено
отсутствием каталогов и `pgrep` по `worker-dem[o]|ollama-stu[b]`.

**Числа на момент среза:** `cancelled` всего в `worker_tasks` = **2**
(одна от прогона 15:05 при пустом `cancelledWorkers`, одна от 18:07 с
подтверждённой доставкой). Считать их «отменёнными в бою» можно только вторую.
### Б.31. Срез 07.11.2026 18:25 — полная сверка перед сводным отчётом (`2.23.0-reality-check`)

**Зачем этот срез.** Владелец попросил развёрнутый отчёт «всё, что известно о проекте
и его состоянии». Такой отчёт нельзя собирать по памяти документов — он должен
опираться на живой прод и код. Сверка нашла **четыре расхождения**, три из них —
документы занижали или искажали реальность.

| Утверждение в документах | Факт на 07.11 18:25 | Вердикт |
| :--- | :--- | :--- |
| «Таблицы `distillation_buffer` нет — Фаза 2.5» | Таблица есть, **9 строк**, пишет `POST /distill/record` | Документ **отставал от кода** |
| «Промпты зашифрованы AES-256-GCM» | `promptText` в БД **открытым текстом**; `encryptSecret()` на этом пути не вызывается | Обещание **не выполнено** |
| «44 таблицы», «64 маршрута», «`test-dpouw.js` 8894 строк / 1086 проверок» | **45 таблиц**, **70 маршрутов** (38/30/2), **10534 строки / 1191 проверка** | Числа устарели |
| «`/root/w1`, `/root/w2` остались на VPS» | Удалены 18:2x; заглушка и воркеры сняты, порт 11434 закрыт | Уборка завершена |

**Три опоры, на которых стоит этот срез.** (1) Приёмка перепрогнана целиком:
`test-dpouw.js --test` → **1191 ✅ / 0 ❌**, `test-mesh.js` → **25 ✅**, `proof-treasury-gate.js`
→ **13 ✅**, итого **1229**, три раза `RC=0`. (2) Схема БД прочитана **напрямую**
через `node:sqlite` на проде, не через API: `SELECT count` по каждой из 45 таблиц.
(3) Каждый адрес из последних пяти чеков найден в `nodes` со `stake: 10, reputation: 0.5` —
то есть последние чеки выданы моим же тестовым стендом, а не внешним узлом.

**Что изменилось в экономике с утра.** Чеков **789** (было 787), адресов **96** (было 95),
выплачено **147.617143 TAR**, из них Block `140.464667` (**95.16%**) против Fee `7.152476`.
Инвариант держится: `gross 148.007719 = distributed 148.007719`, `delta: 0`.
Внутренняя утилизация — `0.000012 TAR` за 3 срабатывания, то есть **ноль с округлением**.

**Поправка к ROADMAP §0, которую надо было сделать раньше.** Там стояло «последний чек
07.11 11:13 MSK — и он прошёл по P2P». На 18:25 последний чек — **12:14 UTC = 15:14 MSK**,
и это роёвая пара от моего прогона. Последний **P2P-чек** остался в 11:13 — P2P-транспорт
не перепроверялся после него. Смешивать «последний чек» и «последний P2P-чек» в одной
строке нельзя: первое отвечает «сеть жива?», второе — «транспорт работает?».

**Чего этот срез НЕ доказывает.** Ничего нового о сети: `active_workers: 0`,
`llm_mode: deterministic_fallback`, `bridge.connections: 0` — все соединения моста
счётчики обнулились при перезапуске в 13:30, а новых не было. Рой и P2P доказаны
на моём стенде, не на чужих машинах.

---

### Б.32. Срез 08.11.2026 00:30 — обещание приватности выполнено, целостность промпта проверяема (`2.23.3-prompt-integrity`)

**Что было не так до этого среза.** Срез §Б.31 зафиксировал худший тип расхождения:
документ обещал «промпты зашифрованы AES-256-GCM», а `promptText` писался в БД
открытым текстом. Второе — сервер не мог отличить «воркер считал отправленный промпт»
от «воркер вернул что-то по другому входу», и `verifyQuality` принимал любой ответ,
лишь бы тот не был пустым.

**Что сделано.**

| Механизм | Где | Что доказывает |
| :--- | :--- | :--- |
| `encryptSecret()` на `promptText` **и** `response` | `server.js:5498-5518` | в БД нет открытого текста |
| `migratePlaintextDistillation()` | `server.js:1629`, вызов на старте (1656) | старые открытые строки перешифрованы, а не оставлены как есть |
| `promptHash` (SHA-256 открытого текста) | `server.js:5497` до шифрования; `server.js:7206` при выдаче задачи | хеш есть там, где нужен, — после шифрования его не пересчитать |
| Сверка `promptHash` в `verifyQuality` | `server.js:7940-7943` | воркер считал именно отправленный текст |
| `promptHash` в ответе воркера | `worker-demo.js:882` | воркер считает хеш по тому, что **реально** расшифровал и выполнил |

**Три состояния, а не два.** Это главное решение среза, и оно про честность отчёта:

- `promptHashVerified = true` — воркер вернул хеш, и он сошёлся;
- `promptHashVerified = false` — хеш не прислан или чужой;
- `promptHashVerified = null` — сверять было нечего: задача создана до `2.23.3`
  (колонка `promptHash` пуста) либо ответ дал не воркер (внешний API, шаблон).

Схлопывание `null` в `false` наказывало бы старые задачи за то, чего сервер у них
не спрашивал, и превращало бы «нет данных» в «провал проверки». В ответе `/inference`
поле отдаётся как `prompt_hash_verified` с теми же тремя значениями.

**Чем подтверждено.** Секция 62 приёмки — 19 проверок, все зелёные:

- 62.2/62.3 — `promptText` и `response` в БД начинаются с `enc:v1:`;
- **62.5 — открытого текста нет ни в `test.db`, ни в WAL.** Проверка читает **файлы**
  и ищет байты промпта. Один только `startsWith('enc:v1:')` этого не поймал бы: SQLite
  держит старые версии строк в свободных страницах и в WAL, и «поле выглядит
  зашифрованным» не означает «на диске шифротекст»;
- 62.6/62.7 — открытая строка, подложенная в БД, перешифрована при старте, в таблице
  не осталось ни одной открытой;
- 62.8/62.9 — **обратная сторона**: после перешифровки `knowledge-loop` собирает
  датасет, и в JSONL попадает открытый текст, а не `enc:v1`. Без этих двух проверок
  шифрование могло бы «пройти» 62.2–62.7 и сломать обучение;
- 62.10–62.18 — все три состояния флага, включая запись в БД (`0` для `false`,
  `NULL` для `null`), чтобы ответ не расходился с хранилищем.

**Найденный по ходу дефект.** Первый прогон дал **1208/1**: тест 62.12 упал на `null`
при уже состоявшейся сверке. Причина — флаг доезжал до `/worker/submit`, но терялся
при сборке объекта `result` из ответа задачи (`server.js:9323`, `9422`): там поля
перечислены поимённо, и новое поле нужно вписать в каждую ветку. Две ветки — одиночная
и роевая — правились обе. Это ровно тот класс ошибки, который не виден при чтении
диффа: поле добавлено в одном месте и «работает» в тестах, которые смотрят на другое.

**Границы.** Шифрование — at rest: защищает файл БД и уехавшую не туда копию, но не
сервер (ключ у него, `knowledge-loop.js:333` расшифровывает перед сборкой датасета).
Сверка хеша доказывает, что воркер считал на том же входе, и **не** доказывает, что
модель реально выполняла промпт, — полная верификация остаётся в Фазе 3.

**Прогон:** `test-dpouw.js --test` → **1209 ✅ / 0 ❌** (было 1191), строк теста 10747
(было 10534), маршрутов 70, таблиц 45. Итого с `test-mesh.js` (25) и
`proof-treasury-gate.js` (13) — **1247**.

---

### Б.33. Срез 08.11.2026 05:05 — пуш работает; «блокер пуша» был ошибкой проверки, репозиторий публичен с 22.10

**Повод.** Владелец спросил: «как так, буквально недавно ты всё пушил нормально и токен
был в порядке». Проверка по сессиям, памяти и файлам дала обратный ответ тому, что было
записано в `MEMORY.md` часом раньше.

**1. Пуш проходит. Доказательство — не рассуждение.**

```
git -c credential.helper= push https://x-access-token:<TOKEN>@github.com/pdkiller666/tarnet-backend.git main
  75d606e..d864573  main -> main          exit 0
local  = d864573d274468560a929a7765ff4292b844f411
remote = d864573d274468560a929a7765ff4292b844f411   совпадают
git rev-list --left-right --count HEAD...FETCH_HEAD → 0   0
```

**2. Где живой токен и почему его «не нашли».**

| Путь | Состояние |
| :--- | :--- |
| `~/.openclaw/credentials/github/personal/pdkiller666/hosts.yml` | **рабочий** `ghp_6O…`, `/user` → `200`, `push: true` |
| `~/.openclaw/credentials/github/system/ghp_31c6dc57…/hosts.yml` | мёртвый `gho_s3…`, `/user` → `401` |
| `$GH_TOKEN` (env) | тот же мёртвый `gho_s3…` |
| `$GH_CONFIG_DIR/hosts.yml` | тот же мёртвый `gho_s3…` (`GH_CONFIG_DIR` указывает на `system/`) |
| `$GITHUB_TOKEN` (env) | пуст |

`scripts/deploy.sh:32` перебирает `$HOME/.openclaw/credentials/github/personal/*/hosts.yml`
и берёт первый читаемый — то есть **штатный путь деплоя был жив всё время**. Проверка
заключила «три источника, четвёртого нет», потому что считала `GH_TOKEN` и
`$GH_CONFIG_DIR/hosts.yml` разными источниками: это один и тот же мёртвый токен из `system/`.

**Класс дефекта.** «N источников дали 401» — не число независимых проверок, если источники
указывают на один файл. Считать надо **различные секреты**, а не обращения к ним.
Правильный первый шаг при выводе «токена нет» — `grep -n 'credentials/github' scripts/deploy.sh`,
потому что скрипт и есть спецификация того, где токен должен лежать.

**3. Репозиторий публичный — с момента создания.**

```
GET api.github.com/repos/pdkiller666/tarnet-backend  (без токена) → 200
visibility: public     created_at: 2026-10-22T07:38:56Z
GET raw.githubusercontent.com/.../config.js          (без токена) → 200
PublicEvent в ленте pdkiller666: 2026-10-22T07:38:56Z
```

То есть отчёт 22.10 («🔒 private») был неверен, и на нём построили решение «оставляем как
есть». Репозиторий **никогда не был приватным**. Что видно снаружи без авторизации:
`server.js`, `config.js`, `ledger.js`, `economics.js`, `test-dpouw.js`, `app/app.js`,
`MANIFEST`, `PROJECT-HISTORY.md`.

**4. Проверка секретов в публичной истории.**

| Что искали | Результат |
| :--- | :--- |
| Токены вида `gh*_…` за всю историю | 4 вхождения, все — **один** `ghp_d000ab…` в `scripts/deploy.sh` и `scripts/verify.sh` (`000e3be` 22.10 → удалён в `f401c1a`) |
| Жив ли он | `api.github.com/user` → **401**, отозван |
| Есть ли в `HEAD` | нет |
| Совпадает ли с живым `ghp_6O…` | нет (сверено посимвольно) |
| Мастер-ключ, `.db`, `.env`, `id_rsa`, `*.pem` в индексе | отсутствуют |
| Живые ключи в `config.js` (публично доступен) | нет |

**Вывод.** Утечки действующих секретов в публичном репозитории нет. Мёртвый токен в
истории — факт, который надо помнить при любом аудите, но он уже бесполезен.

**5. Что этим срезом НЕ изменилось.** VPS остаётся на `2.23.0-reality-check` (живой
`/health` → `200`, `buildVersion: 2.23.0-reality-check`, `active_workers: 0`,
`llm_mode: deterministic_fallback`, `conservation.delta 0`, `holds true`). Раскатка
`2.23.3` — по-прежнему отдельный шаг §P0.10 роадмапа, и боевые 9 строк
`distillation_buffer` на проде пока открытым текстом. Блокер — **раскатки**, не пуша.

---

### Б.34. Срез 08.11.2026 05:15 — репозиторий переведён в **private**; зависимости от публичности проверены

**Действие владельца.** По прямому указанию («переключи в приватный») видимость
`pdkiller666/tarnet-backend` изменена `public → private`.

```
PATCH /repos/pdkiller666/tarnet-backend {"private": true}  → 200
ДО:    visibility=public   private=false
ПОСЛЕ: visibility=private  private=true
```

Права позволяли: `permissions.admin: true`, в scopes токена есть `repo` + `delete_repo`.
Форков на момент переключения — **0**, звёзд — **0**, watchers — **0**, issues — **0**,
network — **0**. То есть отвязывать нечего: GitHub при смене видимости отвязывает форки
от сети, и здесь их не было.

**Проверка снаружи, без токена — экспозиция закрыта:**

| Запрос | Было (public) | Стало (private) |
| :--- | ---: | ---: |
| `GET api.github.com/repos/pdkiller666/tarnet-backend` | 200 | **404** |
| `GET raw.githubusercontent.com/…/config.js` | 200 | **404** |
| `git ls-remote https://github.com/…` | 0 | **128** |

**Проверка, что ничего не сломалось внутри.** Смена видимости опасна тем, что ломает
анонимные потребители. Найдено и проверено:

| Потребитель | Как ходит в GitHub | Итог |
| :--- | :--- | :--- |
| `deploy.sh` шаг 2 | `https://x-access-token:<TOKEN>@…` — токен | ✅ `ls-remote` → `63cbbca`, RC=0 |
| `deploy.sh` шаг 3 | код едет **bundle по SSH**; VPS GitHub не трогает (в шапке скрипта: «у VPS нет доступа к GitHub») | ✅ не зависит |
| `verify.sh:128` | `git ls-remote` с токеном | ✅ тот же путь |
| `push-tag.js:60` | URL с токеном | ✅ тот же путь |
| GitHub Pages | не включён (404) | ✅ нечего ломать |
| Actions workflows | 0 | ✅ |
| Webhooks | 0 | ✅ |
| Releases | 0 | ✅ |
| PWA / установщик | ссылок на `raw.githubusercontent` нет | ✅ |

`push --dry-run` после переключения: `Everything up-to-date`, `local = 63cbbca`.
То есть запись работает, чтение по токену работает, анонимный доступ закрыт.

**Граница.** Приватность закрывает чтение репозитория, но **не** отменяет того, что было
опубликовано ранее: за 17 дней публичности код был доступен без авторизации, и любые
сторонние копии/кеши (в т.ч. поисковые и архивные) от смены флага не исчезают. Секретов
в истории нет (§Б.33) — значит предмет заботы это код, а не ключи.

**Инструкция на будущее.** Любой новый потребитель, которому нужен код, теперь обязан
идти с токеном (`$HOME/.openclaw/credentials/github/personal/*/hosts.yml`) или получать
bundle по SSH. Анонимный `curl` на `raw.githubusercontent.com` больше не работает — если
такой шаг появится в скриптах, он упадёт с 404, а не с «нет файла».

---

### Б.35. Срез 08.11.2026 06:15 MSK — P0-хардненинг: очередь, оплата, автозапуск (`2.24.0-p0-hardening`)

Три дефекта из внешнего аудита (Manus) подтвердились в коде. Ни один не был косметикой:
первые два ломали деньги, третий — доказательство готовности узла.

**1. Гонка очереди ответов в P2P — закрыта.**

`p2p-node/task-protocol.js` держал ожидания в массиве FIFO (`waiters[]`) и отдавал ответ
первому в очереди, не спрашивая, чей он. При двух воркерах медленный A и быстрый B давали
подмену: ответ B засчитывался как работа A. Заменено на `Map<taskId, waiter>` — ответ ищется
по `taskId`, а не по порядку. Ответ без `taskId` или с неизвестным `taskId` не отдаётся
никому и считается сиротой (`orphans` в `stats()`): именно это засчитывание и было дефектом.
`ping` не имеет `taskId` и остался отдельной анонимной полосой (`anon[]`) — смешивать их
значило бы вернуть ту же подмену через служебный кадр.

Проверка: `p2p-node/check-correlation.mjs` (8/8) и тесты 51.12–51.14 в приёмке.
`worker-demo.js:1626,1630,1639` и `dist/tarnet-worker.js` кладут `taskId` в ответ — контракт
соблюдён на обеих сторонах.

**2. `/work` больше не печатает TAR без оплаты.**

Было: `debit()` возвращал `{charged:false}` при отсутствии клиента или нехватке денег, но
`credit()` вызывался всё равно — воркер получал эмиссию за неоплаченную работу. Добавлен гейт
`CONFIG.REQUIRE_PAYMENT` (по умолчанию **true**): без `clientAddress` → `400 CLIENT_REQUIRED`,
при недостатке средств → `402 PAYMENT_FAILED`. Гейт стоит **до** `ledger.append`, поэтому
отказ не оставляет ни чека, ни начисления — проверено чтением `/balance` и `/summary` после
отказа. Дублирующий блок оплаты (79 строк) удалён: две копии одной логики разошлись бы при
первой правке.

`allowUnpaid` — узкое исключение для анонимного `/inference` (первый запрос без кошелька):
`clientProvisioned === true` пропускает гейт, `payment.charged:false` остаётся видимым в ответе.
Анонимный путь с нулевым балансом не начисляет TAR.

`TARNET_REQUIRE_PAYMENT=0` — стенд и приёмка: проверка арифметики κ/γ/CWU не должна требовать
платёжеспособности. Строгий режим проверяется отдельно (`check-payment-gate.js`, 7/7).

Побочно найден и исправлен свой дефект: `PAYMENT_FAILED`, брошенный из `recordWork`, доходил
до общего error-middleware и превращался в `500 Internal server error`. Явный клиент с нулём
видел «аварию сервера» вместо «нет денег». Теперь middleware различает `PAYMENT_FAILED` (402)
и `CLIENT_REQUIRED` (400).

**3. `check-autostart` проверяет ЭТОТ узел, а не «какой-нибудь».**

Прежний критерий `active_workers >= 1 && connections >= 1` выполнялся и тогда, когда после
ребута поднялся чужой воркер. Владелец видел код 0 и делал вывод об автозапуске своего ПК —
при том, что его воркер мог не стартовать вовсе. Теперь скрипт читает адрес из
`~/.tarnet/worker.json` (или `--address`) и требует присутствия **этого** адреса в сети.

Для этого мост начал публиковать `worker_addresses` в `status()` (`p2p-node/bridge.js`), а
`GET /p2p/status` — в блоке `bridge`. Поле нужно именно адресами, а не peerId: в
`connected_peers` лежит `12D3Koo…`, а в `worker.json` — `0x…`, сопоставить их напрямую нельзя.

Без адреса скрипт откатывается на прежний критерий, но **говорит об этом** в выводе: молча
ослабленная проверка хуже отсутствующей. Тест 59.4 — чужой узел при единичных счётчиках даёт
код 1, а не 0.

**Три кода вместо двух — следствие той же правки.** Прод на `2.23.0` поля `worker_addresses`
не отдаёт вовсе. Скрипт с адресом ждал бы всё окно (по умолчанию 600 с) и завершался кодом 1 —
«узел не появился». Владелец пошёл бы чинить автозапуск на исправном ПК, тогда как причина
была бы в версии сервера. Поэтому «проверить нечем» отделено от «проверил, не дождался»:
`0` — узел в сети; `1` — не дождались; `2` — плохой аргумент; **`3` — сервер старше 2.24.0,
сверка по адресу невозможна**, отказ мгновенный и с объяснением, что провала здесь нет.

Пустой `worker_addresses` и отсутствие поля — разные факты, и склеивать их в `[]` нельзя:
первый значит «никто не подключён», второй — «спросить нечем». Для этого в снимке состояния
появился отдельный признак `hasAddressField` (проверка `hasOwnProperty`), а не догадка по
`Array.isArray`. Флаг `--any` отключает сверку по адресу явно — он нужен потому, что
подсказка «проверьте без `--address`» была бы неправдой: при наличии `~/.tarnet/worker.json`
сверка включилась бы всё равно. `--any` с `--address` — код 2.

**Что НЕ проверено.** Автозапуск после реальной перезагрузки ПК владельца не проверялся:
скрипт проверяет следствие (узел в сети), а не причину (ребут был). P1.2 остаётся открытым
до прогона на машине владельца.

**Приёмка:** `1218 ✅ / 0 ❌` (секция 59 расширена до 9 проверок: добавлены 59.5/59.5b/59.5c на
старый сервер, 51.12–51.14 на корреляцию).

### Б.36. Срез 08.11.2026 08:40 MSK — `2.24.0-p0-hardening` на проде: три дефекта аудита закрыты в живом контуре

**Версия на VPS:** `2.24.0-p0-hardening`, `HEAD 30b1cf36` (было `238a7634` = `2.23.0-reality-check`).
`/health` → `200`, `status: ok`; `/app/` → `200`; `tarnet` и `p2p-bridge` — `active`.
`verify.sh`: 9 проверок зелёные, **126/126 файлов sha256** сошлись, дерево чистое,
drop-in применён.

**1. P2P-корреляция — работает в живом контуре.** `task-protocol.js`: ожидания
ответов в `Map<taskId, waiter>`, а не FIFO-массив. Ответ без `taskId` или с
неизвестным `taskId` не отдаётся никому и считается в `orphans`. `ping` — отдельная
анонимная полоса: попади он в общую очередь, переиспользовал бы чужое ожидание.
Закрывает гонку «ответ соседней задачи приняли за свой ответ».

**2. Гейт оплаты — на проде, `REQUIRE_PAYMENT` по умолчанию `true`.**
`debit()` вызывается **до** `ledger.append()`. Это не косметика порядка: у
бесплатного пути реакция — `return`, а возврат внутри `tx()` коммитит. Поставь
оплату после чека — чек о неоплаченной работе остался бы в цепочке подписей,
`pending_work` удалён, эпоха сдвинута; гейт закрывал бы дефект, воспроизводя его
в новой форме. Коды: `CLIENT_REQUIRED` → **400** (запрос не полный, платить не с
кого), `PAYMENT_FAILED` → **402** (запрос полный, денег нет). Не 500: это отказ по
существу, а не сбой сервера. `allowUnpaid` — только `/inference` при
`clientProvisioned`, и там чек НЕ выпускается и воркеру не начисляется.

**3. Шифрование буфера — подтверждено на боевых данных, не на временной БД.**
`distillation_buffer` на проде: **9 строк**, `promptText` = 3 `encrypted` + 6 `null`,
`response` = 9 `encrypted`, **`PLAINTEXT` = 0**. `encryptSecret()` — AES-256-GCM,
ключ в файле `0600` в `TARNET_SECRETS_DIR`, не в БД и не в git. Хеш промпта
считается по открытому тексту (после шифрования не пересчитать). Нет ключа →
`ENCRYPTION_UNAVAILABLE` и отказ записи, а не открытый текст.

**Почему приёмка этого не доказывала.** Она поднимает сервер на `mktemp` с пустым
`distillation_buffer`; 62.6/62.7 проверяют миграцию на подложенной строке. Утверждение
о данных проверяется данными: понадобился прямой `SELECT` по боевой БД через
`node:sqlite` (`sqlite3` CLI на VPS отсутствует).

**Снятый блокер автозапуска.** `/p2p/status` теперь отдаёт `worker_addresses: []` и
`hasField: true` — проверено живым запросом. До раскатки проверка с адресом на
`2.23.0` возвращала код `3` («проверить нечем»), и это было верно: поля не было.
Порядок «сначала деплой, потом ребут» соблюдён.

**Чего срез НЕ доказывает.** `connections: 0`, `channels: 0`, `active_workers: 0` —
узла в сети нет, ПК владельца не перезагружен после раскатки. Деплой сделал проверку
P1.2 **возможной**, а не **успешной**. P1.2 остаётся открытым.

**Приёмка:** `1218 ✅ / 0 ❌`. Коммит `30b1cf3`, `local = remote` побайтово.

### Б.37. Срез 08.11.2026 12:40 MSK — `2.24.1-manus-audit-fixes`: красный `verify.sh` починен в фикстуре, а не в гейте

**Версия:** `2.24.1-manus-audit-fixes` (локально; на VPS остаётся `2.24.0-p0-hardening`).

**Симптом и диагноз.** `proof-treasury-gate.js` давал `7 ✅ / 6 ❌`: три подряд
`400 CLIENT_REQUIRED`. Гейт оплаты 2.24.0 срабатывал раньше аудита казны, и тест
не доходил до предмета проверки. Это дефект **фикстуры**, а не продукта: ослабить
`REQUIRE_PAYMENT` значило бы вернуть дыру, ради которой выпускалась 2.24.0.

**Что изменено в тесте.** Появился отдельный плательщик `0xccc…`, пополненный через
`POST /faucet/claim` — тем же путём, каким пополняется реальный кошелёк. `signedWork()`
принимает `clientAddress` и передаёт его в теле `/work`. Добавлены две проверки
самой фикстуры (`faucet выдал`, `баланс > 0`). Итог: **`15 ✅ / 0 ❌`**.

**P2P-корреляция — две закрытые дыры (`task-protocol.js`).**
1. `isPongFrame()` — явный предикат: `{action:'pong'}` либо `{action:'ping', pong:true}`.
   Анонимная полоса `anon[]` обслуживает **только** pong; кадр без `taskId` и не pong
   уходит в сироты и больше не может выдать себя за успешный ping.
2. Повторный `taskId` — счётчик `duplicates` (в `stats()`), отдельный от `orphans`.
   Память об id — `Set` + очередь вытеснения на 512 записей: без потолка это утечка
   на долгоживущем мосте.

**`check-autostart` — единый контракт.** Найден настоящий дефект, не только
расхождение комментария: при известном адресе проверялось **только** наличие адреса в
`worker_addresses`, без `active_workers >= 1`. Но `worker_addresses` строится из
авторизованных P2P-каналов, а `active_workers` — из WS-presence; канал переживает
падение воркера, поэтому «адрес есть, воркер мёртв» давало **код 0**. Теперь нужны
оба факта. Вывод печатает их раздельно: `addr=да/нет` и `mine=да/нет`.
`--any` по-прежнему означает «любой воркер по счётчику», и это сказано в помощи.

**Документы.** Устранён дубликат `Б.34` (два раздела с одним номером) — второй стал
`Б.35`, прежний `Б.35` → `Б.36`, этот срез — `Б.37`. `PROJECT-MAP`:
счётчик `1215` → `1223`, прогон 08.11 12:26. `REALITY-CHECK-v3`: добавлена сводка
честного статуса, включая **JSONL-экспорт Knowledge Loop пишет prompt/response
открытым текстом** (`knowledge-loop.js:383–391`, только `mode 0o600`).

**Приёмка (`TARNET_TESTS_ONLY=1 bash scripts/verify.sh`).**
`dpouw 1223 ✅ / 0 ❌`, `mesh 25 ✅ / 0 ❌`, `treasury 15 ✅ / 0 ❌` → «ТЕСТЫ ЗЕЛЁНЫЕ».
Новые: `51.15–51.17`, `59.6`, `59.6b`.

**Что срез НЕ доказывает.** P1.2 (ребут) открыт — прогона на машине владельца не
было. Датасет обучения не зашифрован. На проде пока `2.24.0`.

### Б.38. Срез 08.11.2026 15:55 MSK — инвест-документы очищены от отозванных обещаний (`2.24.2-pitch-cleanup`)

**Повод.** Внешний аудит (Claude) нашёл в инвест-материалах расхождение, которое
бьёт по доверию сильнее любой недоделанной фичи: рядом с честными цифрами
(`95% выплат — эмиссия`, `казна $3.96`) в тех же файлах лежали `$330/мес` на узел,
`GMV $200M` и оценка `$1B–1.5B` **как факты**. Инвестор, нашедший это сам, читает
это как попытку обмана — и формально прав, потому что проверка даёт `$2/мес` на
среднем ПК (`§Б.2`).

**`docs/PITCH-DECK.md`.**
1. Шапка переведена на `2.24.1-manus-audit-fixes`, 13 слайдов.
2. Все живые цифры слайда 6 и 9Б пересчитаны со стенда 08.11 15:40:
   `receipts 789`, `workers 96`, `totalRewardTar 147.617143`, `gross 148.007719`,
   инвариант `140.464667 + 7.152476 + 0.188638 + 0.188638 + 0.013300 = 148.007719`,
   `tier6_calls 16 / gross 0.0071`, тесты `1263` (1223 + 25 + 15).
3. **Добавлен новый слайд 10Б — «Реальность vs Видение».** Три части:
   что есть сейчас (таблица с эндпоинтом-источником для каждой цифры),
   видение как **сценарий** с обязательным «сейчас узлов ноль»,
   и отдельный блок «Затухание эмиссии — почему доход узла упадёт сам».
4. В приложении A («что не говорить») появились две новые запрещённые фразы:
   `$330/мес` без оговорки и `GMV $200M / оценка $1.5B` как факт.

**Формулировка про затухание, дословно в питче.** «Доход GPU-ферм (`$118–330/мес`)
в будущем снизится из-за затухания Block Reward `2^(−epoch/365)`, поэтому реальная
экономика зависит от Fee Reward (платящих клиентов)». Подкреплено фактом леджера:
эмиссия уже `24.2058` TAR/эпоха против `50` в генезисе.

**`TarNet_Presentation.html`** (9 слайдов, вне репозитория, но это тот файл, который
показывают): слайд 5 — `$330` заменён на честную вилку `$118` (4090, 50% duty, только
при платящем спросе) и `≈$2` на среднем ПК; слайд 8 — `GMV $200M / $1B–1.5B` отделён
от «сейчас» и переведён в «сценарий 2027, сейчас узлов ноль».

**`docs/REALITY-CHECK-v3.md`.** Пункт про JSONL переформулирован так, чтобы его нельзя
было прочитать как «зашифровано всё»: добавлена выделенная строка **«JSONL-экспорт
расшифровывается на диске. Это ограничение текущей версии»** и правило говорить
«зашифрована БД; датасет обучения лежит открытым и удаляется вручную».

**Сторож приёма ПК.** `watch-swarm-connection.js` переписан под контракт директивы:
огонь только при `connections >= 1` **и** непустом `bridge.worker_addresses`, с отдельной
веткой «сервер не отдаёт поле вовсе» (значит на проде сборка старше `2.24.0`) и веткой
«ослеп» после трёх подряд неудач HTTP.
**Приёмка.** `dpouw 1223 ✅ / 0 ❌`, `mesh 25 ✅ / 0 ❌`, `treasury 15 ✅ / 0 ❌` —
`1263` проверок, 0 падений.

**Что этот срез НЕ доказывает и что заблокировано.**
- **`2.24.1` на прод не раскатан.** SSH-ключ `~/.ssh/tarnet_vps` потерян вместе с
  домашним каталогом контейнера (поиск по телу `b3BlbnNzaC1rZXktdjE` по двум БД,
  WAL, файловой системе, `/tmp`, медиа — только собственные отчёты прошлых сессий,
  настоящего тела ключа нет). Выпущена новая пара, отпечаток
  `SHA256:4SGft8ShFEcU0CtPtP++g+h2FKW6WIAzX6r/fIaIu8c`; ждёт установки на VPS.
  Прод остаётся `2.24.0-p0-hardening`.
- **Поля `worker_addresses` на проде ЕСТЬ — первая запись об обратном была ошибкой замера.**
  Живой ответ 08.11 15:59: `bridge.worker_addresses: []`, `bridge.connections: 0`. Поле
  лежит **внутри блока `bridge`**, а не на верхнем уровне `/p2p/status`; первый `grep`
  смотрел не туда и дал вывод «поля нет», из которого я успел сделать неверное следствие
  («`check-autostart` вернёт код 3»). Правильно: пустой массив — это код `1`
  («никто не подключён»), а не `3` («проверить нечем»). **Приёмка P1.2 возможна уже
  на текущей сборке прод;** `2.24.1` нужна только для строгости сверки
  (адрес **и** `active_workers >= 1`).
- P1.2 (реальный ребут) по-прежнему не проверен: прогона на машине владельца не было.
- JSONL-датасет не зашифрован — только описан как ограничение.

### Б.39. Срез 09.11.2026 05:55 MSK — `2.24.8-p2p-ux`: путь запуска P2P, а не «ручная команда»

**Версия:** `2.24.8-p2p-ux` (локально; на VPS остаётся `2.24.0-p0-hardening`).

**Что показал инцидент у владельца.** P2P не поднялся по трём разным причинам сразу, и ни
одна не была видна из лога воркера: (1) `npm ci` в `p2p-node` не выполнился, (2) воркер
запускался из `C:\Users\Z-Boss`, а `p2p-node/` лежит в `AppData\Local\TarNet`, (3) единственным
документированным способом проверить P2P была команда `node --no-experimental-websocket
tarnet-worker.js --p2p` — флаг Node, который легко перепутать с `--p2p`.

**Проверено перед правкой, а не предположено.** `install.bat.tpl:175–195` и живой файл
`/install/install.bat` (17 018 байт, сверен с шаблоном через `diff`) **уже** содержат
`npm ci --omit=dev` в `p2p-node` с проверкой `import('libp2p')` и `P2P_OK`. Значит дефект
у владельца — не «установщик не ставит зависимости» (это было правдой до 2.22.7), а старая
копия установщика без этого блока или отсутствие `npm.cmd` рядом с portable Node.

**Что изменено в коде (`worker-demo.js`, 1872 строки):**
1. **`--test-p2p`** — `TEST_P2P` выключает WS **и** опрос. Задача приходит только по libp2p,
   поэтому успешная задача доказывает P2P, а не «что-то из двух»: с `--p2p` WS остаётся
   приоритетным, и старый способ проверки мог пройти по WS, ничего не проверив.
2. **`p2pDepsMissing()`** — проверяет `p2p-node/node_modules/libp2p/package.json` **до**
   запуска дочернего процесса. Отсутствие называется причиной («не выполнен `npm ci` в папке
   p2p-node») и готовой командой починки, а не стектрейсом `ERR_MODULE_NOT_FOUND` чужого модуля.
3. **`flagName()`** — в сообщениях печатается тот флаг, который набрал человек, а не жёстко `--p2p`.

**Что изменено в установщиках:**
- `install.bat.tpl`: `start.cmd` теперь начинается с `cd /d "%TARNET_DIR%"` (392 строки).
- `install.command.tpl`: `start.sh` начинается с `cd "$TARNET_DIR"` (277 строк).
  Без этого запуск из чужой папки (ярлык с другим working dir, автозапуск, терминал)
  терял `p2p-node/` молча — ровно симптом владельца.

**Дефект в собственном тесте, найденный по ходу.** `55.10` брал
`road55.indexOf('P1.2')` без заголовка `### `; упоминание P1.2 в шапке (строка 57) стоит
раньше заголовка P1.1, поэтому срез был пустым и проверка не могла стать зелёной **никогда**.
Якорь заменён на `### P1.1.` / `### P1.2.`; тест проверяет то, что написано в его имени.

**Приёмка.** `node test-dpouw.js --test` → **1227 ✅ / 0 ❌**, EXIT=0 (09.11 05:58), изолированный
сервер на временной БД. Из них 4 проверки новые — 53.7–53.10: `--test-p2p` включает
`TEST_P2P` и транспорт, `flagName()` называет именно этот флаг, без флага оба прежние,
и `p2pDepsMissing()` на каталоге без `node_modules/libp2p` говорит «нет».
`test-mesh.js` (25) и `proof-treasury-gate.js` (15) в этом прогоне **не перезапускались** —
их последний зафиксированный результат 08.11 15:50 (§Б.38).

**Что этот срез НЕ доказывает.**
- **P2P на ПК владельца не подтверждён.** Логи с `[p2p-worker] подключено` и
  `bridge.connections: 1` в этом прогоне не появлялись: живой `/p2p/status` в 05:42 MSK —
  `connections: 0`, `worker_addresses: []`, `active_workers: 0`. Запись
  «P2P подтверждён на ПК Владельца» **не сделана** — нет факта.
- `2.24.8` на VPS **не раскатан**: SSH-ключ всё ещё не принят
  (`root@195.63.131.172: Permission denied (publickey,password)`).

**Условие закрытия P1.2 (без изменений).** Воркер на ПК владельца запускается `start.cmd`,
`/p2p/status` показывает его адрес в `bridge.worker_addresses` и `connections >= 1`,
`active_workers >= 1`. Только после этого — тест роя с `CANCEL` проигравшему.

---

### Б.40. Срез 09.11.2026 07:10 MSK — `2.25.0-distributed-discovery`: воркера находят без сервера

**Версия:** `2.25.0-distributed-discovery`. **Раскатано на VPS 09.11.2026** (`24b2afa`); на момент среза Б.40 раскатка была заблокирована — блокер снят, см. Б.41.

**Что теперь работает.** Воркер кладёт в DHT провайдер-запись по CID бакета
`{networkId, modelFamily, deviceClass}`, переиздаёт её каждые 30 с (треть TTL 90 с) и
отдаёт свою подписанную `WorkerRecord` прямым потоком. Клиент, зная только CID,
находит провайдера через `findProviders`, открывает `/tarnet/worker-record/1.0.0`
и проверяет Ed25519-подпись до того, как доверит узлу задачу.

**Новые модули (`p2p-node/`, оба без зависимости от libp2p на импорте):**

| Модуль | Строк | Роль |
| :--- | ---: | :--- |
| `worker-record.js` | 339 | Схема `tarnet.worker-record.v1`, сборка CIDv1/raw вручную, base58btc для `peerId`, `bucketKey`/`bucketCid`/`provideCids`, `buildRecord`, `verifyRecord`, `nextSequence`. JCS берётся из корневого `jcs.js`, а не пишется второй раз |
| `gossip-announce.js` | 164 | `announceTopic(networkId)`, `gossipOptions()` (`StrictSign`), `createRecordValidator` (схема + `expiresAt` + `message.from === record.peerId` + подпись), `attachGossip` |

**Что изменено в существующих файлах:**

- `p2p-worker.js` (+173): `kadDHT({ protocol: '/tarnet/kad/1.0.0', clientMode: true })` —
  воркер за NAT не может быть хранилищем; `workerCapabilities(env)` читает
  `P2P_MODEL_FAMILIES` / `P2P_RUNTIMES` / `P2P_DEVICE_CLASS` вместо выдуманного списка;
  поток `/tarnet/worker-record/1.0.0` отдаёт `currentRecord`.
- `bridge.js` (+57): `clientMode: false` (мост — публичный seed, принимать входящие может),
  `gossipsub` + `ping` в `services`, `workerRecords: Map` — принятая запись отдаётся
  тому, кто спросит позже, с проверкой `expiresAt` при чтении, а не при записи.
- `p2p-bundle.js`: в список архива добавлены `worker-record.js` и `gossip-announce.js`.
  Это не косметика: без них установщик отдал бы воркер, падающий на `ERR_MODULE_NOT_FOUND`.

**Главный дефект, найденный только E2E-тестом.** `provide()` не отдавал ни одного события
и висел до таймаута, `routingTable.size === 0` у обоих узлов — при живом соединении.
Три причины, каждая проверена отдельной пробой:
1. `peerInfoMapper` по умолчанию — `removePrivateAddressesMapper`; адрес `127.0.0.1`
   вырезается, и локальные пиры для DHT не существуют. Заменён на `removePublicAddressesMapper`.
2. В первом `identify` узел видит у пира только `/ipfs/id/1.0.0`, хотя тот объявляет три
   протокола. Событие `peer` не срабатывает, таблица не наполняется.
3. `dht.provide(cid)` принимает **объект** `CID` (читает `key.multihash.bytes`). Строка
   падает с `Cannot read properties of undefined (reading 'bytes')` — выглядит как баг
   библиотеки, а не как наш.

Починка: явный `routingTable.add(peerId)` после `dial` — не полагаться на топологическое
событие, которое на первом рукопожатии не приходит.

**Приёмка (09.11 07:08 MSK).**
- `node scripts/test-discovery-e2e.js` → **10 ✅ / 0 ❌**, EXIT=0. Проверяет оба сервера
  в таблицах друг друга, `provide`, `findProviders`, адреса провайдера, открытие потока,
  схему записи, совпадение `peerId`, Ed25519-подпись и отказ подделанной записи.
- `node test-dpouw.js --test` → **1227 ✅ / 0 ❌**, EXIT=0. Тест `54.4` поймал реальный
  дефект: новые рантайм-модули не были в списке архива. E2E-тест при этом убран из
  `p2p-node/` в `p2p-node/test/` — он не рантайм и не должен уезжать пользователям;
  `readdirSync` верхнего уровня его больше не видит.

**Что этот срез НЕ доказывает.**
- **Discovery в проде не проверен.** На момент среза на VPS был `2.24.0-p0-hardening`, где `kad-dht` не подключён вовсе. Раскатка была заблокирована отсутствием SSH-ключа — **снято 09.11 08:25, см. Б.41**; `bridge.js` с `kad-dht` теперь на проде. Живого второго узла по-прежнему нет.
- **Второй узел найден только на loopback.** Два процесса на одной машине — не сеть.
  Проверка «через NAT, между двумя ПК» ещё не делалась.
- **GossipSub-объявления проверены косвенно.** Валидатор написан и подключён, но живой
  обмен через тему `/tarnet/tarnet-testnet-1/workers/1.0.0` между двумя машинами
  не наблюдался.

### Б.41. Срез 09.11.2026 08:40 MSK — SSH-ключ VPS переехал на постоянный том: `~/.ssh` был эфемерным

**Проблема.** Доступ к `root@195.63.131.172` терялся дважды (08.11, 09.11) и оба раза
восстанавливался вручную — паролем, с риском бана fail2ban. Диагноз «ключ потерян»
описывал симптом. Причина другая.

**Корневая причина.** `~/.ssh` лежит на **overlay-ФС контейнера** (`findmnt -T ~/.ssh` →
`overlay`, `/`). Этот слой перезаписывается при пересборке контейнера, и каталог исчезает
целиком — ключ, `config`, `known_hosts`. `/home/node/.openclaw` смонтирован с `ext4`
(`/dev/vda2`) и пересборку переживает. Ключ не «терялся»: он лежал не на том томе.

**Что сделано.**

| Элемент | Роль |
| :--- | :--- |
| `~/.openclaw/ssh/` | Постоянный том: `tarnet_vps`, `tarnet_vps.pub`, `config`, `known_hosts` |
| `~/.ssh` | Симлинк на `~/.openclaw/ssh` |
| `~/.openclaw/ssh/ensure.sh` | Идемпотентно восстанавливает симлинк и права; ключи не перезаписывает, старый каталог сохраняет в `.ssh-ephemeral-backup-<ts>` |
| `scripts/deploy.sh`, `scripts/verify.sh` | `SSH_KEY=~/.openclaw/ssh/tarnet_vps`, при отсутствии ключа зовут `ensure.sh` |
| Автоматизация `ssh-key-selfheal` | Ежедневно 06:15 MSK: `ensure.sh` + живой `ssh`; молчит, пока доступ жив |

**Проверено 09.11, а не предположено.**
- `ssh tarnet-vps` (алиас) → `OK`; по IP → `OK`; с `-i ~/.ssh/tarnet_vps` → `OK`.
- **Симуляция пересборки:** `rm ~/.ssh` → `Could not resolve hostname` → `ensure.sh` →
  `RESTORED-OK`. То есть отказ воспроизведён и починен, а не обойдён.
- Повторный `ensure.sh` → «уже указывает на постоянный том, правок не требуется» (идемпотентен).
- Прогон автоматизации вживую → `status: ok`, `delivered: false` (сторож промолчал, доступ жив).
- `deploy.sh` с новым путём раскатал `24b2afa` на VPS; `verify.sh` — `130/130` файлов совпали.

**Чего это не закрывает.** Потеря самого тома `/dev/vda2` или удаление
`~/.openclaw/ssh` по-прежнему требуют второго пути: вторая пара на машине владельца
либо восстановление паролем. Это другой класс отказа — не пересборка.

**Файлы на VPS не тронуты.** Изменения только локальные (ключ, скрипты, документы);
`sshd_config` на VPS не правился, `passwordauthentication yes` оставлен как аварийный вход.

### Б.42. Срез 09.11.2026 09:10 MSK — `2.25.1-discovery-hardening`: пять проверок из ревью Manus/Claude

**Версия:** `2.25.1-discovery-hardening`. Ревью архитекторов требовало доказать, что
код Discovery готов к реальной сети, а не только к loopback. Проверено пятью пунктами —
две находки оказались настоящими дефектами, которых в директиве не было.

| # | Проверка | Итог |
| :--- | :--- | :--- |
| 1 | Версии libp2p-пакетов | **Найден дубль:** `@libp2p/identify@3.0.39` тянул `interface@^2.11.0` при остальном монорепо на `^3.4.0` → 15+ копий `interface@2.11.0` в дереве. Апгрейд на `@libp2p/identify@^4.1.18` убрал все v2-ветки, осталась одна `interface@3.4.0`. Стек проверен загрузкой |
| 2 | `provide()` под `clientMode` | **Обход не нужен:** в `kad-dht@16.4.9` `provide()` не проверяет `clientMode` вовсе. Воркер не обязан быть DHT-сервером. Факт задокументирован в коде; директива утверждала обратное — она ошибалась |
| 3 | `sequence` между перезапусками | Уже работало: `nextSequence()` пишет `~/.tarnet/worker-record-seq` атомарным rename. Три отдельных процесса → `1 → 2 → 3` |
| 4 | Подпись покрывает `peerId` + `workerAddress` | Уже верно: JCS-строка включает `networkId`, `peerId`, `workerAddress`, `workerAuthKey`, `sequence`, `capabilities`, `issuedAt`, `expiresAt` |
| 5 | E2E GossipSub двумя узлами | **Сделан заново:** `test-gossip-e2e.js` — два дочерних процесса через `spawn`, разные seed → разные `peerId`. 9 ✅ / 0 ❌ |

**Два дефекта, которых в директиве не было** (нашлись при проверке пункта 5):

1. **Узел рождался не тем ключом.** `p2p-worker.js` создавал libp2p без `privateKey` —
   libp2p генерировал случайный. `buildRecord()` ждёт `peerId` от seed воркера →
   `PEER_ID_MISMATCH`, а объявление молча уходило в `catch`. Discovery выглядел живым,
   но не публиковал **ни одной** записи. Исправлено: `privateKey` выводится из seed
   (`generateKeyPairFromSeed('Ed25519', seed)`) **до** `startNode()`.
2. **Мост не отдавал записи.** `bridge.js` принимал `WorkerRecord` и складывал в Map,
   но обработчика `RECORD_PROTOCOL` не имел — клиент получал тишину. Добавлен
   `node.handle(RECORD_PROTOCOL, …)` с проверкой `expiresAt`; `RECORD_PROTOCOL`
   экспортируется из одного модуля, чтобы две копии не разъехались.

**Проверено, а не предположено.**
- `test-gossip-e2e.js` → **9 ✅ / 0 ❌**: обмен между двумя процессами, подпись проверена
  получателем, `message.from === record.peerId` сошлось на живом трафике.
- `test-discovery-e2e.js` → 10 ✅ / 0 ❌ (после апгрейда `identify` и правки ключа).
- `test-dpouw.js --test` → **1227 ✅ / 0 ❌** — правки ничего не сломали.
- `bridge.js` стартует и пишет `[bridge] отдача записи: /tarnet/worker-record/1.0.0`.

**Чего это не доказывает.** Между двумя машинами через NAT не проверялось. Два процесса
на loopback — это независимый транспорт и независимые ключи, но не NAT-обход, не реальная
задержка DHT и не смена IP. Живой прогон воркера владельца с ПК — следующий шаг.

### Б.43. Срез 09.11.2026 09:40 MSK — `2.25.2-privacy-and-pitch`: JSONL перестал быть открытым

**Версия:** `2.25.2-privacy-and-pitch` (в проде `2.25.1-discovery-hardening`).

**Что было не так.** В `distillation_buffer` поля `promptText`/`response` шифруются с
`2.23.3`. Но `triggerTrainingPipeline` расшифровывал их и писал **открытым текстом** в
`storage/experience/distill-*.jsonl`. Шифрование в БД обходилось одним вызовом на диск:
файл переживает запрос и лежит там до ручной уборки, то есть это данные at-rest, а не
временный буфер. Нашёл Manus на аудите — и он прав.

**Почему нельзя было просто зашифровать файл целиком.** `mock_train.py` хеширует **байты**
файла и считает **непустые строки** как число примеров. Шифрование всего файла дало бы
`count = 1` и нечитаемый датасет. Шифруются значения полей построчно.

**Почему не `encryptSecret()`.** Там случайный IV, а `adapterHash` считается по содержимому
файла. Случайный IV давал бы новый хеш на том же датасете при каждом прогоне и наполнял бы
`adapter_versions` дублями, которые нечем отличить (та же причина, по которой `mock_train.py`
хеширует содержимое, а не время). Добавлен `encryptTextDeterministic`: IV выведен из
открытого текста через HMAC-SHA256 под мастер-ключом (synthetic IV). Для GCM это
безопасно, пока один IV не встречается у двух **разных** текстов — совпадение IV означает
совпадение текста, то есть повторное шифрование того же значения. Примитив остаётся
AES-256-GCM, ротация ключей не меняется.

**Цена предсказуемости, которую надо знать.** Одинаковые `prompt`/`response` в двух
записях дают одинаковый шифротекст, то есть файл выдаёт факт повтора. Для датасета это
приемлемо; для произвольных секретов — нет, там остаётся `encryptSecret()`.

**Что осталось открытым и почему.** `promptHash`, `rating`, `modelId`, `domain` не
шифруются: hash необратим, остальные три нужны тренеру и валидатору для отбора по домену
и не раскрывают текст диалога. Шифровать их значило бы сломать фильтрацию, ничего не
защитив.

**Отказ вместо тихой деградации.** Без `encryptText` координатор возвращает
`ENCRYPT_UNAVAILABLE` **до** запросов к БД: иначе «шифрование буфера» перестало бы
что-либо значить, а датасет лёг бы открытым. Симметрично `DECRYPT_UNAVAILABLE` из `2.23.3`.

**PITCH-DECK.** С цифрами из документа сверены живые `/summary` и `/health` (09.11.2026
09:40 MSK): эмиссия **95.26%** (`143.663151` из `150.815632`), оплата **4.74%**
(`7.152481`), казна **$3.96** (`0.19815` TAR). В документе стояли `94.9% / 4.83%` —
прошлый снимок. Снято внутреннее противоречие: строка 363 подавала `$330/мес` как
существующий доход GPU-ферм, а таблица ниже в том же слайде — как «не существует».
Все упоминания `$330/мес` теперь только опровержение.

**ensure.sh.** Новый `scripts/ensure.sh`: идемпотентная установка резервного SSH-ключа
владельца в `/root/.ssh/authorized_keys` с проверкой входа **именно этим ключом**
(`IdentitiesOnly=yes`) и откатом из `bak`, если проверка не прошла. Файл пишется через
временный + `mv` — обрыв связи посередине не оставит пустой `authorized_keys`.

**Проверено на живом VPS, а не на словах.**
- `ensure.sh` с существующим ключом → `ALREADY`, exit 0, файл не тронут (идемпотентность);
- `ensure.sh` с временным ключом → 4 ключа → `ADDED` → вход им подтверждён → временный
  ключ снят → снова 4 ключа. `bak`-файл от теста удалён, на VPS `bak` = 0;
- `test-dpouw.js --test` → **1230 ✅ / 0 ❌** (+3: `24.9` расщеплён на три проверки,
  `62.9` — на две; обе теперь требуют шифротекст и расшифровку настоящим `master.key`).

**Чего это не доказывает.** NAT между двумя машинами по-прежнему не проверен — нужен
живой прогон воркера с ПК владельца. `ensure.sh` проверен на одном VPS и одном ключе,
не на парке машин.

### Б.44. Срез 09.11.2026 10:40 MSK — `2.25.3-nat-readiness`: Relay, уборка датасетов, два seed

**Версия:** `2.25.3-nat-readiness` (в проде `2.25.2-privacy-and-pitch` до раскатки).

**Зачем relay, если у нас DHT-сервер.** DHT и relay отвечают на разные вопросы, и до
этого среза второго не было вовсе. DHT говорит «кто умеет X и по какому адресу»; relay
даёт **путь** туда, где входящий TCP невозможен. Узел за строгим NAT вправе объявить себя
провайдером (это и работало), но подключиться к нему снаружи нельзя — discovery находил
узел и обрывался на соединении. Ровно этот разрыв и закрыт.

**Мост — relay-сервер.** `circuitRelay: circuitRelayServer(...)`, выключается `P2P_RELAY=0`.
Два параметра изменены осознанно:
- `maxReservations` — с дефолтных **15** до **256**. Шестнадцатый воркер иначе молча не
  получал слот и оставался «живым в DHT, недоступным на деле».
- `defaultDataLimit` — **2 МБ** на соединение. Relay пропускает чужой трафик; без лимита
  один клиент качает через VPS неограниченно. Запись `WorkerRecord` и кадр задачи
  укладываются с запасом, потоковое видео не поедет.

**Воркер — relay-клиент.** `circuitRelayTransport()` в `transports` **и** `/p2p-circuit`
в `listen`. Оба нужны вместе: транспорт без `/p2p-circuit` в listen не запрашивает
резервацию (адреса не появляется), `/p2p-circuit` без транспорта не обслуживается.
Relay — **третий** адрес, а не замена TCP: узел без NAT по-прежнему соединяется напрямую
и лишь дополнительно держит слот.

**Доказано, а не предположено.** `test-relay-e2e.js` → **10 ✅ / 0 ❌**. Клиент
поднимается **без единого TCP-адреса** (`listen: ['/p2p-circuit']`) — это не «закрытый
порт» на loopback, а отсутствие прямого пути по построению. С закрытым портом тест мог бы
пройти по TCP и не доказать ничего. Резервация получена, входящий поток дошёл, ответ
помечен `via=relay`. Отдельным зондом измерено: ответ через relay — **7 мс**.

**Ошибка в зонде, которую стоит помнить.** Первые два прогона упали не из-за кода:
`dial()` получил строку вместо `Multiaddr`, а `data`-слушатель навешивался **после**
того, как поток уже отдал данные. Тест, который «падает на своей же обвязке», легко
принять за сломанный продукт — поэтому обвязка тоже проверяется.

**Уборка датасетов.** `scripts/prune-distill.js` + `tarnet-prune-distill.timer`
(вс 03:00, `Persistent=true`, `--apply`). Два независимых основания для удаления:
`adapterHash` есть в `adapter_versions` (обучен) ИЛИ возраст ≥ 30 дн.

**Расхождение в хеше, которое нельзя было игнорировать.** `mock_train.py` считает
`sha256(domain + b"\x00" + data)`, а fallback в `knowledge-loop.js` (когда `python3`
недоступен) — **без** нулевого байта. Дефект живой и старый. Подгонка под один вариант
означала бы, что файлы, обученные другим путём, не узнаются и лежат навсегда. Скрипт
считает **оба** хеша и сверяет с реестром любой. Проверено на фикстуре: оба стиля
узнаны, свежий необученный оставлен, старый удалён по возрасту, повторный прогон — 0.

**Почему домен из файла, а не из имени.** В имени домен санирован (`[^a-zA-Z0-9_-]` → `_`),
и `code/review` с `code_review` дают одно имя при разных хешах. Поле `domain` в первой
строке JSONL — исходное; имя остаётся запасным для битого файла.

**Два seed-узла — требование, а не пожелание** (`ROADMAP` P1.2d). Минимум два seed у
**разных операторов**: один seed — единая точка отказа в центре продукта. Два таймера на
одном VPS — не резервирование, а удвоенная ставка на одно железо. Сейчас seed один;
в материалах нельзя писать «децентрализованная сеть», пока это так.

**Тесты после правок.** `test-dpouw.js` → **1230 ✅ / 0 ❌**; `test-discovery-e2e.js` →
10/0; `test-gossip-e2e.js` → 9/0; `test-relay-e2e.js` → 10/0.

**Чего это не доказывает.** Relay проверен на loopback в двух процессах, не через
настоящий NAT и не с реальной потерей пакетов. Второй seed не развёрнут. Уборка датасетов
проверена на фикстуре, не на боевом каталоге с сотнями файлов.

### Б.45. Срез 09.11.2026 10:55 MSK — `2.25.3a`: состояние relay видно в логе

**Дефект наблюдаемости, а не кода.** Relay работал с самого `2.25.3`, но ни лог моста,
ни `status()` не говорили, включён он или нет. При разборе состояния прода 09.11
пришлось читать исходник `bridge.js`, чтобы ответить на вопрос «relay поднят?». Ответ
«работает, но узнать это можно только глазами в коде» — не ответ для эксплуатации.

**Что печатается теперь.** При старте моста:
- `[bridge] Relay   : сервер (maxReservations=256, dataLimit=2097152 Б)`
- `[bridge] Relay   : ВЫКЛЮЧЕН (P2P_RELAY=0) — узлы за NAT не смогут подключиться`

Вторая строка важнее первой: `P2P_RELAY=0` — штатное действие, и оно обязано оставлять
след. Молчание после осознанного выключения relay выглядит как «всё хорошо», хотя
узлы за NAT в этот момент недостижимы.

**Relay доказан на проде, а не на loopback.** Проба с самого VPS
(`relay-probe.mjs`, временный файл, удалён): клиент **без единого прямого адреса**
(`direct addrs: 0`) получил резервацию за **1101 мс**, адресов два — loopback и
публичный `/dns4/v1107336.hosted-by-vdsina.com/tcp/4001/.../p2p-circuit/...`.
То есть через боевой мост, не через тестовый процесс.

**Урок про грязный VPS.** Деплой `2.25.3a` остановился на `ПРОВАЛ: на VPS осталось 1
грязных путей после reset`. Это был мой же `p2p-node/relay-probe.mjs`, положенный туда
руками для пробы. Проверка сработала правильно: код уже был раскатан (`HEAD 88c8df8`),
но деплой не имеет права объявлять успех при посторонних файлах в рабочем дереве.
После удаления `verify.sh` → 19 проверок зелёные.

### Б.46. Срез 09.11.2026 11:20 MSK — `2.25.4-two-seed`: второй seed и проверка механики

**Что сделано.** Второй DHT-seed на том же VPS: `tarnet-seed2.service`, `P2P_PORT=4002`,
отдельный `P2P_DATA_DIR=/var/lib/tarnet/p2p-seed2` и отдельный сокет
`/tmp/tarnet-seed2.sock`. Отдельный каталог ключа — не косметика: общий каталог дал бы
**тот же peerId**, и «два seed» оказались бы одним узлом, раздвоенным в отчёте.

**Главное открытие: два seed без взаимного dial — это два острова.**
`bridge.js` до этой версии **никогда не подключался к другому seed** (`grep` по
`P2P_BOOTSTRAP|dial(` был пуст). Два процесса на разных портах дали бы два независимых
DHT: запись, положенная через seed1, была бы невидима через seed2, и воркер,
получивший адрес второго, объявился бы в пустоту. Поэтому добавлен `P2P_SEED_PEERS` —
явный список соседей, симметричный в обоих юнитах.

**Почему нужен повтор, а не одна попытка.** systemd стартует оба юнита одновременно;
сосед в этот момент ещё не слушает порт. Одна попытка теряла связь **навсегда**, до
ручного рестарта. Теперь: 18 попыток по 10 с (3 минуты) в фоне, `unref()`, чтобы
таймер не держал процесс. Локально проверено: seed1 начал с `0/1`, после повтора — `1/1`.

**`/p2p/bootstrap` отдаёт оба адреса.** Раньше — только один сокет. Добавлен второй
запрос к `P2P_SEED2_SOCKET` (по умолчанию `/tmp/tarnet-seed2.sock`), дедупликация по
строке, и поле `seeds[]` с источником каждого адреса. Отсутствие второго seed — не
503: новый хост может его не иметь, и отказ сломал бы discovery на всех таких
установках. Он виден в `seeds[1].error`, а не молчанием.

**`test-seed-failover.js` — 12 ✅ / 0 ❌.** Доказывает именно то, чего не доказывал
`test-discovery-e2e.js`: воркер объявляется через seed1, клиент знает **только** seed2 —
и находит воркера. Плюс обратное направление и отрицательный контроль (изолированный
seed не находит провайдера из другой сети).

**Три ошибки в собственном тесте, каждая — факт о механике.** (1) «ровно одно
соединение у воркера» → их два: после `provide()` сам DHT звонит ближним узлам.
(2) «нет исходящих к seed2» → есть: DHT не ждёт, пока его попросят. (3) замер «до
provide» стоял **после** `provide()` — проверка была бессмысленной при зелёном выводе.
Итог: доказательство строится на разнице двух замеров по обе стороны от `provide()`.

**Найден и закрыт ещё один дефект класса 09.11.** `@multiformats/multiaddr`
импортируется **статически в 5 файлах** (`bridge.js`, `p2p-worker.js`, три теста), но в
`p2p-node/package.json` объявлен не был — держался на транзитивной зависимости.
`npm ci` на новом хосте мог его не поставить, и упал бы весь модуль. Добавлен в
dependencies (`^13.0.3`), в `P2P_REQUIRED_PACKAGES`, в lock и в оба установщика.

**Проверка firewall — часть установки, а не отдельный шаг.** ufw был открыт только для
4001. Второй seed поднялся бы, слушал 4002 и был **недостижим снаружи**: изнутри всё
зелёное, снаружи адрес ведёт в пустоту. `deploy.sh` теперь открывает 4002 и проверяет
**наличие правила**, а не код возврата (`ufw allow` на существующем правиле даёт 0).

**Чего это НЕ закрывает.** ROADMAP P1.2d требует два seed у **разных операторов**.
Оба юнита — на одной машине: общий диск, провайдер, systemd. Падение VPS уносит оба.
В материалах писать «децентрализованная сеть» по-прежнему нельзя.

### Б.47. Срез 09.11.2026 13:05 MSK — `2.26.0-discovery-completion`: Discovery перестаёт быть «работает в тесте»

**Почему эта версия вообще понадобилась.** Discovery был реализован и зелёный в
тестах, но **не работал для пользователя**. Три независимые причины, каждая
достаточна, чтобы воркер не появился в DHT:

1. **Установленный воркер не знал своих capabilities.** `workerCapabilities()` читает
   `P2P_MODEL_FAMILIES` / `P2P_RUNTIMES` / `P2P_DEVICE_CLASS`, а установщик эти
   переменные **не задавал вообще**. При пустом списке `announce()` выходит **до**
   `provide()` — то есть до самой публикации. Всё поднималось, воркер брал задачи по
   WS, `start.cmd`/`start.sh` писались, лог был чистый — и Discovery молчал.
2. **Запись истекала через 90 с и не пере-публиковалась.** `setInterval` в воркере
   делал при живом соединении только `return`. `RECORD_TTL_MS = 90000`, публикация
   ровно одна. Через полторы минуты `findProviders` по свежему бакету воркера уже не
   находил, а лог продолжал писать «жив».
3. **Искать было нечем.** Не существовало пути «клиент спрашивает → DHT отвечает»:
   не было `discovery-client.js`, не было `GET /p2p/discover`. Провайдер-запись
   класть умели, забрать — нет.

**Блок 1 — capabilities задаёт установщик.** Семейство берётся **без тега**
(`qwen2.5-coder:7b` → `qwen2.5-coder`): тег — размер сборки, а не возможность узла, и
клиент ищет «кто умеет qwen2.5-coder». Если модель не встала (`SKIP_MODEL=1` или нет
`Ollama`), значение **остаётся пустым**: объявить несуществующую возможность значило бы
привести клиента с задачей, которую некому выполнить. Устройство — `gpu` только когда
`nvidia-smi -L` реально отвечает, а не когда бинарник просто найден. Значения вшиваются
в `start.cmd` / `start.sh` через `if not defined` / `${VAR:-...}`, чтобы ручная правка
владельца побеждала переустановку. Добавлено поле `/health → p2p_capabilities_configured`:
пустые capabilities видны снаружи как состояние, а не как тишина в логе.

**Блок 2 — повторное объявление.** `announce()` вызывается каждые `ANNOUNCE_MS` (30 с,
треть TTL) из того же `setInterval`. Условие — по **времени последней публикации**, а не
по счётчику тиков: `announce()` может не дойти до `provide()` (пустые capabilities, нет
ключа), и тик не должен считаться объявлением. Флаг `announcing` не даёт вызовам
наложиться. За 30 с до истечения в лог пишется остаток срока — чтобы «провайдеров нет»
не приходило как первый симптом.

**Блок 3 — поиск.** `p2p-node/discovery-client.js` (232 строки): бакет по
`(model, deviceClass)` → `findProviders(cid)`, затем прямой поток
`/tarnet/worker-record/1.0.0` к каждому провайдеру за подписанной записью. Мост получил
action `discover`, сервер — `GET /p2p/discover?model=…&deviceClass=…`. Кэш из gossipsub
отдаётся **отдельным полем `cached`**, а не подмешивается в `workers`: склеить их значило
бы выдать кэш за результат DHT.

**Блок 4 — мост отдаёт запись по target Peer ID.** Раньше обработчик не различал, у кого
просят запись. Теперь `targetPeerId` читается из кадра, ищется в `workerRecords`, при
несовпадении — `NOT_FOUND` с деталями, поток закрывается корректно.

**Блок 5 — контракт записи и anti-rollback.** `verifyRecord()` проверяет: `sequence` —
положительное целое, TTL ≤ 120 000 мс, канонический base64 сигнатуры
(`Buffer.from(sig,'base64').toString('base64') === sig`), `workerAddress` по
`^0x[a-f0-9]{40}$`, непустой `capabilities.modelFamilies`. Anti-rollback (`lastSequence`)
применяется **в двух местах** — при приёме gossip-объявления и при выдаче через мост:
защита только на одном входе оставляла бы второй открытым.

**Блок 6 — E2E с независимыми процессами.** `test-gossip-e2e.js` теперь вычисляет
`expectedPublisherPeerId` из seed и передаёт `--expect-peer` подписчику: проверка
«отправитель совпал» перестала быть самосогласованной. Наборы p2p поставлены в
`scripts/verify.sh` как **релизный гейт**.

**Блок 7 — датасет: атомарная запись и AAD.** (а) `knowledge-loop.js` пишет JSONL через
`.tmp` + `renameSync` в том же каталоге: смерть процесса на середине оставляла файл с
обрезанной последней строкой, а для тренера это **валидный** JSONL — он считает непустые
строки и молча обучается на неполном примере. (б) Шифрование полей получило AAD
`promptHash:field` и версию `enc:v2:`. Без AAD тег подтверждал только «байты не менялись»,
и `prompt` можно было переставить в `response` — датасет обучился бы на перепутанных
парах без единой ошибки. `enc:v1:` читается по-прежнему: смена формата на месте
превратила бы существующие датасеты в мусор.

**Две собственные ошибки, найденные тестом, а не ревью.** (1) `encField` ссылался на
`r.promptHash` **вне** области видимости `.map((r) => …)` — падало `r is not defined` и
валило весь датасет. `promptHash` теперь передаётся аргументом. (2) В `decryptSecret`
версия проверялась как `parts[0] === 'enc:v2'`, но `split(':')` даёт
`['enc','v2',iv,tag,ct]` — верная проверка `parts[1] === 'v2'`. С прежним кодом **любая**
v2-запись молча возвращала `null`, то есть датасет выглядел бы повреждённым.

**Блок 8 — проверки на пути релиза.** `ensure.sh`: ветка `ALREADY` (ключ уже в
`authorized_keys`) больше не выходит с успехом по факту наличия строки — выполняется
**фактический вход** этим ключом с `IdentitiesOnly=yes`. Строка в файле может быть, а
входа не быть (права каталога, `PermitRootLogin`, sshd не перечитал конфиг) — раньше
человек узнавал об этом при попытке войти. `discovery-client.js` добавлен в
`p2p-bundle.js`: без этого архив уезжал без модуля, и `GET /p2p/discover` падал бы
`ERR_MODULE_NOT_FOUND` на машине пользователя.

**Приёмка.** `test-dpouw.js` — **1231 ✅ / 0 ❌**. `TARNET_TESTS_ONLY=1 verify.sh`:
dpouw 1231, mesh 25, treasury 15, p2p-discovery 10/10, p2p-gossip 10/10,
p2p-seed-failover 12/12, p2p-relay 10/10. Relay добавлен в гейт отдельным набором:
без него поломка relay выглядела бы как «discovery жив», а воркер за NAT был бы
недостижим.

**Чего это НЕ доказывает.** (1) **Повторное объявление не покрыто тестом.** Код есть,
но проверки «через 90+ с запись всё ещё находится» нет: это требует прогона дольше TTL.
Пока это утверждение о коде, а не о поведении в бою. (2) **Реального NAT нет.**
Все наборы — loopback или две сети на одной машине. Воркер за домашним роутером не
проверялся ни разу; `--test-p2p` на ПК владельца ещё не запускался. (3) **Ключ
резервного доступа не создан** — процедура описана в `scripts/generate-backup-key.md`,
но требует машины владельца. (4) Два seed по-прежнему на одной машине.

### Б.48. Срез 09.11.2026 15:55 MSK — `2.26.1`: деплой синхронизирует инфраструктуру, два пробела закрыты

**Зачем эта версия.** `2.26.0` закрыл Discovery в коде, но оставил три вещи
недоказанными. Проверка по факту (а не по памяти) показала: два пробела реальны, а
третий дефект — в самом деплое, и он был **тихим**.

**Дефект деплоя — главное в этой версии.** `deploy.sh` перезапускал мост, но
**никогда не обновлял файл юнита**. На VPS с 5 ноября лежал юнит без
`P2P_SEED_PEERS`, и мост писал `Seed : одиночный`: второй seed формально существовал,
а мост о нём не знал. Связь держалась только встречным dial'ом, и лог выдавал
односторонний канал за двусторонний. Теперь `deploy.sh` устанавливает
`deploy/systemd/p2p-bridge.service` **из репозитория до** рестарта. Проверка связи
переписана с `${LINKED:-не найдено в логе}` на явный `case` с четырьмя исходами:
`одиночный`, `НЕ СВЯЗАН`, `N/M`, «строки нет». Прежняя форма при seed1 в
`~/.tarnet/worker.json` молча не звонила второму seed'у и при этом выглядела успешной.

**Блок 6 закрыт — `--expect-peer`.** Ключи в `test-discovery-e2e.js` генерируются
`generateKeyPairFromSeed`, а не `generateKeyPair`: `peerId` предвычислим **до** старта
воркера, поэтому «нашёл того, кого искал» перестало быть самосогласованным. Добавлены
проверки 2.1 (предсказанный `peerId` == фактический) и 4.3 (найденный провайдер ==
`--expect-peer`). Живой прогон: **12 ✅ / 0 ❌**.

**Блок 2 закрыт — пере-объявление доказано временем.** `p2p-node/test/test-reannounce-e2e.js`
поднимает **настоящий** `p2p-worker.js` дочерним процессом со своим `HOME`, ждёт дольше
TTL и требует, чтобы запись осталась свежей (`expiresAt > now`) и `sequence` вырос.
**9 ✅ / 0 ❌.** Без пере-объявления тест красный: собранная на старте запись к моменту
второй проверки имела бы `expiresAt` в прошлом.

Почему реальный процесс, а не цикл внутри теста: проверяемая логика живёт в
`setInterval` внутри `main()` воркера. Копия в тесте проверяла бы копию — исходник мог
бы сломаться, а копия остаться зелёной.

**Три расхождения директивы с кодом (зафиксированы, не замазаны).**
1. `P2P_ANNOUNCE_MS` / `P2P_RECORD_TTL_MS` **не существуют**. Есть
   `WORKER_RECORD_TTL_MS`, интервал выводится как `ANNOUNCE_MS = floor(TTL / 3)`.
   При `TTL = 1500` это ровно 500 мс — те же числа, но через читаемый параметр.
   Придумать env, которого движок не читает, значило бы написать тест о несуществующем коде.
2. `package-lock.json` был на `2.25.4`, то есть **отставал от `package.json` на две
   версии**. Рассинхрон жил незамеченным; синхронизирован.
3. Контрольная проверка `2.6` в тесте доказывает, что `verifyRecord` умеет возвращать
   `EXPIRED` — иначе зелёная `2.2` ничего не значила бы.

**Чего это НЕ доказывает.** Тест блока 2 берёт запись по **прямому потоку** через уже
установленное соединение, а не через `findProviders`, и доказательством Discovery не
является. Причина техническая: `findProviders` возвращает AsyncIterable, который не
завершается, пока провайдер не найден, — первый прогон завис (`EXIT=124`, пустой вывод).
Наличие записи в DHT отдельно доказывает `test-discovery-e2e.js`. Реального NAT
по-прежнему нет: воркер за домашним роутером не проверялся ни разу.

### Б.49. Срез 09.11.2026 17:0x MSK — подготовка к NAT-тесту: диск, инструкция, честный v4

**Версия остаётся `2.26.1`.** Кода не тронуто: это условия проверки и документы.
Номер сборки не поднимался намеренно — иначе `/health` и `package.json` обещали бы
новую сборку там, где её нет.

**Что это.** Подготовка к единственной проверке, которая ещё отделяет Discovery от
слова «работает»: прогон воркера за домашним роутером. Кода P2P здесь не менялось —
менялись условия, в которых его можно честно проверить.

**Диск контейнера: 338 → 574 МБ.** Важный факт для будущих чисток: `du /` даёт 4.7 ГБ
против 9.3 ГБ у `df`, потому что 2.5 ГБ в `/app/node_modules` — это **слои образа**,
и `rm` по ним не освобождает ничего. Освобождаемое лежит только в верхнем слое:
`npm cache` (39 МБ), `cache/control-ui-assets` (48 МБ), WAL базы агента (65 МБ →
`wal_checkpoint(TRUNCATE)`, `busy:0`), `.codex/.tmp/plugins` (103 МБ, временный клон
каталога плагинов). База памяти (935 МБ) не тронута намеренно; `freelist` = 13 страниц,
возвращать нечего.

**Ловушка, в которую я попал лично.** `p2p-node/node_modules` (44 МБ) выглядит как
очевидный кандидат, но его удаление валит три p2p-набора: локальный `verify.sh` гоняет
`p2p-node/test/*`, а они импортируют libp2p из этого каталога (`ERR_MODULE_NOT_FOUND`).
`npm ci` вернул 54 МБ, то есть чистка обошлась дороже, чем дала. Этот каталог удаляется
только вместе с отказом гонять p2p-тесты локально.

**`docs/NAT-TEST.md` — новый документ.** Не пересказ директивы: каждый шаг сверен с
кодом. Установка описана как `worker.js` **плюс** `p2p-node.zip` **плюс** `npm ci` —
скачать один файл и ждать P2P — самая частая ошибка. `--test-p2p` объяснён через
разницу с `--p2p`: тот оставляет WS приоритетным, и успешная задача тогда доказывает
«что-то из двух»; `--test-p2p` выключает WS принудительно. Диагностика — по строкам
`[p2p-worker]` от `bootstrap:` до `hello отправлен от 0x…`, плюс таблица «наблюдение →
вердикт», отделяющая «NAT не пробит» от «воркер не стартовал».

**Две поправки к директиве, найденные чтением кода.**
1. **Лога `peer-auth` не существует.** `p2p-node/peer-auth.js` не содержит ни одного
   `console.log` — модуль возвращает `{ok, address}`, а печатают `[bridge]` и
   `[p2p-worker]`. Инструкция «проверьте peer-auth лог» вела бы в пустоту.
2. **`worker_addresses` — не сетевой адрес.** Это `0x…` кошельки каналов задач
   (`taskClient.list()` в `bridge.js`). `[]` при `connections: 1` означает «пир
   подключён, канала задач нет». Воркер слушает `/ip4/127.0.0.1/tcp/0` и `/p2p-circuit`:
   входящего публичного адреса за NAT не будет и не должно быть — критерий успеха это
   `connections` **и** `channels`, а не адрес в реестре.

**`docs/REALITY-CHECK-v4.md` — уровень C по-прежнему пуст.** Discovery доведён до
«готов к runtime»: 1324 проверки / 0 падений, 6 E2E-наборов, `--expect-peer` больше не
SKIP, пере-объявление доказано прогоном дольше TTL. Но ни один прогон не проходил
через домашний роутер, поэтому `v2.27.0` с тегом не ставится: тег — утверждение о
продукте у пользователя, а не о самосогласованности механики.

**`scripts/generate-backup-key.md`.** Добавлен раздел 0: ПК нет, ключ не создан, и это
следствие, а не недоделка — ключ обязан родиться на машине владельца. Зафиксирован
порядок: резерв **до** первой пересборки тома, потому что ключ, добавленный на
следующий день, не спасает от потери, случившейся вчера.

**Честная граница.** NAT не проверен. Оба seed на одной машине. Миграция legacy JSONL
на реальных данных не гонялась. Датасет обучения лежит открытым (`mode 0o600`).
`[ОТОЗВАНО 11.11.2026: «NAT не проверен» больше не верно — см. §Б.67. Второй seed
по-прежнему на одной машине.]`

### Б.50. Срез 09.11.2026 19:0x MSK — сверка `MASTER-PLAN` с продом: два устаревших факта

**Версия остаётся `2.26.1`.** Кода не тронуто; исправлены два числа, которые расходились
с живым продом.

**Повод.** Владелец собрал консолидированный `MASTER-PLAN` из ответов пяти агентов. При
сверке его таблиц с `GET /summary`, `/nodes`, `/health` и базой на VPS нашлись два
устаревших факта — оба в моих же документах.

**Факт 1: чеков `793`, а не `789`; последний чек — 09.11, а не 07.11.** В `ROADMAP` §0
стояло «789 / 96» и «последний чек 07.11 12:14 UTC». Прод отдаёт `receipts: 793`, а
`work_receipts` на VPS — `MAX(seq) = 793`. Четыре чека `790`–`793` добавлены **09.11
01:37–02:07 UTC** (04:37–05:07 MSK). Проверено по строкам:

| seq | воркер | cwu | `source` задачи | время UTC |
|---|---|---|---|---|
| 793 | `0xd11f0837…` | 75 | — (строки задачи нет) | 02:07:46 |
| 792 | `0x347e91fa…` | 98 | — (строки задачи нет) | 02:07:35 |
| 791 | `0x3b7928c8…` | 122 | `ollama`, `qwen2.5-coder:1.5b` | 01:40:48 |
| 790 | `0x3b7928c8…` | 199 | `ollama`, `qwen2.5-coder:1.5b` | 01:37:41 |

**Чеки 790 и 791 — настоящий инференс, а не заглушка:** `cwu` совпадает с
`tokensGenerated` соответствующих задач (`199` и `122`), `demo = 0`, модель
`qwen2.5-coder:1.5b`. То есть 09.11 ночью у `0x3b7928c8…` действительно работал воркер.

**Но сетью это не делает.** К 19:0x `/health` снова отдаёт `active_workers: 0`,
`llm_mode: deterministic_fallback`. Воркер проработал около получаса и исчез. Последний
**P2P**-чек по-прежнему `0x209a5200…` 07.11 11:13 — транспорт после него не перепроверялся.
Поэтому формулировка «сети нет» верна, а «последнего чека не было с 07.11» — уже нет.

**Факт 2: казна покрывает `0.77 %` OPEX, а не `0.04 %`.** В `PROJECT-HISTORY.md`, запись
2026-11-03 21:35, стояло `0.04 %`. Это арифметическая ошибка: `0.19815 TAR` делили на
`517 $` напрямую, забыв `USD_PER_TAR = 20`. Правильно `0.19815 × 20 = $3.96`, и
`3.96 / 517 = 0.77 %`. Совпадает с §1342, `PITCH-DECK.md:295`,
`REALITY-CHECK-v2.17.7.md:339`. Ошибка была в одном документе из четырёх — то есть
дубликат не спасал, а выравнивал.

**Попутно: эмиссия в `ROADMAP` §0 тоже была устаревшей.** Стояло Block `140.464667` /
Fee `7.152476` (95.16%). Прод отдаёт `143.663151` / `7.152481` = **95.26%**. Разница —
те самые четыре чека; направление вывода не меняется.

**Что в `MASTER-PLAN` не подтвердилось и править не стал.**
- «`archive/python-app/`» как доказательство Python-этапа: такого каталога **нет**, в
  `archive/` лежит только `lottery-tests/`. Ссылка в §116 и §207 `MANIFEST` на
  `archive/python-app/crypto.py` — на несуществующий файл. `crypto.py` в репозитории
  отсутствует (`find` → 0).
- «`SAME_ADDRESS` — успех, не ошибка» верно только для `worker-demo.js` (`applyLinkCode`):
  сервер отвечает `400 SAME_ADDRESS`, когда адрес ПК совпадает с адресом аккаунта. Это
  осмысленный отказ, а не успех; успехом его считает клиент.
- «45 таблиц» — верно: на проде `45`. Локальная копия базы агента отстала (`43`), и это
  не противоречие, а разные базы.

**Честная граница.** Проверены только те утверждения консолидации, которые видны в API
или в базе. Оценки готовности (`~38%`) не проверяемы числами — это суждение, а не факт.

---

### Б.51. 09.11.2026 19:2x MSK — `MASTER-PLAN.md` стал пятым каноническим документом

**Что изменилось в структуре.** `MASTER-PLAN.md` переехал в корень `backend-api/` —
рядом с `MANIFEST`, `PROJECT-HISTORY`, `PROJECT-MAP`, `ROADMAP`. Не в `docs/`:
это не отчёт и не план одной волны, а карта всего пути. В корне воркспейса — симлинк,
как у остальных канонических.

**Почему отдельный документ, а не раздел `ROADMAP`.** `ROADMAP` отвечает «что дальше»
на дни-недели и меняется при смене приоритета. `MASTER-PLAN` отвечает «где мы на пути»
на месяцы и меняется при закрытии этапа. Слить их — значит либо переписывать весь путь
при каждой смене очереди, либо терять историю этапов при переупорядочивании работ.

**Что нашлось при правке `verify.sh` (шаг 3.8).** Список проверяемых симлинков содержал
**7 имён из 11 существующих**. `ROADMAP.md`, `PROJECT-MAP.md` и `PROJECT-MEMORY.md`
симлинками были, но гейт их не смотрел — то есть три документа могли молча стать
копиями, и `7/7` оставалось бы зелёным. Это тот же класс дефекта, что расхождение
`EMAIL-TEMPLATE` 29.10: проверка выглядела полной, потому что считала только то, что
сама же перечислила. Теперь в списке 11 имён, пять канонических — первыми.

**Три ссылки на несуществующий каталог закрыты.** `MANIFEST` §116, §209 и `PROJECT-MAP`
§9 указывали на `archive/python-app/crypto.py` как на файл. Каталога **нет** (в `archive/`
только `lottery-tests/`), `find -name crypto.py` → 0. Формулировки переписаны: где
описание взято из истории, а не из кода — это сказано прямо.

**`$GRID` и JWS не добавлялись.** Проверено при сверке: `$GRID` в коде отсутствует,
`grep` по JWS пуст. `MANIFEST` §0 упоминает `$GRID / TAR` в таблице бренд-контуров —
это декларация тикера, а не реализация; в §Б.50 это уже зафиксировано.

**Честная граница.** Разделы §2, §3, §5–§7 `MASTER-PLAN` восстановлены из репозитория
(`PROJECT-HISTORY` §3, `REALITY-CHECK-v4` §7, `/summary`), потому что в присланном
тексте на их месте стояли заглушки `[Как в консолидации]`, а самой консолидации на
диске нет. Номера чеков, проценты и `active_workers` — из живого API 19:0x.

### Б.52. Срез 09.11.2026 20:4x MSK — `2.26.3-pre-nat-final`: миграция датасетов чуть не испортила данные

**Что проверялось.** Директива `v2.26.3-pre-nat-final`: актуальность `docs/NAT-TEST.md`,
реальный прогон `migrate-legacy-jsonl.js` и `prune-distill.js` на живых данных,
план второго seed в `ROADMAP`, отчёт `docs/PRE-NAT-STATUS.md`.

**`NAT-TEST.md` актуален — сверен с кодом, а не с памятью.** Проверено поимённо:
`--test-p2p`/`--p2p` (`worker-demo.js:1718–1719`), наличие флага в отдаваемом бандле
(`dist/tarnet-worker.js`, 9 вхождений), `exec "$NODE_BIN" "$WORKER_JS" $P2P_FLAG "\$@"`
(`install/install.command.tpl:322`), `cd "$TARNET_DIR"` (там же, `:302`), эндпоинты
`/download/worker.js`, `/download/p2p-node.zip`, `/p2p/bootstrap`, поля `bridge.*` в
`/p2p/status`, флаги `check-autostart.js --window/--interval/--json`, и отсутствие
`console.log` в `p2p-node/peer-auth.js` (утверждение «лога `peer-auth` нет» — верно).
Правок не потребовалось.

**Главное: `migrate-legacy-jsonl.js` был опасен.** `isEnc` распознавал шифром
**только** `enc:v1:`. С `2.26.0` `knowledge-loop.js` пишет `enc:v2:` с AAD
`${promptHash}:${field}` (`server.js:205`, `knowledge-loop.js:422`). На реальных
данных это дало ровно тот класс дефекта, что преследует проект: скрипт считал
**34 уже зашифрованных файла открытым текстом** (400 вместо 366) и на `--apply`
зашифровал бы **сам шифротекст**. Расшифровка вернула бы `enc:v2:…` вместо промпта —
датасет обучелся бы на шифротексте без единой ошибки в выводе. Проверено
моделированием: `encryptDeterministic("enc:v2:…")` → `enc:v1:…`, обратное чтение
даёт `enc:v2:…`, а не текст.

**Исправлено.** `isEnc` знает оба формата; `encryptDeterministic` и
`decryptDeterministic` принимают AAD и пишут `enc:v2:` когда он есть; `main`
передаёт `${obj.promptHash}:${field}`. Если `promptHash` в строке нет — пишется
`v1` (выдумывать хеш нельзя: сервер не пересчитает AAD). Проверено: dry-run
`366 / 56` совпал с независимым подсчётом; round-trip v2 читается; чужой AAD и
отсутствие AAD **отвергаются** (тег не сходится).

**Live-данные на 20:4x.** `storage/experience/`: **422 файла**, 1146 записей.
С открытым текстом **366 файлов / 2076 полей**, уже зашифрованы **56** (22 × `v1`,
34 × `v2`). `--apply` **не выполнен**: это необратимая запись в датасеты, решение
за Владельцем. `prune-distill.js` dry-run: обучено 0, устарело 0, оставлено 422,
освободилось бы 0 Б — удалять нечего.

**`ROADMAP` P1.2d.** Добавлен план переезда второго seed на чужой хост: провайдер не
`vdsina`, бюджет ~$5/мес (≈450 ₽), порядок работ, приёмка через гейт `4.4`, и явная
оговорка — «чужой провайдер ≠ чужой оператор»: требование останется открытым, пока
хост не у внешней стороны. Также **исправлен статус п.4**: там стояло «отдельной
строки в `verify.sh` нет», а секция `4.4` существует с `2.25.4` и требует ≥2 живых
seed с **разными** peerId.

**`docs/PRE-NAT-STATUS.md` создан.** Одна страница: что готово, что нужно от
Владельца, что после успеха (`v2.27.0`, этап 9 закрыт), что останется.

**Честная граница.** NAT-тест по-прежнему не выполнен: `/p2p/status` даёт
`connections: 1`, `worker_addresses: []`, `channels: 0` — это состояние ДО теста
(канала нет, пока воркер не запущен у человека), а не дефект. Механика мульти-seed
проверена на одном хосте; «децентрализованная сеть» в материалах — по-прежнему нельзя.

### Б.53. 09.11.2026 21:1x MSK — `docs/NARRATIVE.md`: история для инвесторов, сверенная с продом

**Повод.** Владелец получил от внешней модели (Gemini) нарративную историю проекта — «полная
эволюция простым языком». Как рассказ она лучшая из всего, что есть, но **отстала от кода на
несколько версий**. Пять утверждений были неверны, и каждое бьёт по доверию инвестора именно
потому, что звучит уверенно.

**Что было неверно и что стоит на самом деле:**

| В документе Gemini | Проверено |
|---|---|
| «текущая версия `v2.26.2-prep-for-nat`» | `/health` → `buildVersion: 2.26.3`, `status: ok` |
| «закрыли 1070 зелёных тестов» | `scripts/verify.sh` → **1324 ✅ / 0 ❌** (1070 — верный срез `v2.19.1`) |
| «сейчас пробиваем NAT» | NAT **не проверен**: воркер за домашним роутером не запускался; `/p2p/status` → `worker_addresses: []` |
| «доводим до конца кнопку связки» | привязка есть с 28.10, проверка владения — с `2.19.0`; `SAME_ADDRESS` — осмысленный отказ, не баг |
| «главный барьер — P2P без центрального сервера» | P2P-транспорт **работает** (задачи 07.11); барьер — NAT между двумя живыми машинами |
| «чек #776 — последний» | `#776` (04.11) — веха; последний чек — **`seq 793`** (09.11, 02:07) |

**`docs/NARRATIVE.md` создан** — пять актов, от «Биткоина для ИИ» до P2P. В отличие от
исходника, документ прямо говорит, **чего нет**: Thought Vectors, TEE (только флаг в БД),
смарт-контракты (`onchain.simulated: true`, 17 расчётов, «No blockchain integration»),
ночное обучение на GPU. Добавлены разделы, которых в исходнике не было: Discovery
(`WorkerRecord` + JCS + CIDv1 + `kadDHT` + GossipSub + `findProviders`, `GET /p2p/discover`,
re-announce 30 с — проверено: `ANNOUNCE_MS = 30000`), Swarm CANCEL (389 мс на живом
12-секундном запросе), два seed (4001/4002, разные peerId), Circuit Relay
(`maxReservations: 256`), `--expect-peer` (11/11 с SKIP → 12/12 честных).

**Все числа сверены с живым продом, а не с памятью:** `receipts: 793`,
`totalBlockRewardTar: 143.663151`, `totalFeeRewardTar: 7.152481`,
`treasuryBalanceTar: 0.19815`, `burnAudit.delta = treasuryAudit.delta =
conservation.delta = 0`, `GET /models` → 18 (15 облачных у 8 вендоров + 3 локальные),
`TIER6` → fee 0.0002 / cashback 0.0001. Константы из кода: `BOOTSTRAP_STAKE = 10`,
`MAX_RECEIPT_SHARE_OF_EPOCH = 0.25`, `TAR_UTILITY_BURN_RATE` + `TAR_UTILITY_TREASURY_RATE`
= 1% + 1% = 2% против 5% протокольной.

**Ссылка из `MASTER-PLAN.md`** — в шапке и в §0: нарратив описан как «тот же путь простым
языком» и явно **не заменяет** план.

**Правило записано в `AGENTS.md`:** при обновлении `MASTER-PLAN.md` проверять
`docs/NARRATIVE.md`; при расхождении побеждает код, нарратив правится тем же коммитом.

**Честная граница.** Это документ, а не новая функциональность: сборка остаётся `2.26.3`,
код не менялся. Ценность — в том, что теперь инвестор читает текст, каждое число которого
проверяемо командами из шпаргалки в конце, а не веру в правдоподобные цифры.

### Б.54. Срез 09.11.2026 21:5x MSK — `2.26.4-check-integrity`: гейт больше не принимает пустой набор

**Что изменилось по существу.** `scripts/verify.sh` считал набор зелёным при `exit 0` и
любой непустой строке `Итого:`. Набор, не выполнивший ни одной проверки, печатает
`Итого: 0 ✅ 0 ❌` и выходит с кодом `0` — гейт объявлял это зелёным. Теперь требуется
**ненулевое** число пройденных проверок (`passes > 0`, где `passes` — число до первого `✅`).

**Доказательство, а не утверждение.** Подставной скрипт из одной строки
`Итого: 0 ✅ 0 ❌` с `process.exit(0)` до правки получал вердикт «ok», после — «ноль
выполненных проверок». Пять контрольных случаев: `0 ✅` → красное, `1231 ✅` → зелёное,
`1230 ✅ 1 ❌` → красное, пустая строка → красное, `25 ✅ / 0 ❌` → зелёное.

**Правило в `AGENTS.md`.** Два блока: *exit code* (статус — `echo $?` сразу после команды,
при пайпе — `${PIPESTATUS[0]}` в том же списке; после `tail`/`grep`/`head` берётся их
статус) и *green needs a count* (ноль падений — не «зелено»).

**Аудит `scripts/` — 23 файла, ложных проверок кода возврата: 0.** `push-github.sh:23`
(`PIPESTATUS[0]`), `deploy.sh:171-172` (то же в том же списке), `verify.sh:72` (`$?` внутри
`sh -c`), `ensure.sh:119` / `tarnet-guard.sh:61` / `tarnet-supervisor.sh:81` (`rc=$?` сразу
после команды). Ложный `PUSH_RC=0` из предыдущего хода был в одноразовой heredoc-команде,
а не в скрипте.

**Аудит цифр `NARRATIVE.md` — 34 числа, одно расхождение.** «14 этапов» против 15
заголовков `Этап 0…14`: цифра не пересчитывалась с появлением этапа 0. Исправлено в
`MASTER-PLAN` («15 этапов»), `NARRATIVE` («карта 15 этапов»), `AGENTS.md` («15 stages»).
Остальные 33 подтверждены продом и кодом, включая `6 E2E-наборов` (пересчёт по файлам = 6)
и «каждые 30 секунд» (`ANNOUNCE_MS = RECORD_TTL_MS / 3 = 30000`).

**Устаревшая шапка `PRE-NAT-STATUS.md`:** «Сборка на проде: `2.26.1`» → прод отдавал
`2.26.3`. Исправлено на `2.26.4`.

**Девятое расхождение — отозвано 10.11.** `ROADMAP` §7 утверждал, что гейт симлинков
расширен «до 12 имён, было 7». В `d8ad61f` это было объявлено ошибкой и заменено на «было 6»
со ссылкой на `de99cd7` (29.10) — **эта правка сама была неверна**. `de99cd7` — коммит,
который гейт *создал* (6 имён), а не состояние *перед* расширением: `278a4df` (29.10 13:23)
добавил седьмое имя (`MANIFEST.v3.4-UNIFIED.md`), и в `82c837f` (09.11 19:11) `DOC_LINKS`
содержал 7 имён при 10 симлинках в корне. Сообщение коммита `2f1f89d` («7→11») верно,
не проверялись действительно три (`ROADMAP`, `PROJECT-MAP`, `PROJECT-MEMORY`).
Восстановлено «было 7»; см. §Б.55.

**Версия `2.26.4`, потому что менялся код, а не только документы.**

### Б.55. Срез 10.11.2026 05:0x MSK — `2.26.5-final-pre-nat`: отозвано девятое «расхождение»

**Что произошло.** В `d8ad61f` (09.11 21:58) `ROADMAP` §7 был «исправлен» с «было 7, не
проверялись 3» на «было 6, не проверялись 6» со ссылкой на `de99cd7`. Владелец принял
отчёт и дал директиву закрепить эту правку. Проверка цепочки `DOC_LINKS` по коммитам
показала, что неверна была сама правка.

**Цепочка, снятая из git (а не из сообщений коммитов):**

| Коммит | Дата | `DOC_LINKS` | Что изменилось |
|---|---|---|---|
| `de99cd7` | 29.10 09:16 | **6** | гейт создан |
| `278a4df` | 29.10 13:23 | **7** | добавлен `MANIFEST.v3.4-UNIFIED.md` |
| `82c837f` | 09.11 19:11 | **7** | состояние **перед** `2f1f89d` |
| `2f1f89d` | 09.11 19:27 | **11** | + `PROJECT-MAP`, `ROADMAP`, `MASTER-PLAN`, `PROJECT-MEMORY` |
| `7742b89` | 09.11 21:16 | **12** | + `NARRATIVE.md` |

**Почему «6» было ошибкой.** `de99cd7` — коммит, который гейт **создал**, а не состояние
**перед** расширением. Между ним и `2f1f89d` прошли сутки и `278a4df`, добавивший седьмое
имя. Симлинков в корне на 19:11 было десять (сверено `stat`: отсутствовал только
`MASTER-PLAN`, чей симлинк появился в 19:25), проверялось семь → не проверялись три:
`ROADMAP`, `PROJECT-MAP`, `PROJECT-MEMORY`. Сообщение коммита «7→11» было верным.

**Класс дефекта, на шаг глубже прежних.** Девять предыдущих случаев: источником факта
становился текст о действии. Этот десятый: источник взят из кода, но **из другого момента**
времени. Правило аудита цифр поэтому записано не как «найди источник», а как «источник
обязан относиться к тому же срезу, что и утверждение» (`AGENTS.md`,
`Rule (a number needs a moment)`).

**Где править было нечего.** В `docs/NARRATIVE.md` слово «симлинк» не встречается ни раз
(`grep -c` → `0`): технического утверждения о гейте там нет, цифра жила только в `ROADMAP`
§7 и в §Б.54. Директива предполагала правку в нарративе — это исправлено в отчёте, а не
молча проигнорировано.

**Этапы: 15, и это окончательно.** `grep -c '^### Этап ' MASTER-PLAN.md` → `15`; `Этап 0`
считается отдельным, потому что имеет собственный результат (Python MVP-0, Whitepaper v1.0)
и собственный список отозванного (Pipeline Parallelism, лотереи, `$330/мес`, Python-бэкенд).
Шапки всех семи документов уже говорили «15» после `d8ad61f` — менять нечего.

**Честная граница.** Это срез документов: код не менялся, сборка остаётся рабочей
`2.26.4` по механике, а `2.26.5` — номер релиза документов и правил. Прогон 05:03–05:06
MSK: 1324 ✅ / 0 ❌ по восьми наборам, все коды возврата `0`, `verify.sh` без тестов дал
GitHub = VPS = `d8ad61f`, `sha256` 150/150, симлинки 12/12.

### Б.56. Срез 10.11.2026 08:2x MSK — `2.26.6-fix-pre-nat-status`: документы врали о версии прода, гейт этого не видел

**Что нашлось.** `PRE-NAT-STATUS.md:4` утверждал «сборка на проде `2.26.4`», тогда как
`/health` отдавал `2.26.5`. Строка была написана в `9916453` — тем же коммитом, который
поднял `package.json` до `2.26.5`; то есть она была неверна **в момент написания**, а не
устарела позже. Тот же устаревший факт лежал ещё в четырёх живых документах:
`MASTER-PLAN` (шапка и §2), `NARRATIVE` (§«Где мы находимся» и шпаргалка сверки),
`PROJECT-MAP` (шапка), `MANIFEST` (шапка).

**Почему это пережило пять релизов.** Гейт проверял `/health` только на **код ответа**
(`HTTP 200`) и никогда — на **значение** `buildVersion`. Версия жила в двух местах
(`package.json` и текст документов), сверки между ними не было ни одной. Класс дефекта
тот же, что в `2.26.4`: проверка существует и смотрит не туда.

**Исправлено.** (1) Все пять живых документов приведены к живой сборке. (2) `verify.sh`
получил шаг **3.9**: `buildVersion` из `/health` сравнивается с `version` из
`package.json`, расхождение — красное. Это делает повторение невозможным механически, а
не дисциплиной. (3) `package-lock.json` был на `2.26.1` при `package.json` на `2.26.5` —
отставание на четыре релиза; синхронизирован в `2.26.6`. (4) `deploy.sh:166` уже содержал
защиту `[ ${#TOKEN} -ge 20 ] || die` — строже, чем предлагалось директивой; проверено на
сломанном формате `hosts.yml` (длина `0` → отказ), правило записано в `AGENTS.md`.

**Чего это НЕ доказывает.** Шаг 3.9 сверяет прод с `package.json`, но не сверяет
**текст документов** — документ может снова разойтись, если человек напишет версию руками.
Граница та же, что у симлинков: механизм закрывает то, что выражено в коде.

**Версия `2.26.6`**, потому что изменился `package.json` (номер сборки) и `verify.sh`
(поведение гейта), а не только текст.

### Б.57. Срез 10.11.2026 12:5x MSK — `2.26.7-honest-flags`: два High-дефекта, которые старше этой сессии

**Что нашлось.** Аудит (срез `2.26.6`) нашёл два обещания, которые не выполнялись, и
ряд менее тяжёлых. Оба High существовали до этой сессии и пережили `2.26.4`–`2.26.6`,
потому что гейт проверял код ответа, а не смысл полей.

**3.1 `isTeeAttested` принимался из тела — High.** `POST /node` читал флаг из
`req.body` и писал в `nodes` как есть. Любой клиент присылал `isTeeAttested: true` и
попадал в пул, из которого приватная маршрутизация выбирает исполнителя. На проде:
**53 узла** с флагом при **одной** строке `node_attestations` (`status: pending`).
То есть «приватные данные идут только на TEE-узлы» опиралось на булево, которое
прислал сам претендент. Тот же дефект был **вторым путём** в `/batch-test`: узлы
демо-батча получали флаг по `i % 3 === 0`.

**Исправлено.** Флаг читается **только** из `node_attestations.status = 'approved'`.
Заявка (`pending`) привилегий не даёт: иначе «аттестован» означало бы «попросил».
Демо-батч пишет `0` — он синтетический по определению. Итог: пока доверенной стороны
нет, флаг равен нулю у всех, и это честное `[SPEC / ROADMAP]`, а не недоделка.

**3.2 `source` описывал транспорт, а не генерацию — High.** При фолбэке менялся только
`emulated`, а `source` оставался `live_llm`. На проде: `live_llm/emulated=0` — 43,
`live_llm/emulated=1` — 37. По колонке `source` «живой LLM» отдал 80 ответов, в
действительности модель сгенерировала 43: любой отчёт `GROUP BY source` завышал живую
генерацию на **86%**. Честный флаг `emulated` при этом был и оставался верным.

**Исправлено.** `source = 'deterministic_fallback'` выставляется в **обеих** ветках
фолбэка (рой и одиночная). Плюс миграция:
`UPDATE inferenceLogs SET source='deterministic_fallback' WHERE source='live_llm' AND emulated=1`
— на проде это **37 строк**. `emulated` не переписывается: он и так верен, «исправлять»
правильное поле значило бы стереть улику.

**3.3 `/inference` без `prompt` — Medium.** Пустой `prompt` молча подменялся на
`'Hello from TarNet!'`: запрос с `messages` получал `200` и ответ на **другой** вопрос
— форма «ignored input». Теперь `400 PROMPT_REQUIRED`, в сообщении названо, что
`messages` не поддерживается.

**3.4 `/health` молчал о комитете — Medium.** `INSUFFICIENT_VALIDATORS` замечали только
внутри benchmark gate. Добавлен блок `committee: { candidates, eligible, required,
drawn, reason }`. Критерии взяты **из `knowledge-loop.js`**, а не переписаны: три
числа, разошедшиеся в двух местах, хуже отсутствия сигнала. `reason` различает
`insufficient_validators` (нужно железо) и `insufficient_stake` (нужны деньги) — разные
действия оператора.

**3.5 `/health` отдавал basename БД — Medium.** `path.basename(DB_PATH)` отрезал каталог:
на стенде `/health` показывал `sqlite://tarnet.db`, а работа шла с
`/var/lib/tarnet/tarnet.db`. Оператор открывал нулевой файл из рабочего каталога и
получал `no such table` на всех таблицах. Теперь полный путь плюс `databaseBytes`.

**3.6 `POST /wallet` отдавал приватный ключ — Medium.** Эндпоинт без аутентификации
возвращал `privateKeyPem` открытым текстом. Утечки не было только потому, что клиента
у него нет; это совпадение, а не свойство безопасности. Теперь ключ не возвращается.
Принимается `publicKeyPem` (Ed25519 SPKI), адрес выводится **из ключа**, а не берётся
из тела — иначе можно объявить чужой ключ своим.

**3.7 Мёртвые импорты.** `receiptPayloadV2` и `computeReceiptHash` не использовались —
убраны из импорта `dag-chain`.

**Дефект в моей же правке, пойманный приёмкой.** Проверка `dbSizeBytes === 0` не
срабатывала **никогда**: SQLite создаёт 4096-байтный заголовок при первом открытии, и
пустой файл к моменту ответа `/health` уже не пустой. Признак теперь снимается **до**
открытия базы (`DB_WAS_EMPTY_AT_START`), а не по текущему размеру. Это ровно тот класс,
о котором написано в Б.56: проверка есть и смотрит не туда.

**Проверено.** Приёмка живым HTTP (28 проверок, 0 ❌): `buildVersion = 2.26.7`;
`database` содержит каталог; тело `POST /node` с `isTeeAttested: true` → в ответе и в
`/nodes` `false`; `POST /wallet` без `privateKeyPem`; `/inference` без `prompt` → `400
PROMPT_REQUIRED`; `source = deterministic_fallback` и `emulated = true`; warning на
0-байтной БД. Полный гейт: **1325 ✅ / 0 ❌** по восьми наборам (dpouw 1233, mesh 25,
treasury 15, p2p-gossip 10, p2p-seed-failover 12, p2p-relay 10, p2p-reannounce 9,
p2p-discovery 11), все коды возврата `0`.

**Чего это НЕ доказывает.** TEE-флаг теперь честен, но **аттестации по-прежнему нет**:
признак «подтверждено железом» не проверяется ничем, потому что доверенной стороны не
существует. Закрыт вопрос «кто ставит флаг», а не «как флаг проверяется». Так же
`committee` показывает возможность собрать комитет, но не гарантирует, что он соберётся:
0 членов на проде — состояние, а не дефект.

**Версия `2.26.7`**, потому что изменилось поведение четырёх маршрутов и добавлена
миграция данных (`inferenceLogs`).

---

### Б.58. Срез 10.11.2026 15:0x MSK — `2.26.8`: правка приёма не пересчитала уже лежащие строки

**Что проверяли.** После деплоя `2.26.7` на прод — не «отдаёт ли `/health` новую строку»,
а **что стало с данными**, которые писались до правки.

**Найденный дефект.** `2.26.7` закрыл **запись** ложного флага: `POST /node` больше не
задаёт `isTeeAttested`. Но на проде оставались **53 узла с `isTeeAttested=1`** при **одной**
аттестации в статусе `pending`. `pickWorker` для `tier='expert'` выбирает пул запросом
`WHERE routingWeight > 0 AND isTeeAttested = 1` (`server.js:2242`) — то есть старая ложь
продолжала давать привилегию в приватной маршрутизации. Правка записи без миграции
оставляет ровно тот класс, о котором Б.56 и Б.57: **изменение есть, а эффекта нет**.

**Правка.** Добавлена идемпотентная миграция `migrateTeeFlagToAttestations()`: снимает
`isTeeAttested` у всех, у кого **нет** строки `node_attestations.status='approved'`. Узел с
одобренной аттестацией флаг сохраняет — это не «обнулить всё».

**Проверено до деплоя.** Сухой прогон на копии прод-базы (`/tmp/dryrun.db`): было 53 с
флагом, снято 53, осталось 0, **повтор снимает 0** — идемпотентность доказана, а не
заявлена.

**Проверено после деплоя.** На проде: `isTeeAttested=0` у **154/154** узлов; «флаг есть,
approved нет» — **0** строк. `verify.sh`: 8/8 ✅. Гейт: **1233 ✅ / 0 ❌** (dpouw).

**Честный побочный эффект.** `expert`-пул стал **пустым** (одобренных аттестаций ноль),
поэтому выбор уходит в общий пул через `teeFallback`. Это не регрессия: пустой пул —
следствие нуля аттестаций, и `fallback` уже был предусмотрен. Но означает, что
`tier='expert'` сейчас **не даёт** TEE-гарантии: гарантии нет ни у кого.

**Версия `2.26.8`**, потому что изменилось поведение выбора воркера на уже лежащих данных
и добавлена вторая миграция. `2.26.7` и `2.26.8` — **разные деревья под одним прежним
номером**, поэтому номер поднят: иначе `/health` не различал бы их, а это ровно та
двусмысленность, что ловил Б.56.

---

### Б.59. Срез 10.11.2026 15:3x MSK — `2.26.9-audit-p1-fixes`: пять дефектов аудита 3.3–3.7, четыре из них уже были закрыты

**Что проверяли.** Не «есть ли правка в коде», а **что отвечает живой HTTP**. Сервер
поднят на копии прод-базы (`/tmp/prod-copy.db`, 2322432 байт), а не на пустой схеме:
проверка на пустой базе доказывает, что маршрут жив, и ничего — о реальных данных.

**Задача 1 — сохранение ценности после миграции TEE.** Миграция меняет `nodes`, не балансы,
но это надо было **проверить**, а не предположить. Все три аудита: `conservation.delta 0`,
`holds: true` (`gross 151.206208 = distributed`); `burnAudit.delta 0` (`0.191388`);
`treasuryAudit.delta 0` (`expected 0.19815 = actual`). Откат не потребовался.

**3.3 (`/inference` без `prompt`) — уже был закрыт в `2.26.7`, теперь доказан.**
`POST /inference` с `{"messages":[…]}` без `prompt` → **`HTTP 400`**,
`{"error":"PROMPT_REQUIRED","received":"messages"}`. Шаблона «Hello from TarNet!» больше
нет. Доказательство снято на копии прод-БД, а не на пустой схеме.

**3.4 (`/health` о комитете) — уже был закрыт, критерий сверен.**
Блок присутствует: `{"candidates":23,"eligible":1,"required":5,"drawn":0,
"reason":"insufficient_stake"}`. Числа берутся из констант `knowledge-loop.js`
(`REQUIRED_COMMITTEE_SIZE`, `MIN_VALIDATOR_STAKE_TAR`, `VALIDATOR_STAKE_LOCK_TAR`), а не
переписаны рядом: три числа, разошедшиеся в двух местах, хуже отсутствия сигнала.

**3.5 (`/health` о базе) — НАЙДЕН НАСТОЯЩИЙ ДЕФЕКТ, исправлен здесь.**
Путь отдавался полный (`sqlite:///var/lib/tarnet/tarnet.db`), но `warning` при
**отсутствующем** файле БД **молчал**: `fs.statSync` бросал `ENOENT`, `catch` возвращал
`false`. А отсутствие файла — это свежая установка, самый частый первый запуск. Проверка
существовала и смотрела не туда — в третий раз тот же класс, что Б.56 и Б.58. Теперь
`ENOENT` = пустая база. Проверено три случая живым HTTP: 0-байтный файл → `warning` есть;
файла нет → `warning` есть; живая база 2322432 байт → `warning` нет.

**3.6 (`POST /wallet` и `privateKeyPem`) — уже был закрыт.** `HTTP 200`, в теле `address`,
`publicKeyPem`, `keySource`, `privateKeyHeldByServer`, `note`; поля `privateKeyPem` **нет**
(`grep -c` → 0). Ключ хранится на сервере, наружу не отдаётся.

**3.7 (мёртвые импорты) — уже был закрыт.** `receiptPayloadV2` и `computeReceiptHash`
отсутствуют в `server.js`; `node --check` чист.

**Проверено.** Гейт `test-dpouw.js --test`: **1233 ✅ / 0 ❌**, `rc=0`. Изменение кода в
этом коммите одно — `DB_WAS_EMPTY_AT_START`; остальные пять пунктов — доказательства, а не
новые правки. Поэтому номер поднят на минор: `/health` должен отличать дерево с исправленным
`warning` от `2.26.8`.

**Чего это НЕ доказывает.** Пять пунктов закрыты, но ни один не приближает TEE-гарантию:
`expert`-пул по-прежнему **пуст**, аттестаций ноль. `/health` теперь честно показывает
комитет — и честно показывает `eligible: 1` при `required: 5`.

---

### Б.60. Срез 10.11.2026 16:0x MSK — `2.26.10-pre-nat-final`: 1326, а не 1325, и почему это хорошая новость

**Что просили.** Прогнать восемь наборов и показать «1325 ✅ / 0 ❌».

**Что получилось.** **1326 ✅ / 0 ❌**, все восемь кодов возврата `0`:

| Набор | ✅ | Набор | ✅ |
| :--- | ---: | :--- | ---: |
| dpouw | 1233 | p2p-gossip | 10 |
| mesh | 25 | p2p-seed-failover | 12 |
| treasury | 15 | p2p-relay | 10 |
| p2p-discovery | **12** | p2p-reannounce | 9 |

**Откуда лишняя единица.** Не из нового теста — новый тест никто не писал. Разница
целиком в `p2p-discovery`: было **11**, стало **12**. Причина в проверке **4.3
«найденный провайдер совпал с `--expect-peer`»**. `verify.sh` вычисляет peerId из seed
(`DISCOVERY_SEED`) и передаёт его флагом; если вычисление не удалось, набор запускается
без флагов, и 4.3 уходит в SKIP — тогда «Итого» честно показывает 11. В прошлом срезе
(§Б.57, `2.26.7`) было именно 11; в этом прогоне peerId вычислился, проверка выполнилась,
и счёт стал 12.

**Почему это важно, а не косметика.** Ровно этот SKIP был болезнью, ради которой
`--expect-peer` сделали обязательным в гейте: годами набор показывал зелёное, а сверка
«нашли ИМЕННО ожидаемый узел, а не любой» не выполнялась ни разу. Поэтому 1326 — это не
«тестов стало больше», а **одна проверка перестала быть пропущенной**. Число выросло,
потому что покрытие стало честнее.

**Следствие для документов.** Заявленные ранее 1324 и 1325 — верные срезы своих версий
(`2.26.1`, `2.26.7`), их не переписываем. Текущий срез — **1326**. Формулировка «1325»
из директивы была снята с прогона, где 4.3 стояла в SKIP.

**Проверено.** `TARNET_TESTS_ONLY=1 bash scripts/verify.sh` → `ТЕСТЫ ЗЕЛЁНЫЕ`, rc `0`,
ноль падений, каждый набор с ненулевым счётом.

**Чего это НЕ доказывает.** 1326 проверок — это механика. Ни одна из них не проверяет
NAT, TEE и платящий спрос; `active_workers` в покое `0`, `expert`-пул пуст.

### Б.61. Срез 10.11.2026 16:1x MSK — воркер владельца на домашнем ПК: WebSocket-путь да, P2P-путь нет

**Что сделал владелец.** Запустил воркер на домашнем Windows-ПК (`C:\Users\Z-Boss\.tarnet\`)
без флага `--test-p2p`. Воркер: зарегистрировал узел `0x3b7928c8…` (`routingWeight` 1.5811),
привязал ключ к адресу, подключился по `wss://v1107336.hosted-by-vdsina.com/p2p/worker`,
прошёл Ed25519-хендшейк (`ws авторизован`).

**Что это доказало — и это реальный шаг вперёд.** Через этот узел прошёл живой инференс:
`POST /inference` → `source: live_llm`, `provider: home_worker`, `model: qwen2.5-coder:1.5b`,
`response: "Париж"`, `usage {prompt_tokens:48, completion_tokens:4}`, `promptHashVerified: true`,
`emulated: false`, `workerTaskId: wt_98d83b5f…`, чек `seq 794`. То есть путь
**домашний ПК → живая модель → ответ клиенту** работает и с машины за роутером.

**Что это НЕ доказало.** P2P-канал не открылся: в тот же момент `/p2p/status` →
`worker_addresses: []`, `channels: 0`, `framesIn: 0`, `connections: 1` (и это второй seed
на `127.0.0.1:4002`, а не воркер). Задача пришла по WebSocket, а не по libp2p. Уровень C
(«воркер за NAT находит мост без входящего порта») остаётся **пустым**: нужен запуск именно
с `--test-p2p` по `docs/NAT-TEST-SHORT.md`.

**Побочное наблюдение, важное для наблюдаемости.** `polls` в `/worker/status` почти не рос
(158→160 за минуты), хотя `lastSeenAgoMs` держался в пределах секунд. Причина:
`ws-inbound.js:296` пишет `lastSeenAt` на WS-heartbeat раз в 10 с **без** инкремента `polls`,
а `polls` растёт только на HTTP `/worker/poll`. Это не баг, а два разных пути присутствия;
но вывод «`polls` не растёт → воркер мёртв» был бы ложным при живом WS.

**Инварианты на срезе.** `conservation {gross:157.223281, distributed:157.223281, delta:0, holds:true}` ·
`burnAudit.holds:true` · `treasuryAudit.holds:true` · чеков `794`, воркеров `96` ·
`active_workers: 1`, `llm_mode: worker` · `committee {candidates:23, eligible:1, required:5,
drawn:0, reason:insufficient_stake}` · `buildVersion 2.26.10`.

**Чего это НЕ доказывает.** Один ручной узел — не сеть. `expert`-пул пуст, TEE нет,
платящего спроса нет, P2P за NAT не проверен.
`[ПОПРАВКА 11.11.2026: последнее утверждение устарело — P2P за NAT проверен, см. §Б.67.
Остальные четыре остаются в силе без изменений.]`

### Б.62. Срез 10.11.2026 17:0x MSK — `2.26.12-installer-p2p-fix`: установщик привозит `jcs.js` и пробрасывает аргументы

**Что сломано и как это выглядело.** Тестовый запуск на ПК владельца дал два отказа,
которые делают P2P нерабочим «из коробки», хотя приложение при этом выглядит живым:

1. `Error: Cannot find module '../jcs.js'` из `p2p-node/worker-record.js`. Архив
   `/download/p2p-node.zip` вёз **только 13 файлов `p2p-node/*`**, а `worker-record.js:34`
   берёт канонизатор из родительской папки (`requireFromHere('../jcs.js')` — один JCS на
   репозиторий, а не второй экземпляр). В клоне `../jcs.js` резолвится сам, в
   `%LOCALAPPDATA%\TarNet` — это файл в корне папки воркера, которого не было. Ребёнок
   падал до первого `announce()`, и снаружи это читалось как «P2P не работает».
2. `start.cmd` игнорировал аргументы: строки запуска печатались без `%*`. Человек
   запускал `start.cmd --test-p2p`, получал обычный `--p2p`-воркер, видел `channels: 0`
   и делал вывод об отказе NAT. Документированная команда проверки не работала.

**Что сделано.** `p2p-bundle.js` получил второй список — `ROOT_FILES = ['jcs.js']`:
корневые файлы кладутся в архив **без** префикса `p2p-node/`, поэтому после распаковки
`../jcs.js` из `p2p-node/` указывает точно на него. Штамп кеша теперь учитывает и
корневые файлы (правка `jcs.js` инвалидирует архив, иначе разбор расхождения подписи
начался бы с неверного файла). Оба установщика проверяют `jcs.js` **до** `npm ci`:
нет файла — транспорт не поднимается, а причина называется вслух
(`:p2p_no_jcs` в `.bat`, ветка `JCS_OK=0` в `.command`). Строки запуска в `start.cmd`
печатаются как `%%*`, что даёт литеральный `%*` — аргументы доходят до `node`.

**Автоопределение capabilities — что было на самом деле.** Три переменные
(`P2P_MODEL_FAMILIES`, `P2P_DEVICE_CLASS`, `P2P_RUNTIMES`) установщик выставлял
**с 2.26.0**, то есть «их нет» было неверно. Настоящая дыра другая: семейство
обнулялось, если модель уже стояла на машине и шаг `ollama pull` пропускался
(`SKIP_MODEL=1`) — установщик объявлял «возможностей нет» при рабочей модели рядом, и
`announce()` выходил до `provide()`. Добавлен честный запрос к Ollama:
`ollama list` в `.bat` (`skip=1`, `delims=:`) и `tail -n +2 | cut -d: -f1` в `.command`,
только когда семейство всё ещё пусто. Явный `TARNET_MODEL` остаётся главнее.

**`--self-check` расширен.** Проверяет `jcs.js` и `@libp2p/gossipsub` /
`@libp2p/circuit-relay-v2` — но **только если `p2p-node/` лежит рядом**. Условие
обязательное: воркер законно живёт без транспорта (работа по WS), и безусловная
проверка валила бы установку на машине без P2P, а тест `31.24` запускает файл в
пустой папке именно как у пользователя. Негативные прогоны проверены вручную:
без `jcs.js` → `RC=1` с названной причиной, без `gossipsub` → `RC=1`.

**Инварианты на срезе.** Гейт `1327 ✅ / 0 ❌` (1234+25+15+12+10+12+10+9 — плюс одна
проверка `54.2a` на расположение `jcs.js` в корне архива) · архив **`14` записей,
`247230` байт распакованных, `jcs.js` в корне** · `node --check` на `worker-demo.js`,
`p2p-bundle.js`, `test-dpouw.js` — чисто · шаблон `.bat` остаётся чистым ASCII без CR.

**Размер ZIP не является инвариантом.** 10.11 при сверке локальной сборки с продом
вышло `84644` против `84203` байт при одинаковых 14 записях. Причина не в коде:
сжимает zlib, а он разный — VPS на node `v22.22.1` / zlib `1.3.1`, рабочее дерево на
node `v24.19.0` / zlib `1.3.2.1`. Сверка по записям дала `CRC` и `file_size` совпавшими
**14/14**, разошёлся только `compress_size` (сумма `82505` против `82946`). Поэтому
проверять архив надо по **именам + CRC + распакованным размерам**, а не по длине файла:
тест на байтовую длину проходил бы на одной машине и падал на другой, не отражая
ни одного реального дефекта.

**Чего это НЕ доказывает.** Установщик не прогонялся на живой Windows в этом срезе:
проверено сборкой архива, разбором его central directory, рендером шаблона и
`--self-check` в четырёх режимах. Финальное доказательство — установка на ПК владельца
с нуля и `start.cmd --test-p2p`.

### Б.63. Срез 10.11.2026 18:0x MSK — `2.26.13-worker-vs-node`: «P2P в сети» перестало означать «есть кому работать»

**Что показал прод до правки.** Три ответа, снятые подряд:

| Endpoint | Что вернул |
| :--- | :--- |
| `/health` | `active_workers: 0`, `llm_mode: deterministic_fallback`, `buildVersion: 2.26.12` |
| `/p2p/status` | `nodes: 3`, `routeNodes: 3`, `bridge.connections: 1`; **верхнего поля `connections` нет** — счётчик лежит внутри `bridge` |
| `POST /inference` | `source: deterministic_fallback`, `receipt: null`, `breakdown: null`, `fallback_reason: no_workers`, `pending_work: 40` из `threshold: 50` |

**Дефект.** Сайдбар рисовал одну строку и красил точку зелёным, когда `routeNodes.length > 0`. На проде это давало «P2P в сети · 3 узла» одновременно с `no_workers`. Владелец выключил домашний ПК, увидел зелёный транспорт и не понял, почему задача не выполняется. Ошибка не в вёрстке: **узлы и воркеры — разные факты**, и один индикатор физически не может сказать оба.

**Почему `routeNodes` не годится как признак сети.** Это демо-меш из трёх процессов на `127.0.0.1` — сам `server.js` называет его «три процесса в одной машине сетью не являются». Считать его узлами значило бы показывать «3 узла» там, где реальное соединение одно (`bridge.connections`).

**Что сделано (`2.26.13`).**

- `app/app.js`: `p2pNodes` берётся **только** из `bridge.connections`; `null`, а не `0`, если мост не ответил — «не знаю» и «ноль» разные факты.
- `lastHealth` — последний `/health`, источник `active_workers` для сайдбара. Отдельного запроса нет: второй запрос ради той же цифры — лишний трафик на лимит и второй источник истины.
- `paintNetworkStatus()` — отдельная перерисовка, потому что два числа приходят разными путями в разное время; перерисовка по факту каждого прихода — единственный способ не показать устаревшее «воркеров: 1» после выключения ПК.
- Три состояния точки: `on` — есть соединения **и** воркеры; `warn` (янтарный) — транспорт есть, работать некому; `off` (серый, без пульсации) — соединений нет; серый пустой — данных нет.
- `app/index.html`: `<span id="workerText">` рядом с `p2pText` — второе число отдельным узлом разметки, а не склейкой в одну строку.
- `app/styles.css`: `.dot.warn`, `.dot.off` переведён на `muted-2` без анимации (мигающий серый читался как «вот-вот поднимется»), `.trace-note` для пояснения под трассой.
- Error-путь `refreshWorkerBanner` сбрасывает `lastHealth` и перерисовывает сайдбар: иначе при молчащем сервере сайдбар вечно показывал бы число от последнего удачного опроса — и именно в этот момент оно читалось бы как факт.

**Демо-ответ объясняет происхождение TAR — без выдуманного номера чека.** Заголовок называет причину из ответа сервера (`fallback_reason === 'no_workers'` → «в сети нет активных воркеров»), а не общее «модель не подключена». Под трассой — `.trace-note`: заглушка копит работу в `pending_work`, чек выпускается только после порога и помечается как «демо: порог обойдён». Числа `40` и `50` берутся из ответа, а не из константы: у тира nano порог `500`, и захардкоженное число стало бы враньём при смене тира. **Номер чека не подставляется** — он не выдан в момент ответа, и любой вписанный номер был бы обещанием записи, которой в базе нет. `MODES.deterministic_fallback` переименован в «демо-режим: нет активных воркеров».

**Проверки.** Блок `38.14` — шесть штук: `bridge.connections` вместо `routeNodes`; `active_workers` в сайдбаре; наличие `.dot.warn` в CSS **и** `dot warn` в коде; `id="workerText"` в **отданной** разметке; `trace-note` с объяснением; отсутствие `#796` в исходнике.

**Гейт поймал мою же ошибку.** Первый прогон: `1239 ✅ / 1 ❌` — проверка «в тексте нет выдуманного номера чека» упала, потому что номер остался в **комментарии кода**, объясняющем, почему его там нет. Тест читает файл целиком, и это правильно: номер в комментарии всё равно просочился бы в исходник при копировании. Номер убран, второй прогон `1240 ✅ / 0 ❌`.

**Инварианты на срезе.** Полный гейт **`1333 ✅ / 0 ❌`** (`TARNET_TESTS_ONLY=1`): dpouw **1240**, mesh 25, treasury 15, discovery 12, gossip 10, seed-failover 12, relay 10, reannounce 9. `node --check` на `app/app.js` и `test-dpouw.js` — чисто. Размеры: `app/app.js` 3261 строка, `app/styles.css` 2087, `app/index.html` 746, `test-dpouw.js` 11162.

**Чего это НЕ доказывает.** На срезе `active_workers: 0`, поэтому **янтарное** состояние видно в коде и тестах, но не на живом экране с работающим воркером: чтобы увидеть зелёное, нужен включённый ПК владельца. Проверка «воркер появился → точка позеленела» — ручная, одним запуском воркера, и в этом срезе не выполнялась. Номер чека не был выдуман и не мог быть: `/inference` вернул `receipt: null`, то есть чека за этот ответ не существует.

### Б.64. Срез 10.11.2026 18:3x MSK — `2.27.0`: установка перестала отменяться из-за неполного P2P

**Как пришли.** Владелец проверил четыре утверждения про установщик и P2P. Три оказались
неверными по факту (Этап 9 «закрыт» — нет, блокер на месте; `libp2p`/`kad-dht` «нет в
`package.json`» — есть и в репозитории, и в архиве на проде, lockfile сходится; «установщик
ищет `npm`, а не `npm.cmd`» — искал уже с 2.26.12). Четвёртое подтвердилось и было настоящим
дефектом.

**Дефект.** `worker-demo.js --self-check` бросал исключение, если не хватало
`@libp2p/gossipsub` и соседей. Установщик вызывал `--self-check` и на ненулевом коде делал
`exit /b 1` — то есть **неполный p2p-транспорт отменял всю установку**, хотя собственный
контракт установщика (`2.22.7`) гласит: любой отказ p2p — это `WARNING`, а работа идёт по WS.
Воркер без libp2p полностью работоспособен; человек оставался без воркера из-за необязательной
части.

**Что сделано (`2.27.0`).**

- `worker-demo.js`: `--self-check` собирает `p2pProblems[]`, печатает
  `WARNING — p2p-транспорт неполный: …` с именами пакетов и завершает `self-check: ok` с
  **кодом 0**. Транспорт — диагностика, а не условие запуска.
- `install/install.bat.tpl`: поиск npm больше не привязан к папке рядом с `node.exe`.
  Цепочка `where npm.cmd` → `where npm` → `%NODE_DIR%node_modules\npm\bin\npm-cli.js`,
  результат в `NPM_CLI`, и именно он идёт в `"%NODE_EXE%" "%NPM_CLI%" ci`. До этого на
  nvm/fnm и портативном Node `npm ci` молча не запускался: `node.exe` есть, npm рядом нет.
- Проверки после `npm ci` — `import('libp2p')` и `@libp2p/kad-dht`: провал по-прежнему
  `WARNING` и WS, но теперь причина названа пакетом.

**Проверки.** Блок `38.15` — пять штук: `where npm.cmd` и `where npm ` в отданном
установщике; `npm-cli.js` **в самом вызове** `ci`, а не только в комментарии; `libp2p` и
`@libp2p/kad-dht` в пост-проверке; живой запуск собранного воркера в папке с
`p2p-node/p2p-worker.js` и **без** `node_modules` → код 0, `WARNING`, назван `libp2p`.

**Пойманная ловушка теста.** Первая вставка блока попала **после** закрытия блока 38, где
`batText`/`dlText` не объявлены. Гейт этого не показал (упал раньше по синтаксису), но
`ReferenceError` был бы гарантирован. Блок сделан самодостаточным: сам качает
`/install/install.bat` и `/download/worker.js` — проверяется **отданный** артефакт, а не
шаблон на диске, куда сервер подставляет адрес и сборку.

**Инварианты на срезе.** Полный гейт **`1338 ✅ / 0 ❌`** (`TARNET_TESTS_ONLY=1`): dpouw
**1245**, mesh 25, treasury 15, discovery 12, gossip 10, seed-failover 12, relay 10,
reannounce 9. `node --check` на `test-dpouw.js` — чисто. Размеры: `worker-demo.js` 1989,
`install/install.bat.tpl` 512, `test-dpouw.js` 11225.

**Чего это НЕ доказывает.** Живой прогон шёл на собранном воркере без `node_modules` — это
ровно случай «`npm ci` не выполнился», но не случай Windows-машины с nvm: `where npm.cmd`
там проверен только по тексту установщика. Проверка «человек поставил на чистой Windows и
воркер поднялся» остаётся за Этапом 9 и требует ПК владельца.

### Б.65. Срез 10.11.2026 19:0x MSK — `2.27.1`: сеть была, а сервер считал её пустой

**Как пришли.** Владелец запустил воркер с `--test-p2p`, увидел в логе
`[p2p-worker] поток задач открыт: /tarnet/task/1.0.0` и
`[p2p-worker] объявлен провайдер`, а задача из чата не приходила: в PWA
`no_workers`, в консоли воркера тишина.

**Что произошло на самом деле.** Воркер был прав, сервер — нет. Гейт перед
отправкой задачи стоял один:

```js
if (hasActiveWorker()) { /* ветка воркера */ }
```

`hasActiveWorker()` считает строки `worker_presence` за последние 60 с. Туда
пишут ровно два канала — опрос `/worker/poll` и WS-кадр. `--test-p2p`
выключает **оба** намеренно (иначе задача пришла бы не по libp2p, и проверка
транспорта ничего не доказывала бы). Значит для такого воркера счётчик всегда
ноль, ветка не выполнялась, и запрос уходил в шаблон с
`fallback_reason: 'no_workers'` — при открытом канале и ждущем работу воркере.

**Три утверждения из разбора, которые проверил и опроверг.**

- «`pickWorker` смотрит на `active_workers`» — нет. `pickWorker` читает
  таблицу `nodes` (`routingWeight > 0`), а строка там появляется из
  `POST /node`, который воркер делает на старте до всякого WS.
- «`dispatchTaskOverP2p` не вызывается при `active_workers === 0`» — сам по
  себе вызывается: условие там — состояние строки `worker_tasks`
  (`pending` после неудачного WS). До него просто не доходило, потому что
  гейт выше не пускал в ветку.
- «`503 no_workers` отдаёт `pickWorker`» — 503 отдаётся только когда в
  `nodes` нет ни одного узла с весом; это отдельная ветка, и в описанном
  сценарии она не срабатывала.

**Что исправлено.**

- Новый модуль `dispatch-gate.js`: `workerSources` / `hasWorkerSource` /
  `describeWorkerSources` / `channelAddressInRegistry`. Решение «есть ли кому
  отдать» вынесено из `server.js` в файл, который можно `require` в тесте —
  именно поэтому ошибка и прожила до живого экрана.
- Гейт перед веткой воркера спрашивает **два** источника: присутствие и
  каналы моста. Мост опрашивается только когда присутствия нет, чтобы
  обычный путь не платил за лишний поход в сокет.
- Если `pickWorker` вернул пусто, но канал открыт у **зарегистрированного**
  узла — адресат берётся из канала (`routing.mode: 'p2p_channel'`). Это
  закрывает случай «узел есть, `routingWeight = 0`» (законсервированные нули
  в старой БД), когда выбор по весам пуст, а работа есть.
- Канал у **незарегистрированного** адреса в работу не берётся: `recordWork`
  бросает `Unknown worker node`, и запрос стал бы **500 уже после отправки** —
  воркер выполнил работу, а начислить некому. Проверено живьём: первая
  версия правки давала ровно этот 500.
- Логи `[dispatch] p2p: задача … → адрес (каналов N)` и
  `[dispatch] p2p: задача … не отправлена — причина`.

**Проверки.** Блок `38.16` — одиннадцать штук. Пять юнит-проверок модуля
(канал как источник, пусто, строка `'0'` из env, годный адрес, адрес без
строки в реестре) и живой прогон: поддельный мост на unix-сокете говорит на
настоящем протоколе, сервер получает `P2P_BRIDGE_SOCKET`, узел регистрируется
через `POST /node`, ключ привязывается подписью ed25519 — и `/inference`
возвращает `worker_timeout` вместо `no_workers`, а мост видит кадр `task`
с адресом канала. Обратная проверка: канал без регистрации даёт честный
503, а не 500.

**Инварианты на срезе.** Полный гейт **`1349 ✅ / 0 ❌`** (`TARNET_TESTS_ONLY=1`):
dpouw **1256**, mesh 25, treasury 15, discovery 12, gossip 10, seed-failover 12,
relay 10, reannounce 9. `node --check` на `server.js`, `dispatch-gate.js`,
`test-dpouw.js` — чисто. Размеры: `server.js` 10740, `dispatch-gate.js` 107,
`test-dpouw.js` 11363.

**Чего это НЕ доказывает.** Живого воркера владельца в этом срезе нет
(`worker_addresses: []`, `active_workers: 0`), поэтому проверка «человек
отправил задачу из PWA и получил ответ с домашнего ПК» не выполнялась:
она требует включённого ПК. Доказано другое и более узкое — что запрос
доходит до P2P-кадра при нулевом присутствии; что именно ответит настоящий
libp2p-воркер, проверяется только на нём.

---

### Б.66. Срез 11.11.2026 08:1x MSK — `2.27.2`: канал был жив, выбирали не того

**Как пришли.** Владелец запустил воркер с `--test-p2p`. В консоли воркера:
`hello отправлен`, `поток задач открыт: /tarnet/task/1.0.0`, `запись объявлена:
seq 8…`, `жив: соединений 1`. В чате — «…» и таймаут. В `/p2p/status`:
`channels: 1`, `worker_addresses: ["0x3b7928…"]`, `connections: 2`.

**Что показал лог сервера.** Гейт из §Б.65 сработал — в логе есть отправка,
но она же и отказ:

```
[dispatch] p2p: задача wt_801d2c49… не отправлена — no_channel
             (каналов 1, просили 0x000000000000000000000000000001a16045cd33)
[dispatch] p2p: задача wt_9ac289b9… не отправлена — no_channel
             (каналов 1, просили 0xa637041ae5a353e9c8079aaefa354037fc500c5a)
```

Канал один — `0x3b7928c88de427c5b27d78ca63dde8c80823267f`. Сервер просил
**другие** адреса. То есть вопрос был не «видит ли гейт канал» (видит), а
«кому именно он решил отдать задачу».

**Причина.** `pickWorker` выбирает взвешенно по **всем** строкам `nodes` с
`routingWeight > 0`. В таблице было **152** строки с суммой весов **389.7**:
демо-узлы, адреса прошлых тестов, мусор вида `0xnoollama94400b62d3…` и
`0x000000000000000000000000000001a16045cd33`. Живой воркер владельца имел
вес **1.58**, то есть долю **0.4%**. Практически каждый запрос получал
мёртвый адрес. Дальше:

1. адрес записывался в `intendedWorker` строки `worker_tasks`;
2. P2P-ветка просила канал у этого адреса — у мёртвого его нет → `no_channel`;
3. строка оставалась `pending`, но с `intendedWorker = <мёртвый>`;
4. `/worker/poll` выдаёт только `intendedWorker = свой` **или `NULL`** — живой
   воркер такую строку не видел вообще;
5. задача истекала по TTL.

Обе задачи из лога лежат в БД со статусом `expired` и мёртвым
`intendedWorker` — не гипотеза, а две строки.

**Что исправлено.**

- `dispatch-gate.filterToLive(pool, liveSet)` — сужение множества кандидатов
  до адресов с признаком жизни. Пустой или несовпавший набор возвращает пул
  целиком: без живых узлов прежнее поведение сохраняется.
- `pickWorker(tier, liveSet)` спрашивает `liveWorkerAddresses()` — адреса из
  `worker_presence` за то же окно `WORKER_ACTIVE_WINDOW_MS`, что у
  `hasActiveWorker`. Один признак жизни — одно окно; иначе «живой» для выбора
  и «живой» для гейта значили бы разное.
- `dispatchTaskOverP2p` при отказе (`no_channel`, `all_excluded`,
  `no_bound_key`) **снимает `intendedWorker`** (`status = 'pending'`), чтобы
  задачу забрал опрос. Это закрывает шаг 4 выше — раньше отказ оставлял
  строку невидимой для всех. Безопасно: `UPDATE` ограничен
  `status = 'pending'`, то есть пока никто её не забрал, двойной генерации
  быть не может.

**Доказательство.** Блок `38.17`, шесть проверок: три юнит (`filterToLive`) и
живой прогон — 20 мёртвых узлов с `stake 1e6` (вес ≈ 900 каждый) против
одного живого с `stake 100` (вес 9). При старом правиле шанс попасть в живого
0.05%. Задача доходит до живого воркера и его ответ — до клиента. Полный гейт
**1355 ✅ / 0 ❌**: dpouw **1262**, mesh 25, treasury 15, discovery 12,
gossip 10, seed-failover 12, relay 10, reannounce 9.

**Чего это НЕ доказывает.** Сквозной сценарий «включил ПК, отправил из PWA,
получил ответ по libp2p» в этом срезе не выполнялся: в момент правки на проде
`worker_addresses: []`. Проверено, что выбор больше не уходит мёртвому адресу
и что отказ возвращает задачу в очередь; что ответит настоящий libp2p-воркер
владельца — проверяется только на нём.

### Б.67. Срез 11.11.2026 09:5x MSK — `2.28.0`: P2P за NAT доказан, Этап 9 закрыт

**Что изменилось в факте, а не в тексте.** Задача из PWA прошла по libp2p до
домашнего Windows-ПК за роутером и вернулась с ответом. Раньше это утверждение
стояло в документах как «не проверено», и было верным; теперь проверено.

**Доказательство — журнал и БД, не пересказ.**

| Факт | Значение |
|---|---|
| `[dispatch] p2p: задача wt_9a5dea… → 0x3b7928c8… (каналов 1)` | 06:03:10 UTC |
| `wt_a28e79…` — `done`, `source=ollama`, `error=NULL` | 06:41:31 UTC |
| `wt_377ac7…`, `wt_33efda76…` — `done`, `source=ollama` | 06:49:36 / 06:49:54 UTC |
| Чек `803`, `workerSeq 9`, `cwu 51`, `0.115381 TAR`, подпись есть | 06:03:10 UTC |
| Чек `804`, `workerSeq 10`, `cwu 89`, `0.2758 TAR`, `batchedFrom` 3 действия | 06:49:59 UTC |

**Уточнение, которое стоит держать в голове.** Первая задача (`wt_9a5dea…`)
доставлена по P2P, но исполнена заглушкой: `source=deterministic_fallback`,
`error=OLLAMA_NOT_RUNNING`. Живая модель отработала позже, на `wt_a28e79…`.
«Дошло по libp2p» и «ответила модель» — два разных факта; здесь доказаны оба,
но на разных задачах.

**Чего это НЕ доказывает.** Сети нет: один ПК, включаемый руками; второй seed на
том же VPS; перезагрузка роутера и смена сети не проверены; TEE, второго
оператора и платящего спроса нет. Закрытие Этапа 9 — про транспорт, не про сеть.

**Изменения в этом же срезе.** `package.json` и оба поля `package-lock.json`
переведены на `2.28.0` (до этого lock отставал на `2.27.1` — расхождение,
которое `verify.sh` не ловит, потому что сверяет версию прода с `package.json`,
а не с lock). Текст `OLLAMA_NOT_RUNNING` в PWA называет `ollama list`: 11.11
владелец получил этот код при исправной на вид установке, и совет «запустите»
был бы бесполезен.

**Документы.** `PROJECT-HISTORY.md` — веха 11.11.2026; `MASTER-PLAN.md` — Этап 9
переведён в 🟢 Закрыт, срез §2 обновлён (804 чека); `docs/INVESTOR-CHECKLIST.md`
— строка «NAT не проверен» заменена на «NAT пробит с одной стороны» с границей.

### Б.68. Срез 11.11.2026 12:4x MSK — `2.28.1`: Discovery на проде не искал, а делал вид

**Что было не так.** Живой `GET /p2p/discover?model=qwen2.5-coder:1.5b` на проде
отдавал:

```
{"found":0,"providers":1,"rejected":[{"peerId":"[object Object]",
 "error":"DIAL_FAILED:Please pass a multibase decoder for strings that do not start with \"1\" or \"Q\""}]}
```

Три раза из трёх. `providers: 1` выглядело как «провайдер есть», и именно так этот
ответ читался при сверке. Разбор показал обратное: **провайдера не было**, а единица
получалась из самого события.

**Корень — раздвоен, и это важнее симпотома.**

| | Дефект | Симптом |
|---|---|---|
| D1 | Разбор `findProviders` не смотрел на имя события: `Array.isArray(evt?.providers) ? evt.providers : [evt]`. У `DIAL_PEER` поля `providers` нет, поэтому в список попадало событие целиком. | `peerId: "[object Object]"` → `DIAL_FAILED` |
| D2 | В DHT нет записи о воркере: datastore моста **in-memory**, TTL записи **90 с**, воркер не запущен (`active_workers: 0`). После рестарта моста 11.11 10:54 таблица пуста. | `providers: 0` при исправленном разборе |

Поле `p.id` — единственный правильный путь: в `PeerInfo` (kad-dht 16.4.9) это
`id: PeerId`, `multiaddrs: Multiaddr[]`. Свойства `p.peerId` в структуре нет вообще,
а `p.toString()` на объекте всегда даёт `"[object Object]"`: **обе ветки прежнего
разбора были мертвы при любых данных**. Проверено пробником на живом seed: события
потока — `DIAL_PEER`, `SEND_QUERY`, `PEER_RESPONSE`, `PATH_ENDED`; события `PROVIDER`
не было вовсе, потому что запись отсутствовала.

**Почему 12 зелёных тестов не помешали.** Тест разбирал события своим кодом
(`evt.type === EventTypes.PROVIDER && Array.isArray(evt.providers)`), прод — другим.
Два пути разбора: тест проверял удачный, прод шёл по сломанному. Это тот самый
класс дефекта, который §5.8 называет «согласованность механики вместо работы у
человека».

**Что сделано в коде.**

- `extractProviderIds(events)` — экспортируемая функция в `p2p-node/discovery-client.js`;
  фильтрует **только** `name === 'PROVIDER'`, берёт `p.id.toString()`, дедуп по множеству.
- `findWorkers()` зовёт её же — инлайн-копии больше нет.
- Тест `test-discovery-e2e.js` импортирует её из прод-модуля, а не дублирует разбор.
- Проверка **4.0** — ловушка, а не happy path: подаёт `DIAL_PEER` без `providers` и
  `PeerInfo`-подобный объект без `id`, требует `length === 0`. Возврат старой логики
  теперь краснеет.

**Доказательство.** `p2p-discovery` — **13 ✅ / 0 ❌** (было 12: добавлена 4.0).
E2E на трёх живых libp2p-узлах: `4.0` ловушка, `4.1` события, `4.2` воркер найден по
CID, `5.1` поток открыт, `5.2` схема, `5.3` peerId совпал, `5.4` подпись, `5.5`
подделка отвергнута.

**Чего это НЕ доказывает.** Поиск через NAT у человека. Правка чинит **разбор**, а не
доступность: чтобы A3 (`found ≥ 1` на проде) стала осмысленной, на ПК владельца должен
работать воркер — иначе пустая таблица DHT честно отвечает «никого нет». Плюс datastore
моста не переживает рестарт: после каждого деплоя записи нужно переиздать заново.

### Б.69. Срез 11.11.2026 13:1x MSK — диск `594 → 809 МБ`, история сохранена

**Кода не касается.** Правка инфраструктурная, номера сборки не меняет:
прод остаётся `2.28.1`, тесты — **1356 ✅ / 0 ❌**, `delta === 0`.

**Зачем.** Приоритет №1 (`MASTER-PLAN` §6) — ребут-тест на ПК владельца. При 94–95%
занятости следующий `npm ci` упал бы на `ENOSPC`, и провал теста стал бы неотличим
от провала сборки. Диск был предварительным условием, а не отдельной задачей.

**Три рычага, которые оказались мёртвыми — проверено, не предположено.**

| Рычаг | Замер | Почему не помог |
|---|---|---|
| Полный `VACUUM` | `freelist` = 43 стр. = **0.2 МБ** | Свободных страниц почти нет; `VACUUM` вернул бы 0.2 МБ |
| `auto_vacuum` | **2** (incremental) | Уже включён, инкрементальный режим был в строю |
| `sessions cleanup` | `overBudget: false` (0.93 из 10 ГБ) | Retention работал штатно: чистить нечего по бюджету, `freedBytes: 0` |

**Что сработало.** Ветка `62e63075` — 41 752 строки, 186.4 МБ — сжата до 2 000 строк
(`openclaw sessions compact`, отчёт `{"compacted": true, "kept": 2000}`). История
не потеряна: до сжатия транскрипт выгружен в
`/home/node/.openclaw/archive/transcripts-62e63075-before-compact.jsonl.gz`
(29.2 МБ, все 41 752 события).

**Механизм, без которого `df` не сдвинется.** Сжатие освобождает страницы в `freelist`
(238 МБ), а WAL при этом вырастает (4 → 62.8 МБ): в моменте диск стал **хуже**
(565 → 513 МБ). Освобождает только пара `PRAGMA incremental_vacuum` →
`wal_checkpoint(TRUNCATE)`, именно в этом порядке. Итог: база **925 → 687 МБ**,
WAL **0**, `freelist 0`, диск **809 МБ**, `integrity_check: ok`.

**Ложный сигнал, который стоит запомнить.** До чекпойнта `integrity_check` вернул
`fts5: checksum mismatch for table "session_transcript_fts"`. Это был непрочекпойнченный
WAL, а не порча: после `wal_checkpoint(TRUNCATE)` — `ok`, `quick_check` — `ok`.
Читать `integrity_check` на живой базе с большим WAL нельзя.

**Граница достигнутого.** `avail ≥ 1G` (§P0.1 `ROADMAP`) **не достигнут**: 809 МБ.
Остаток — `cache-ttl` **276.9 МБ** (140.6 МБ из них в текущей живой сессии, удалять
из работающей нельзя) и сирота `2afbe09e` **186.4 МБ** без штатной команды удаления
(`sessions delete` адресуется ключом, а не `session_id`). Рычаг по объёму — на хосте.

**Попутно: цифры §2 `MASTER-PLAN` были устаревшими.** Проверено на живом проде:
`totalRewardTar 171.393938`, `totalFeeRewardTar 7.152492`, `totalBlockRewardTar 164.241446`
→ **4.17% / 95.83%** (было записано `4.74% / 95.26%` со знаменателем `150.815632`,
который являлся старым `totalRewardTar`, а не эмиссией). Адресов **97**, не 96.

### Б.70. Срез 11.11.2026 14:0x MSK — `2.28.2`: тег модели менял бакет

**Что было не так.** `GET /p2p/discover?model=qwen2.5-coder:1.5b` отдавал
`found: 0, providers: 0, rejected: []`. Директива владельца называла причиной
разбор `discovery-client.js:119`, но пробник показал иное.

**Форма события снята замером, а не по памяти** (`test/probe-provider-shape.js`,
три живых узла libp2p):

| Что проверялось | Факт |
|---|---|
| поля элемента `providers[]` | `id`, `multiaddrs` |
| `p.peerId` | **отсутствует** |
| `String(p)` | `"[object Object]"` |
| `p.id.toString()` | `12D3KooW…`, тип `Ed25519PeerId`, совпал с предсказанным |

То есть разбор `p?.id?.toString?.()` в `2.28.1` уже верный, и `[object Object]`
на проде давно нет.

**Настоящий дефект — ключ бакета.** `model` уходил в `bucketKey` целиком,
вместе с тегом версии, а воркер объявляет семейство без тега:

| Строка в ключе | CID |
|---|---|
| `qwen2.5-coder:1.5b` | `bafkreievemqwth6jpnwyv555nd3j6x4gnwfhlinmryhlddtlvs6zxilhvu` |
| `qwen2.5-coder` | `bafkreifkuzjpr65n7jpgrfdpebe3dhioqnyzzo66ojguqqmmm46euzi3mi` |

CID не совпадали никогда, поэтому клиент искал в другом бакете при живой DHT,
а `found: 0` читался как «discovery сломан» и уводил диагностику в разбор.

**Что сделано.** `normalizeModelFamily()` снимает только тег после последнего
`:`; соответствие «модель → семейство» не угадывается, потому что в каталоге
`/models` поля `family` нет. `bucketKey()` зовёт её, поэтому воркер
(`provideCids`) и клиент (`findWorkers`) идут одной функцией.

**Ловушки, а не happy path.** `4.0a` — тег не меняет бакет; `4.0b` —
`qwen` ≠ `qwen2.5-coder`, иначе первая проходила бы за счёт склейки всех
семейств в один бакет.

**Доказательство.** `test-discovery-e2e.js` — **14 ✅ / 0 ❌** (было 12).
Второй пробник `probe-search-topology.js`: поиск и с самого сервера (как мост),
и с отдельного клиента (как тест) даёт событие `PROVIDER` и одного провайдера —
топология тоже не при чём.

**Чего это НЕ доказывает.** `found ≥ 1` на проде. На VPS в окружении моста нет
`P2P_MODEL_FAMILIES` (проверено `systemctl show p2p-bridge`), воркеру нечего
объявлять, DHT пуста — это честный `found: 0`. Живой провайдер появляется
только с ПК владельца; без него условие A3 недостижимо в принципе, а не
«пока не починено».

**Попутно (A5).** Живые цифры приведены в четырёх документах:
`INVESTOR-CHECKLIST.md`, `NARRATIVE.md`, `PITCH-DECK.md`, `AUDIT-REALITY.md`
(`804` чека, `97` адресов, `4.17/95.83%`, `171.393938`, оборот `171.784514`,
казна `0.1982`, CWU `754 304 113`). Старых значений в `docs/*.md` и корне
не осталось.

### Б.71. Срез 11.11.2026 14:4x MSK — `2.28.3`: `/health` видит P2P-воркера

**Что было не так.** `/health` отдавал `active_workers: 0` при живом
P2P-воркере: WS-реестр пуст, и снаружи это читалось как «воркеров нет».

**Два факта моста, которые нельзя слить** (директива называла только второй):

| Факт | Поле моста | Смысл |
|---|---|---|
| авторизованные живые каналы | `worker_addresses` | по ним диспетчер доставляет задачу |
| живые записи DHT | `worker_records.live` (`expiresAt > now`) | «объявился», канал мог закрыться |

`active_p2p_workers` считается по **каналам**; записи отдаются рядом
(`p2p_worker_records`), и по паре видно «объявился, но не принимает».

**Режим.** Открытый канал не несёт модель, поэтому `llm_mode: "worker"` по
нему одному вернул бы дефект «воркер без модели». Требуется ещё непустой
`p2p_model_families`; иначе причина `p2p_model_unverified`.

**Новые поля** (`/health`, `/worker/status`, `/summary` — одна форма из
`p2pWorkersFields`): `active_p2p_workers` (`number|null`), `p2p_worker_records`,
`p2p_model_families`, `p2p_transport_known`. `null` — мост не ответил:
«не знаю» отличимо от «ноль воркеров».

**Замер** (локальный прогон, `P2P_BRIDGE_ENABLED=0`):
`/health` и `/worker/status` → `mode=deterministic_fallback`,
`reason=no_workers`, `p2p=null`, `known=false`; `/summary` → `workers=0`,
`p2p=null`. Совпали.

**Ловушки** (`test-dpouw.js` §8.7b): поле существует; тип `number|null`, не
`undefined`; при `p2p_transport_known === false` счётчик обязан быть `null`;
`worker` подкреплён хотя бы одним живым воркером.

**Новый документ.** `docs/STAGE-10-WEBRTC.md` — план транспорта PWA↔воркер
(DataChannel, `werift`, TURN с честной оговоркой, подпись `TaskGrant`, откат на
WS-relay с логом). Статус: план, кода нет.

**Чего не доказывает.** `active_p2p_workers ≥ 1` на проде — нужен запущенный
воркер с `P2P_MODEL_FAMILIES`.

### Б.72. Срез 11.11.2026 15:4x MSK — `2.28.4`: WebRTC-транспорт доказан

**Что появилось.** `p2p-node/webrtc-peer.js` — приёмник на `werift` (чистый JS):
принимает offer, отдаёт answer, держит DataChannel. `p2p-worker.js` получил ветку
`webrtc-offer` в `handleTask`; `scripts/webrtc-test.js` — обёртка, тест живёт в
`p2p-node/test/webrtc-test.js`.

**Почему сигналинг через канал задач.** Отдельного сигнального сервера в проекте
нет, и заводить его ради прототипа значило бы построить ту самую центральную точку,
которую Этап 10 убирает. Канал `task` уже открыт, уже проверен подписанным `hello`
и уже носит произвольный `payload` в обе стороны. Это компромисс прототипа, и в
`docs/STAGE-10-WEBRTC.md` записано, что боевой путь должен обходиться без сервера.

**Три дефекта, найденные прогоном, а не чтением:**

1. **Кадр без `taskId` — сирота.** Мост сопоставляет ответ с ожиданием только по
   `taskId`, а анонимная полоса принимает лишь `pong`. Первый заход вернул
   `TASK_TIMEOUT`, и лог моста сказал причину дословно: «кадр без taskId и не pong
   (webrtc-offer) — сирота». Ответ теперь возвращает `taskId` тем же полем.
2. **`onMessage` в werift — объект-событие, не поле.** Присваивание функции
   (`dc.onMessage = fn`) ломает библиотеку изнутри: «channel.onMessage.execute is
   not a function». Правильно — `dc.onMessage.subscribe(fn)`.
3. **Полей `onOpen`/`onClose` в werift нет.** Обращение к ним даёт `undefined` без
   ошибки — тихое «событие не наступило», которое выглядит как «канал не открылся».
   Верный путь — `stateChange.subscribe`.

Первые два дефекта жили на стороне, которую тест считал проверенной: транспорт
(доказан отдельным пробником `test/webrtc-probe.js`) и API библиотеки.

**Почему answer уходит раньше открытия канала.** Первая версия ждала
`ondatachannel` до возврата answer — и не могла дождаться никогда: канал на
принимающей стороне поднимается по DTLS, а DTLS начинается после того, как
инициатор применил answer. Циклическая зависимость выглядела как «WebRTC не
поднимается за 10 секунд».

**Доказательство** (`node scripts/webrtc-test.js`, rc 0):

```
✅ offer принят воркером: via=p2p
✅ answer получен: sdp 685 байт
✅ ICE собран на воркере: candidates_gathered=true
✅ DataChannel открыт: readyState=open
✅ ответ пришёл по каналу: получено "pong:ping-…"
```

**Чего это НЕ доказывает.** Работу через NAT: только host-кандидаты, `iceServers:
[]`. За симметричным NAT нужен TURN, а TURN — это сервер; план это признаёт.
Подписи `TaskGrant` в прототипе нет. PWA (`app/app.js`) не тронут намеренно.

**check-autostart.** Добавлен `--p2p`: критерий считается по `active_p2p_workers`,
`contacts ≥ 1` — в обоих режимах. Причина: воркер с `--test-p2p` держит libp2p-канал
и в WS-реестр может не попасть, и исправный автозапуск был бы назван проваленным.

### Б.73. Срез 11.11.2026 20:0x MSK — A3 закрыт: клиент нашёл воркера сам

**Что доказано.** Владелец запустил воркер на своём ПК, и обе стороны сошлись
на живом проде. Это то, чего не хватало после `2.28.1`–`2.28.2`: там разбор и
ключ бакета были починены, но `found: 0` оставался честным «в сети никого».

```json
GET /p2p/discover?model=qwen2.5-coder:1.5b
{"found":1,"providers":1,"rejected":[],"elapsed_ms":166,
 "workers":[{"peerId":"12D3KooWLBV8uzCxa7Nz…",
             "multiaddrs":["/ip4/45.144.49.113/tcp/37628/p2p/12D3KooWLBV8uzCxa7Nz…"]}]}

GET /health
{"active_workers":1,"active_p2p_workers":1,"llm_mode":"worker",
 "p2p_model_families":["qwen2.5-coder"]}
```

`rejected: []` при `found: 1` — важно: пустой `rejected` и раньше значил «записи
не было вообще», а не «записи отвергнуты». Теперь запись есть и она принята.

**Оговорка, без которой срез читался бы шире факта.** В `multiaddrs` стоит
`45.144.49.113` — публичный адрес **VPN** на ПК владельца, а не домашнего
роутера. Доказан сценарий «есть публичный IP»; у обычного домашнего
пользователя провайдер часто прячет за CGNAT, и там соединение пойдёт через
relay-мост либо не пойдёт без TURN. Поэтому A3 закрыт как «discovery находит
воркера», и **не** закрыт как «P2P работает у любого пользователя».

**Что осталось от этапа 10.** P1.2 (ребут-тест) теперь впервые осмыслен: до
A3 код `1` означал и «автозапуск сломан», и «P2P не настроен». WebRTC-прототип
и `--p2p` в `check-autostart` закрыты в `2.28.4` (§Б.72). Впереди — WebRTC в
PWA и отказ от `POST /inference`; порядок и критерии — в
`docs/STAGE-10-CHECKLIST.md` (2 из 5 пунктов закрыты).

**Чего этот срез не утверждает.** Что воркер постоянно в сети (он запущен
руками, ребут-тест не проведён), что сеть состоит из многих операторов, и что
за симметричным NAT что-то поднимется без TURN.
