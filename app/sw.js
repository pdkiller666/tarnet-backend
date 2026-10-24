/* TarNet / Synapse — service worker.
 *
 * Задача ровно одна: приложение открывается без сети и не теряет оболочку.
 * API намеренно НЕ кэшируется: /inference и /health — живые данные, и
 * подсунуть вчерашний ответ как сегодняшний было бы обманом, а не офлайном.
 *
 * Версия в имени кэша: при выкладке новой версии файлы подтягиваются заново,
 * а старый кэш удаляется в activate. Без смены CACHE старая оболочка жила бы
 * вечно — classic stale-shell.
 */
/* v3: добавлен agents.js. Версию поднимаем обязательно — при том же имени
 * кэша браузер продолжил бы отдавать старую оболочку без вкладки «Агенты»,
 * и «новая версия не появилась» выглядело бы как ошибка выкладки.
 *
 * v4: починен [hidden] в styles.css. Без смены версии фикс не дошёл бы до
 * уже установленных PWA: они отдавали бы старый CSS из кэша, и Илья снова
 * увидел бы «переключаю вкладки — ничего не меняется» уже после выкладки.
 * Это ровно тот случай, ради которого здесь стоит версия.
 *
 * v5: предзагрузка ассетов больше не читает HTTP-кэш (см. install ниже).
 * v4 ставился через add() из Cache API, и в него мог лечь старый CSS: версия
 * кэша поднята, а байты — прежние. Имя меняем ещё раз, чтобы v5 собрался
 * с нуля уже правильным способом, без остатков v4. */
const CACHE = 'tarnet-app-v6';

const ASSETS = [
  '/app/',
  '/app/index.html',
  '/app/styles.css',
  '/app/app.js',
  '/app/agents.js',
  '/app/icon.svg',
  '/app/manifest.webmanifest',
  /* Вендорные библиотеки входят в предзагрузку: без них офлайн-режим
   * отрисовал бы ответ как простой текст, а страница запросила бы
   * отсутствующие файлы и мигала ошибкой в консоли. */
  '/app/vendor/marked.min.js',
  '/app/vendor/highlight.min.js',
  '/app/vendor/hljs-theme.css',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      /* Почему не add() из Cache API: он делает обычный fetch и УВАЖАЕТ
       * HTTP-кэш браузера. Ассеты /app/ отдаются с max-age, поэтому в новый
       * кэш мог лечь старый файл из HTTP-кэша — и тогда поднятая версия
       * CACHE ничего не чинит: в ней оказывается тот же старый CSS.
       * cache: 'reload' идёт в сеть мимо кэша, а cache.put кладёт свежий
       * ответ. Так «новая версия» значит действительно новые байты.
       *
       * Поштучно, а не addAll: один недоступный ассет не должен ломать
       * установку воркера целиком. */
      .then((cache) => Promise.all(
        ASSETS.map((url) => fetch(url, { cache: 'reload' })
          .then((res) => (res && res.ok ? cache.put(url, res) : null))
          .catch(() => null)),
      ))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  /* Только GET и только своя статика. POST /inference, /health, /balance
   * и всё остальное идёт в сеть напрямую — иначе офлайн-кэш начнёт
   * отвечать за сервер. */
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith('/app/')) return;

  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match('/app/index.html'));
    }),
  );
});
