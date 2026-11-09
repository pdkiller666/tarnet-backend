'use strict';
/* Сборка ZIP с p2p-node для установщика (2.22.7).
 *
 * ЗАЧЕМ. Флаг `--p2p` (2.22.6) работает только в клоне репозитория:
 * `findP2pWorker()` ищет `p2p-node/p2p-worker.js` рядом с воркером, в
 * `%LOCALAPPDATA%\TarNet` его нет, и транспорт молча не поднимается. Симптом
 * тот же, что мы уже проходили с `--p2p` без второго окна: воркер жив, `ws
 * активен`, мост показывает `connections: 0`. Поэтому установщик обязан
 * привозить p2p-node с собой, а не надеяться на клон.
 *
 * ПОЧЕМУ СВОЙ ZIP, А НЕ `archiver`. На VPS не установлен даже `zip` CLI, а
 * `archiver` — новая зависимость в прод-образе ради одной задачи. `node:zlib`
 * умеет `deflateRawSync`, остаётся склеить три структуры (local header,
 * central directory, EOCD) — это ~80 строк, зато ноль новых пакетов.
 *
 * ПОЧЕМУ CRC32 СВОЙ. `zlib.crc32` появился только в Node 22.2. Сервер
 * объявляет `engines: >=22`, но провайдер VPS мог поставить 22.1 — тогда
 * CRC считался бы как `undefined` и архив был бы битым на распаковке у
 * человека. Таблица на 256 значений дешевле, чем зависимость от минорной
 * версии рантайма.
 *
 * ЧТО ВНУТРИ. Только исходники и манифесты p2p-node: `*.js`, `package.json`,
 * `package-lock.json`. НЕТ `node_modules` (105 МБ, 11 464 файла, в архиве
 * 18.4 МБ — на установщике это лишние мегабайты, тогда как npm на машине
 * пользователя ставит те же пакеты из локального кеша и по lock-файлу) и
 * НЕТ `data/` (там приватный ключ узла `peer-id.bin` — попадание в архив
 * раздало бы личность узла каждому, кто скачал установщик).
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const P2P_DIR = path.join(__dirname, 'p2p-node');

/* Явный список, а не `readdir`. Новый файл в p2p-node не должен уезжать
 * людям автоматически: `data/` с ключом узла лежит в той же папке, и
 * «положить всё» означало бы раздать приватный ключ. Тест 54.3 сверяет
 * список с фактическим набором исходников, чтобы забытый файл ловился
 * здесь, а не отказом `ERR_MODULE_NOT_FOUND` на машине пользователя. */
const BUNDLED_FILES = [
  'bridge.js',
  'discovery-client.js',
  'gossip-announce.js',
  'index.js',
  'p2p-worker.js',
  'peer-auth.js',
  'peer-hello.js',
  'peer-id-store.js',
  'public-addr.js',
  'task-protocol.js',
  'worker-record.js',
  'package.json',
  'package-lock.json',
];

/* ---------- CRC32 ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/* ---------- DOS время ----------
 * ZIP хранит время в двух 16-битных полях с 1980 года. Нулевое время
 * допустимо, но тогда распаковщики показывают 1979-11-30, и «архив свежий
 * или нет» глазами не проверить. Берём mtime файла. */
function dosDateTime(date) {
  const d = date instanceof Date && !isNaN(date) ? date : new Date();
  const year = Math.max(1980, d.getFullYear());
  return {
    time: ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1f),
    date: (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f),
  };
}

/* ---------- запись ZIP ----------
 * deflate + method 8. `stored` (method 0) тоже валиден, но архив исходников
 * без сжатия — это ~110 КБ вместо ~25 КБ на каждый запрос установщика.
 *
 * Флаг UTF-8 (general purpose bit 11) ставим всегда: имена здесь латиница,
 * но флаг избавляет от кодировочных догадок у распаковщика. */
function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const compressed = zlib.deflateRawSync(entry.data, { level: 6 });
    /* Если сжатие не уменьшило — кладём как есть: иначе на почти-random
     * данных архив рос бы, а распаковщик всё равно потратил бы время. */
    const useDeflate = compressed.length < entry.data.length;
    const body = useDeflate ? compressed : entry.data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(entry.data);
    const { time, date } = dosDateTime(entry.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);  // signature
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // flags: UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);       // compressed
    local.writeUInt32LE(entry.data.length, 22); // uncompressed
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);          // extra len

    chunks.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);             // version made by
    cd.writeUInt16LE(20, 6);             // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(entry.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);             // extra
    cd.writeUInt16LE(0, 32);             // comment
    cd.writeUInt16LE(0, 34);             // disk
    cd.writeUInt16LE(0, 36);             // internal attrs
    cd.writeUInt32LE(0, 38);             // external attrs
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, eocd]);
}

/* ---------- сборка архива p2p-node ----------
 * Возвращает буфер и список файлов. Отсутствующий файл из списка — не
 * «пропустить и поехать дальше»: распаковка без `p2p-worker.js` дала бы
 * `ERR_MODULE_NOT_FOUND` только у человека на машине. Ошибка называется
 * здесь. */
function buildP2pArchive() {
  const missing = [];
  const entries = [];
  let newest = 0;

  for (const name of BUNDLED_FILES) {
    const file = path.join(P2P_DIR, name);
    if (!fs.existsSync(file)) { missing.push(name); continue; }
    const stat = fs.statSync(file);
    newest = Math.max(newest, stat.mtimeMs);
    entries.push({
      /* Префикс `p2p-node/` внутри архива: распаковка в папку воркера
       * кладёт файлы ровно туда, где `findP2pWorker()` их ищет
       * (`<папка воркера>/p2p-node/p2p-worker.js`). Без префикса файлы
       * рассыпались бы рядом с `tarnet-worker.js`. */
      name: 'p2p-node/' + name,
      data: fs.readFileSync(file),
      mtime: stat.mtime,
    });
  }

  if (missing.length) {
    const err = new Error('в p2p-node нет файлов: ' + missing.join(', '));
    err.missing = missing;
    throw err;
  }

  return { buffer: buildZip(entries), files: BUNDLED_FILES.slice(), newest, bytes: entries.reduce((n, e) => n + e.data.length, 0) };
}

/* ---------- кэш ----------
 * Архив собирается из 10 файлов на каждый запрос установщика. Это дешево
 * (110 КБ чтения), но сборка zip — CPU, а установщик могут дёрнуть 10 раз
 * подряд из-за повторного скачивания. Кеш по самому свежему mtime
 * исходников: правка любого файла инвалидирует его автоматически, а
 * «положить архив в dist/» потребовало бы помнить о пересборке — ровно
 * та ошибка, из-за которой раздавался протухший воркер. */
let cache = null;

function getP2pArchive() {
  const parts = BUNDLED_FILES.map((n) => {
    try { return fs.statSync(path.join(P2P_DIR, n)).mtimeMs; } catch { return -1; }
  });
  const stamp = Math.max(...parts);
  if (cache && cache.stamp === stamp && stamp > 0) return cache;

  const built = buildP2pArchive();
  cache = { ...built, stamp };
  return cache;
}

module.exports = { buildP2pArchive, getP2pArchive, buildZip, crc32, BUNDLED_FILES, P2P_DIR };
