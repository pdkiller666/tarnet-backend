'use strict';
/* p2p-demo.js — демонстрационная сеть P2P для стенда.
 *
 * Поднимает в одном процессе три узла: два реле и воркера. Пакет реально
 * идёт по WebSocket от клиента через реле 1 → реле 2 → воркер и обратно.
 * Это не имитация: те же классы, что в приёмке test-mesh.js.
 *
 * Зачем в процессе сервера, а не отдельными сервисами: стенд живёт в одном
 * контейнере с ограниченным диском и без systemd-юнитов на каждый узел.
 * Сеть поднимается на loopback и не выходит наружу.
 *
 * ПРИВАТНЫЕ КЛЮЧИ демо-узлов живут только в памяти процесса. В БД попадают
 * лишь публичные: эндпоинт собирает луковицу по ним, а снять слой может
 * только владелец ключа — то есть этот же процесс.
 */

const crypto = require('crypto');
const onion = require('./onion');
const { Transport } = require('./p2p-transport');

/* Порты демо-меша. Если заняты — берём любой свободный: важна работающая
 * цепь, а не конкретный номер. Фактические порты возвращаются в descriptor.
 *
 * ПОЧЕМУ НЕ 4001/4002 (исправлено 09.11). 4001 — это порт настоящего
 * libp2p-моста (`p2p-node/bridge.js`, `P2P_PORT`), и он открыт наружу в ufw.
 * Демо-меш стартует из server.js раньше моста и занимал 4001 первым, поэтому
 * мост падал с `EADDRINUSE 0.0.0.0:4001` и уходил в цикл рестартов
 * (restart counter 28). Ошибка была не видна, пока `npm ci` для p2p-node не
 * ставил зависимости: падение на импорте `@libp2p/gossipsub` маскировало
 * конфликт портов. Демо-стенду номер не важен — уводим его с боевого порта. */
const PREFERRED_PORTS = { relay1: 4101, relay2: 4102 };

/* Адреса детерминированы: тест и PWA могут собрать маршрут, не спрашивая
 * список. Это не секрет — адрес и так виден в /nodes. */
function demoAddress(role) {
  const h = crypto.createHash('sha256').update(`tarnet-demo:${role}`).digest('hex');
  return '0x' + h.slice(0, 40);
}

const ROLES = ['relay1', 'relay2', 'worker'];

/* start() у транспорта бросает, если порт занят. Пробуем желаемый, затем
 * любой свободный — но только один раз: тихо менять порт дважды незачем. */
async function listenTransport(opts, preferredPort) {
  if (preferredPort) {
    try {
      return await new Transport({ ...opts, listenPort: preferredPort }).start();
    } catch (_e) { /* порт занят — уходим на свободный */ }
  }
  return new Transport({ ...opts, listenPort: 0 }).start();
}

/**
 * @param {object}   opts
 * @param {Function} opts.handler  async (innerRequest) => string; чем воркер
 *                                 отвечает. Обязателен: без него узел не
 *                                 может быть концом маршрута.
 * @returns {Promise<object>} дескриптор с узлами, клиентом и stop().
 */
async function startDemoMesh({ handler } = {}) {
  if (typeof handler !== 'function') throw new Error('P2P_DEMO_HANDLER_REQUIRED');

  const keys = {};
  for (const role of ROLES) keys[role] = onion.generateNodeRsaKeypair();

  /* Порядок жёсткий: каждый узел при старте получает URL следующего, а свой
   * порт узнаёт только после listen. Обратный порядок дал бы undefined. */
  const worker = await listenTransport({
    address: demoAddress('worker'),
    keypair: keys.worker,
    workerHandler: handler,
  }, 0);

  const relay2 = await listenTransport({
    address: demoAddress('relay2'),
    keypair: keys.relay2,
    peers: { [demoAddress('worker')]: { url: worker.url } },
  }, PREFERRED_PORTS.relay2);

  const relay1 = await listenTransport({
    address: demoAddress('relay1'),
    keypair: keys.relay1,
    peers: { [demoAddress('relay2')]: { url: relay2.url } },
  }, PREFERRED_PORTS.relay1);

  /* Клиент — тоже узел: у него есть ключи, но он никогда не снимает слои.
   * Пиры включают оба реле, чтобы маршрут можно было начать с любого. */
  const client = await new Transport({
    address: demoAddress('client'),
    keypair: onion.generateNodeRsaKeypair(),
    peers: {
      [demoAddress('relay1')]: { url: relay1.url },
      [demoAddress('relay2')]: { url: relay2.url },
    },
    listenPort: 0,
  }).start();

  const nodes = [
    { role: 'relay1', address: demoAddress('relay1'), url: relay1.url, publicKeyPem: keys.relay1.publicKeyPem, transport: relay1 },
    { role: 'relay2', address: demoAddress('relay2'), url: relay2.url, publicKeyPem: keys.relay2.publicKeyPem, transport: relay2 },
    { role: 'worker', address: demoAddress('worker'), url: worker.url, publicKeyPem: keys.worker.publicKeyPem, transport: worker },
  ];

  const stop = async () => {
    /* client первым: он держит исходящие сокеты к реле, и если закрыть реле
     * раньше, клиент увидит разрыв и напишет в лог лишнее. */
    await client.stop().catch(() => {});
    await relay1.stop().catch(() => {});
    await relay2.stop().catch(() => {});
    await worker.stop().catch(() => {});
  };

  return { nodes, client, relay1, relay2, worker, stop };
}

/* Срез состояния без содержимого пакетов: только счётчики. Нужен тесту и
 * диагностике, чтобы доказать, что реле не были концом маршрута. */
function describeMesh(mesh) {
  return {
    nodes: mesh.nodes.map((n) => ({
      role: n.role,
      address: n.address,
      /* url — адрес, по которому узел СОЕДИНЯЕТСЯ внутри процесса. При bind
       * на 0.0.0.0 это loopback: подключиться к 0.0.0.0 нельзя. */
      url: n.url,
      /* publicUrl — что узел анонсирует наружу. Раньше это поле жило только
       * в transport и не доходило до describeMesh: /p2p/status собирал его
       * сам из n.transport.publicUrl, а клиент describeMesh (тесты, p2p-demo)
       * видел только loopback-url и не мог отличить стенд от реальной сети. */
      publicUrl: n.transport?.publicUrl ?? n.url,
      stats: { ...n.transport.stats },
    })),
    client: { address: mesh.client.address, stats: { ...mesh.client.stats } },
  };
}

module.exports = { startDemoMesh, describeMesh, demoAddress, ROLES, PREFERRED_PORTS };
