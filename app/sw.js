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
 * и «новая версия не появилась» выглядело бы как ошибка выкладки. */
const CACHE = 'tarnet-app-v3';

const ASSETS = [
  '/app/',
  '/app/index.html',
  '/app/styles.css',
  '/app/app.js',
  '/app/agents.js',
  '/app/icon.svg',
  '/app/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      /* addAll падает целиком, если хотя бы один файл не 200. Кэшируем
       * поштучно: один недоступный ассет не должен ломать установку SW. */
      .then((cache) => Promise.all(
        ASSETS.map((url) => cache.add(url).catch(() => null)),
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
