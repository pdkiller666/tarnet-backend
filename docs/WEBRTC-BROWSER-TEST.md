# WEBRTC-BROWSER-TEST — живой прогон Stage 10 в браузере

**Зачем этот файл.** В контейнере, где гоняется `verify.sh`, браузера нет
(`No supported browser found`). Поэтому клиент `app/webrtc-client.js` проверен
синтаксисом и статическими проверками 63.14–63.19, а **живое соединение не
доказано**. Этот файл — процедура, которая закрывает пункт 4 чеклиста
`docs/STAGE-10-CHECKLIST.md`, а не заменяет его.

**Что считается доказательством:** `connect()` вернул `ok: true`, `transport:
'webrtc'`, и по открытому `DataChannel` прошёл ответ на пробное сообщение.
Остальное (answer получен, «сервер сказал ok») доказательством не является —
это ровно то, что уже доказано на серверной стороне в `2.28.4`.

---

## 0. Предусловия

| # | Что | Как проверить | Если нет |
|---|---|---|---|
| 1 | Прод доступен | `curl -s $BASE/health \| head -c 80` | из РФ нужен VPN: `tarnet.pro` не резолвится, прод на поддомене `hosted-by-vdsina.com` |
| 2 | Воркер запущен с P2P | `/health` → `active_p2p_workers: 1` | `node worker-demo.js --p2p` на ПК владельца |
| 3 | Воркер объявил модель | `/p2p/discover?model=<family>` → `found ≥ 1` | проверить `--model` в запуске воркера |
| 4 | Браузер с WebRTC | в консоли `typeof RTCPeerConnection` | Chrome/Edge/Firefox/Safari 15+ |

**Порядок обязателен.** Без пункта 2 шаг 3 даст `found: 0`, и это будет
выглядеть как «клиент сломан», хотя проверять было нечего.

```bash
BASE=https://v1107336.hosted-by-vdsina.com
curl -s $BASE/health | node -pe 'const j=JSON.parse(require("fs").readFileSync(0));`workers=${j.active_p2p_workers} build=${j.buildVersion}`'
curl -s "$BASE/p2p/discover?model=qwen2.5-coder:1.5b" | node -pe 'JSON.parse(require("fs").readFileSync(0)).found'
```

---

## 1. Автоматическая часть — снаружи, без браузера

Сначала прогоните `scripts/check-webrtc.js`. Он проверяет сигнальный путь
целиком, кроме самого соединения: `offer → DHT → воркер → answer`.

```bash
node scripts/check-webrtc.js --base $BASE --verbose
```

| Код | Значение | Что делать |
|---|---|---|
| `0` | answer получен | переходить к шагу 2 |
| `1` | сервер отказал | смотреть `error`/`detail` в логе; это не сеть |
| `2` | мост/libp2p не поднят | чинить мост, браузер тут не поможет |
| `3` | воркера нет в DHT | запустить воркер (пункт 2 выше) |
| `4` | сервер недоступен | сеть/VPN/DNS |

`3` — **не провал клиента**. Это «проверять нечего».

---

## 2. Ручная часть — в браузере

### 2.1. Открыть PWA

`$BASE/app/` → `F12` → вкладка **Console**.

Проверьте, что клиент загружен (он подключён в `app/index.html` и в
предзагрузке `app/sw.js`, CACHE `tarnet-app-v43`):

```js
typeof window.TarNetWebRTC            // "object"
window.TarNetWebRTC.isSupported()     // true
window.TarNetWebRTC.CONST             // { CHANNEL_LABEL:"task", ICE_GATHER_TIMEOUT_MS:5000, ... }
```

Если `undefined` — обновите страницу с `Ctrl+Shift+R` (старый service worker
мог отдать кэш до `v43`).

### 2.2. Найти воркера

```js
await window.TarNetWebRTC.discover('qwen2.5-coder:1.5b')
```

Ожидается `{ ok: true, workers: [...] }`, в записи — поле **`workerAddress`**
(не `address`). Если `workers: []` — воркер не объявлен, возвращайтесь к пункту 0.

