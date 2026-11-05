/**
 * peer-id-store.js — постоянная идентичность libp2p-узла.
 *
 * ЗАЧЕМ. `createLibp2p()` без аргумента `privateKey` генерирует новую пару
 * ключей при каждом старте. Peer ID получается новый, и узел для сети
 * каждый раз другой: соседи, запомнившие адрес, не найдут нас после
 * рестарта, а DHT-записи указывают в пустоту. Идентичность узла — это
 * ровно ключ на диске, и ничего больше.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ ФАЙЛ. Логику «прочитать или создать» надо проверить
 * без запуска сети: сам libp2p тянет 105 МБ и открывает порт. Модуль
 * принимает пути и возвращает ключ, а тест проверяет его обычным node.
 *
 * ФОРМАТ НА ДИСКЕ — protobuf-сериализация приватного ключа (тот же
 * marshal, которым libp2p обменивается в handshake). Не самодельный JSON:
 * приватный ключ Ed25519 — это 32 байта, а не текст, и «сохранить как hex»
 * значило бы придумать формат, который потом придётся поддерживать.
 *
 * ПРАВА 0600. Ключ даёт право говорить от имени узла. Файл с правами 0644
 * в каталоге репозитория — это утечка идентичности при любом `git add`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { privateKeyToProtobuf, privateKeyFromProtobuf, generateKeyPair } from '@libp2p/crypto/keys'

/** Имя файла по умолчанию внутри data-каталога. */
const KEY_FILE = 'peer-id.bin'

/**
 * Читает ключ из файла или создаёт новый.
 *
 * Возвращает `{ privateKey, created, path }`, где `created` отвечает на
 * вопрос «это первый запуск» — по нему мост пишет в лог, создана
 * идентичность или переиспользована. Молча подменять одно другим нельзя:
 * именно по этой строке видно, почему у узла сменился Peer ID.
 *
 * @param {{dataDir: string, log?: (msg: string) => void}} opts
 */
export async function loadOrCreatePeerId ({ dataDir, log = () => {} }) {
  if (!dataDir) throw new Error('loadOrCreatePeerId: не задан dataDir')
  const file = path.join(dataDir, KEY_FILE)

  if (fs.existsSync(file)) {
    const buf = fs.readFileSync(file)
    /* Битый файл — не повод молча выдать новый ключ. Молчаливая замена
     * означала бы «узел сменил идентичность», и искать причину пришлось бы
     * в сети, а не в файле. Пусть старт падает с внятной причиной: тогда
     * решение удалить файл принимает человек. */
    if (buf.length === 0) {
      throw new Error(`ключ узла пуст: ${file} — удалите файл, чтобы создать новую идентичность`)
    }
    const privateKey = await privateKeyFromProtobuf(buf)
    return { privateKey, created: false, path: file }
  }

  // Каталог создаём до генерации: иначе запись ключа упадёт ENOENT уже
  // после того, как ключ сгенерирован, и он потеряется.
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })

  const privateKey = await generateKeyPair('Ed25519')
  const bytes = privateKeyToProtobuf(privateKey)

  /* Пишем через временный файл и rename: при обрыве питания на середине
   * записи в файле остался бы обрезанный ключ, и следующий старт упал бы
   * на разборе protobuf. rename в пределах одной ФС атомарен. */
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, Buffer.from(bytes), { mode: 0o600 })
  fs.renameSync(tmp, file)
  // mode в writeFileSync не действует на уже существующий файл — ставим явно.
  fs.chmodSync(file, 0o600)

  log(`создана новая идентичность узла: ${file}`)
  return { privateKey, created: true, path: file }
}

/** Путь к файлу ключа — для логов и проверок. */
export function keyFilePath (dataDir) {
  return path.join(dataDir, KEY_FILE)
}

export { KEY_FILE }
