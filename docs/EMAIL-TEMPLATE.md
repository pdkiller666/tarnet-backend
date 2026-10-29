# EMAIL-TEMPLATE.md — письмо инвестору (RU + EN)

**Правило:** цифры в письме — из атомарного среза 29.10.2026 09:03 MSK, сборка `2.15.1-treasury-cashback`. Всё, что здесь написано, проверяется двумя запросами до ответа. Если цифра изменилась — править здесь, а не «на глаз» в письме.

**Кому:** pre-seed фонды и бизнес-ангелы, кому интересен инфраструктурный слой AI.
**Чего в письме нет и не должно быть:** слова «децентрализованная сеть» без оговорки, «работает под нагрузкой», «партнёры», «лидеры рынка».

---

## RU

**Тема:** Pre-Seed: 933 теста, живой /health, 18 моделей

Здравствуйте, {Имя}.

Я строю TarNet / Synapse — протокол распределённого LLM-инференса с независимым реестром выполненной работы (dPoUW). Владелец устройства выполняет запрос и получает `$TAR`; протокол фиксирует работу так, что сумму по всем балансам можно пересчитать из двух публичных endpoint'ов. Промпты не хранятся на сервере.

Состояние на сегодня проверяется без моего участия. `GET https://v1107336.hosted-by-vdsina.com/health` отдаёт `buildVersion: 2.15.1-treasury-cashback` и инвариант сохранения с нулевым расхождением: `delta: 0`, `holds: true`. `GET /summary` даёт 731 чек работы на 84 адресах, выплачено 72.119989 TAR, оборот леджера 72.503515 TAR. Арифметика сходится ровно: выплаты + сожжённое + казна + роялти = оборот, до шестого знака. Приёмка — 933 автотеста, 0 падений, одной командой. Каталог моделей — 18, из них 15 облачных у 8 провайдеров и 3 локальные; сквозной вызов с живым ключом провайдера пройден, кэшбэк начислен отдельной строкой леджера.

Чего нет, чтобы вы не искали это сами. Живой исполнитель не работает постоянно: окно жизни воркера — 60 секунд, на момент этого письма `active_workers: 0` и инференс идёт заглушкой. Все адреса в реестре локальные и не объявлены публично. Расчёты on-chain симулированы, Solidity-контрактов в репозитории ноль. Казна на `critical`: `0.193075` TAR при операционных расходах $517 в месяц. Tier 6 проверен шестью вызовами, а не потоком. Всё это в `docs/AUDIT-REALITY.md`. Отдельно про казну: раньше баланс был больше начисленного и я не знал почему. Причину нашёл и разложил на два слагаемых (чек, где воркером записана сама казна; `treasuryTar` из Tier 6, не входящий в `totalTreasuryTar`). Третье слагаемое оказалось не расходом, а дефектом учёта: кэшбэк записывался как списание с казны, хотя деньги с неё не уходили. Исправил и запись, и историю, и формулу. В `/summary` теперь есть блок `treasuryAudit` с `holds: true`, который это проверяет — именно он и поймал дефект в первые минуты после выкатки.

Ищу $150K pre-seed за 5–10% токенов. Деньги идут на три вещи, которые нельзя сделать кодом в одиночку: подключить 10+ внешних исполнителей и получить первый рыночный сигнал, собрать комитет валидаторов (нужно 50 TAR стейка), оплатить GPU-обучение адаптеров. Через шесть месяцев это должно превратить «протокол, которому нужна сеть» в «сеть с работающим спросом». Если проверяемая часть вам интересна — предложу 30 минут и покажу пересчёт инварианта вживую, с телефона.

{Подпись}

---

## EN

**Subject:** Pre-Seed: 933 tests, a live /health, 18 models

Hello {Name},

I'm building TarNet / Synapse — a protocol for distributed LLM inference with an independent proof-of-useful-work ledger (dPoUW). A device owner runs a request and earns `$TAR`; the protocol records the work so that the sum across all balances can be recomputed from two public endpoints. Prompts are never stored on the server.

You can check today's state without me. `GET https://v1107336.hosted-vdsina.com/health` returns `buildVersion: 2.15.1-treasury-cashback` and a conservation invariant with zero discrepancy: `delta: 0`, `holds: true`. `GET /summary` returns 731 work receipts across 84 addresses, 72.119989 TAR paid to workers, 72.503515 TAR of ledger turnover. The arithmetic closes exactly: payouts + burned + treasury + royalties equals turnover to the sixth decimal. Acceptance is 933 automated assertions, 0 failures, one command. The model catalog holds 18 entries — 15 cloud models across 8 providers and 3 local; an end-to-end call with a real provider key has completed, with the cashback written as its own ledger row.

What is not there, so you don't have to dig for it. No worker runs continuously: the liveness window is 60 seconds, and at the time of writing `active_workers: 0` with inference falling back to a stub. All addresses in the registry are local and none are publicly announced. On-chain settlement is simulated; there are zero Solidity contracts in the repository. The treasury is `critical`: `0.193075` TAR against $517/month of operating cost. Tier 6 has been exercised by six calls, not by load. All of this is in `docs/AUDIT-REALITY.md`. On the treasury specifically: the balance used to exceed what was accrued and I did not know why. I found the cause and split it into two components (a receipt where the treasury itself is recorded as the worker; `treasuryTar` from Tier 6, which is not part of `totalTreasuryTar`). A third component turned out to be not a cost but an accounting defect: cashback was recorded as a debit from the treasury even though no money left it. I fixed the writer, the history, and the formula. `/summary` now exposes a `treasuryAudit` block with `holds: true` that verifies it — that block is what caught the defect within minutes of release.

I'm raising $150K pre-seed for 5–10% of tokens. The money goes to three things code alone cannot do: connect 10+ external executors and get a first market signal, stand up the validator committee (requires 50 TAR of stake), and pay for GPU training of adapters. In six months that should turn "a working protocol that needs a network" into "a network with real demand". If the verifiable part interests you, I'll take 30 minutes and recompute the invariant live, from a phone.

{Signature}

---

## Пометки для правки

- **Тема письма фиксирована:** «Pre-Seed: 933 теста, живой /health, 18 моделей». Менять только вместе с цифрами.
- **Не убирать абзац «Чего нет».** Он и есть причина, по которой письмо читают до конца: инвестор всё равно найдёт это на due diligence, но уже с потерянным доверием.
- **Не писать «децентрализованная сеть»** без оговорки, что исполнитель один и он локальный. Правильная формулировка — «протокол, которому нужна сеть».
- **Не обещать on-chain, TEE или комитет как существующие.** `simulated: true`, поле `isTeeAttested` в БД, комитета нет.
- **Цифры брать из одного среза.** Если правишь одно число — перепроверь инвариант целиком, иначе письмо перестанет сходиться с `/summary`.
- **Персональные данные:** `{Имя}`, `{Подпись}` — заполнять перед отправкой, не оставлять плейсхолдеры.