### 2.3. Соединиться

```js
const r = await window.TarNetWebRTC.connect({
  model: 'qwen2.5-coder:1.5b',
  onState: (s) => console.log('[state]', s),
  onMessage: (m) => console.log('[msg]', m),
});
r.ok            // должно быть true
r.transport     // "webrtc"
r.candidatesGathered  // true = ICE собран полностью
```

**Что должно появиться в консоли по порядку:**

1. `[state] { connection: 'connecting', channel: 'connecting' }`
2. `[state] { connection: 'connected', channel: 'open' }`
3. `r.ok === true`, `r.transport === 'webrtc'`

**Проверка, что канал реально живой** (а не только `ok: true`):

```js
r.session.state()                 // { connection:'connected', channel:'open' }
r.session.send({ type:'ping' })   // { ok: true }
```

Ответ придёт в `onMessage`. Если `send` вернул `CHANNEL_CLOSED` — канал
закрылся после открытия, и это отдельный дефект, а не «не доказано».

### 2.4. Отправка задачи

Задача идёт тем же каналом, что `ping`. Форма кадра — контракт воркера
(`docs/STAGE-10-WEBRTC.md`), здесь он не дублируется.

---

## 3. Как читать отказы

Клиент **не молчит** при отказе: он печатает строку
`[transport] WebRTC failed, using WS relay` с причиной в скобках. Это
константа `FALLBACK_LOG`, она же под проверкой 63.16.

| `error` | Что значит | Куда смотреть |
|---|---|---|
| `WEBRTC_UNSUPPORTED` | в браузере нет `RTCPeerConnection` | не тот браузер / отключён WebRTC |
| `NO_WORKER_FOUND` | DHT не дала воркера | воркер не объявил модель |
| `OFFER_TOO_LARGE` | SDP больше 100000 | аномалия: столько кандидатов не бывает |
| `PEER_NO_CHANNEL` | пир известен, канал задач не открыт | воркер поднят, но не в канале `task` |
| `NO_TASK_CHANNEL` / `BRIDGE_UNREACHABLE` (503) | мост не отвечает | инфраструктура, не клиент |
| `CHANNEL_NOT_OPEN` | answer есть, канал не встал | **самый обманчивый**: сервер «ok», данных нет. Смотреть `r.detail`: `readyState`, `ice` |
| `WEBRTC_FAILED` | исключение на пути | `r.detail` — имя и текст ошибки |

**Симметричный NAT — не дефект клиента.** Клиент использует только STUN
(`stun:stun.l.google.com:19302`), TURN намеренно не подключён: TURN — это
сервер, а этап убирает сервер из типового пути. При симметричном NAT
соединение не встанет, и это ожидаемое поведение с явным откатом.

---

## 4. Что прислать, если не работает

1. Вывод `node scripts/check-webrtc.js --base $BASE --verbose` (код возврата
   важен: `3` и `2` — не дефект клиента).
2. Всю консоль браузера от `connect()` до ошибки, включая `[state]` строки.
3. `r.detail` и `r.error` из возвращённого объекта.
4. `/health` → `active_p2p_workers`, и `discover` → `found`.

Без пункта 1 разговор скатывается к угадыванию: неизвестно, был ли воркер.

---

## 5. Что после успешного прогона

- `docs/STAGE-10-CHECKLIST.md` — пункт 4 переводится из «начат» в «закрыт»
  **с датой и выводом**, как закрывались предыдущие пункты.
- `MASTER-PLAN.md` — Этап 10: снять оговорку «в контейнере гейта браузера нет».
- `ROADMAP.md` — P1.2b/P1.2c: убрать «ждёт ПК владельца», если прогон был на нём.

**Чего этот прогон не закроет:** подпись `TaskGrant` ключом Ed25519 из
IndexedDB с проверкой через `peer-auth.js` — это отдельная работа, и она
остаётся открытой независимо от исхода.
