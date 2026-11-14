/* TarNet PWA — RAG по локальным документам (2.29.5).
 *
 * ЧЕСТНО О ГРАНИЦАХ ЭТОГО ФАЙЛА.
 *
 * 1. RAG НЕ ЗАМЕНЯЕТ ОБУЧЕНИЕ. Модель отвечает на основе НАЙДЕННОГО
 *    фрагмента, а не «знает» документ. Если поиск не нашёл ничего выше
 *    порога, контекст НЕ вставляется вовсе — пустая вставка выглядела бы
 *    как «модель прочитала документы и не нашла», то есть как ответ,
 *    которого не было.
 *
 * 2. Эмбеддинги — `all-MiniLM-L6-v2` через transformers.js, лениво и с
 *    CDN. Почему не в репозитории: бандл 877 КБ + четыре WASM на 37 МБ,
 *    из которых браузер возьмёт один; класть 37 МБ в git ради одного
 *    файла — цена без выгоды. Модель (~80 МБ) кэшируется браузером.
 *
 * 3. БЕЗ СЕТИ RAG ПРОДОЛЖАЕТ РАБОТАТЬ, но лексически. Если модель не
 *    загрузилась (офлайн, медленный канал, старый браузер), поиск идёт по
 *    пересечению слов, и интерфейс ГОВОРИТ об этом, а не выдаёт лексический
 *    результат за семантический. Это осознанная деградация, не «готово».
 *
 * 4. Документы и эмбеддинги живут только в IndexedDB этого браузера.
 *    На сервер не уходит ни текст, ни вектор: иначе «приватный рой»
 *    отправлял бы документацию человека в облако на этапе индексации.
 */
(function () {
  'use strict';

  const DB_NAME = 'tarnet_knowledge_v1';
  const DB_VERSION = 1;
  const STORE_DOCS = 'documents';

  const CHUNK_SIZE = 700;
  const CHUNK_OVERLAP = 100;
  const TOP_K = 3;
  const MAX_CONTEXT_CHARS = 4000;

  const EMBED_CDN = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';
  const EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2';
  const PDF_CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs';
  const PDF_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs';

  /* ================= чистое: нормализация и чанкинг ================= */

  function normalize(text) {
    return String(text == null ? '' : text)
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/[ \t]*\n[ \t]*/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /* Режем по ближайшей границе в последней 40% окна: абзац → строка →
   * конец предложения → пробел. Резать строго по `size` значило бы рвать
   * слова и таблицы посередине, и чанк терял бы смысл, который в него
   * закладывал автор документа.
   *
   * Перекрытие обязательно: факт, попавший ровно на стык, без него не
   * попал бы ни в один чанк целиком. */
  function chunkText(text, opts) {
    const size = Math.max(50, Number(opts && opts.size) || CHUNK_SIZE);
    const overlap = Math.max(0, Math.min(size - 1, Number(opts && opts.overlap) || CHUNK_OVERLAP));
    const src = normalize(text);
    if (!src) return [];
    if (src.length <= size) return [src];

    const out = [];
    let start = 0;
    let guard = 0;
    while (start < src.length) {
      if (++guard > 100000) break; /* страховка от зацикливания на кривом вводе */
      let end = Math.min(src.length, start + size);
      if (end < src.length) {
        const win = src.slice(start, end);
        const minBreak = Math.floor(size * 0.6);
        let cut = -1;
        for (const sep of ['\n\n', '\n', '. ', '! ', '? ', '; ', ', ', ' ']) {
          const at = win.lastIndexOf(sep);
          if (at >= minBreak) { cut = at + sep.length; break; }
        }
        if (cut > 0) end = start + cut;
      }
      const piece = src.slice(start, end).trim();
      if (piece) out.push(piece);
      if (end >= src.length) break;
      const next = end - overlap;
      start = next > start ? next : start + 1;
    }
    return out;
  }

  /* ================= чистое: близость ================= */

  function cosine(a, b) {
    if (!a || !b || a.length !== b.length || !a.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (!na || !nb) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  const STOP = new Set(['что', 'как', 'для', 'или', 'это', 'the', 'and', 'for', 'with', 'are', 'was', 'этот', 'его', 'она', 'они']);

  /* Лёгкий стеммер для русских словоформ, и только для лексического поиска.
   *
   * ПОЧЕМУ ОН ВООБЩЕ ЕСТЬ. Документ говорит «804 чека», человек спрашивает
   * «сколько чеков» — это одна и та же мысль в двух падежах. Без стеммера
   * лексический режим видел два разных слова и не находил ничего: проверка
   * на реальном `PROJECT-HISTORY.md` падала именно так. Семантический режим
   * (MiniLM) свёл бы формы сам, но он доступен не всегда — а именно в
   * недоступном случае лексика остаётся единственным поиском.
   *
   * ГРАНИЦА СЛЕВА, А НЕ `\b`. В JavaScript `\b` определён через `[A-Za-z0-9_]`
   * и для кириллицы границей слова НЕ является, поэтому правила на `\b` перед
   * русским корнем молча не срабатывают. Здесь режется окончание по концу
   * строки, так что правая граница — сам конец слова.
   *
   * ПОЧЕМУ ОКОНЧАНИЯ, А НЕ ПОЛНОЦЕННЫЙ СТЕММЕР. Полный Porter для русского —
   * это библиотека и словарь исключений; для подсказки поиска хватит списка
   * падежных окончаний. Это осознанно грубо: стеммер читает морфологию, а не
   * смысл, и потому остаётся подсказкой, а не пониманием. Семантика — за
   * эмбеддингами, когда они есть.
   *
   * ПОРОГ ВХОДА — 3 БУКВЫ, А НЕ 4. «чека» и «чеков» должны свестись к одному
   * корню «чек»: документ говорит «804 чека», вопрос — «сколько чеков».
   * При пороге 4 слово из четырёх букв («чека») не резалось вовсе, и две
   * формы одного понятия снова расходились — проверка на реальном документе
   * падала именно так. Плата за низкий порог — совпадение с другим словом на
   * «чек-»; для поиска по документам это приемлемо, а негатив в тесте есть. */
  const RU_ENDINGS = ['ами', 'ями', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими', 'ов', 'ев', 'ей', 'ой', 'ый', 'ий', 'ая', 'ые', 'ых', 'им', 'ем', 'ом', 'ах', 'ях', 'ам', 'ям', 'ую', 'юю', 'а', 'я', 'ы', 'и', 'у', 'ю', 'е', 'о'];

  function stemRu(w) {
    /* Только кириллица: латинские слова и числа не трогаем, иначе
     * `tarnet` → `tarn` и поиск по именам сломается. */
    if (!/^[\u0400-\u04FF]+$/.test(w)) return w;
    if (w.length <= 3) return w;
    for (const end of RU_ENDINGS) {
      if (w.length - end.length >= 3 && w.endsWith(end)) {
        return w.slice(0, w.length - end.length);
      }
    }
    return w;
  }

  function tokenize(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .split(' ')
      /* Стеммер ДО фильтра стоп-слов: иначе «какая» → «как» попадала бы в
       * выдачу уже после того, как фильтр отработал. */
      .map(stemRu)
      .filter((w) => w.length > 2 && !STOP.has(w));
  }

  function lexicalScore(queryTokens, text) {
    if (!queryTokens.length) return 0;
    /* Стеммим вход повторно: вызывающий может передать как уже готовые
     * токены (`retrieve`), так и сырые слова. `stemRu` идемпотентен —
     * «чек» длиной 3 возвращается как есть, — поэтому двойной проход
     * безопасен, а API перестаёт зависеть от дисциплины вызывающего. */
    const uniq = [...new Set(queryTokens.map(stemRu))];
    const bag = new Set(tokenize(text));
    let hit = 0;
    for (const t of uniq) if (bag.has(t)) hit++;
    return hit / uniq.length;
  }

  function topK(items, k, scoreFn) {
    const n = Math.max(0, Number(k) || 0);
    return items
      .map((item) => ({ item, score: Number(scoreFn(item)) || 0 }))
      .sort((x, y) => y.score - x.score)
      .slice(0, n);
  }

  /* ================= эмбеддинги (лениво, CDN) ================= */

  let embedder = null;
  let embedderLoading = null;
  let embedderError = '';

  function semanticState() {
    return { ready: !!embedder, loading: !!embedderLoading, error: embedderError };
  }

  function loadEmbedder() {
    if (embedder) return Promise.resolve(embedder);
    if (embedderLoading) return embedderLoading;
    embedderLoading = import(/* webpackIgnore: true */ EMBED_CDN)
      .then(async (mod) => {
        /* allowLocalModels=false: в браузере нет локальной папки моделей,
         * и попытка искать её даёт шумную ошибку вместо честного «нет сети». */
        mod.env.allowLocalModels = false;
        mod.env.useBrowserCache = true;
        const pipe = await mod.pipeline('feature-extraction', EMBED_MODEL, { quantized: true });
        embedder = pipe;
        embedderError = '';
        return pipe;
      })
      .catch((e) => {
        embedderError = String(e && e.message ? e.message : e);
        return null;
      })
      .then((pipe) => { embedderLoading = null; return pipe; });
    return embedderLoading;
  }

  /* Пакетный вызов: один проход по N текстам дешевле N проходов по одному.
   * Возвращает массив векторов, `null` на месте текста — когда эмбеддингов
   * нет вовсе (нет сети). Хранить нули вместо null значило бы записать в
   * базу «вектор есть», и лексический режим уже не включился бы никогда. */
  async function embedMany(texts) {
    const list = Array.isArray(texts) ? texts : [texts];
    const pipe = await loadEmbedder();
    if (!pipe) return list.map(() => null);

    const out = [];
    const BATCH = 8;
    for (let i = 0; i < list.length; i += BATCH) {
      const batch = list.slice(i, i + BATCH);
      const res = await pipe(batch, { pooling: 'mean', normalize: true });
      const data = res && res.data;
      const dims = (res && res.dims) || [];
      if (!data) { for (let j = 0; j < batch.length; j++) out.push(null); continue; }
      if (dims.length === 2) {
        const d = dims[1];
        for (let r = 0; r < dims[0]; r++) out.push(data.slice(r * d, (r + 1) * d));
      } else {
        out.push(data);
      }
    }
    while (out.length < list.length) out.push(null);
    return out;
  }

  async function embedOne(text) {
    const [v] = await embedMany([text]);
    return v || null;
  }

  /* ================= IndexedDB ================= */

  let dbPromise = null;

  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        if (!globalThis.indexedDB) return reject(new Error('IndexedDB недоступен'));
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains(STORE_DOCS)) {
            /* keyPath id: один документ — одна запись. Чанки лежат внутри
             * записи, а не отдельным стором: поиск всё равно читает их
             * пачкой, а отдельный стор дал бы лишний проход и рассинхрон
             * при удалении документа. */
            d.createObjectStore(STORE_DOCS, { keyPath: 'id' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('IndexedDB не открылась'));
      });
    }
    return dbPromise;
  }

  function tx(mode, fn) {
    return db().then((d) => new Promise((resolve, reject) => {
      const t = d.transaction(STORE_DOCS, mode);
      const os = t.objectStore(STORE_DOCS);
      let out;
      try { out = fn(os); } catch (e) { reject(e); return; }
      t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
      t.onerror = () => reject(t.error || new Error('запись отклонена'));
      t.onabort = () => reject(t.error || new Error('запись отменена'));
    }));
  }

  function newId() {
    return 'k-' + (globalThis.crypto && crypto.randomUUID
      ? crypto.randomUUID()
      : Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
  }

  /* ================= чтение файлов ================= */

  async function readPdf(file) {
    const mod = await import(/* webpackIgnore: true */ PDF_CDN);
    if (mod.GlobalWorkerOptions) mod.GlobalWorkerOptions.workerSrc = PDF_WORKER;
    const buf = await file.arrayBuffer();
    const pdf = await mod.getDocument({ data: buf }).promise;
    let text = '';
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      text += content.items.map((i) => i.str || '').join(' ') + '\n\n';
    }
    return text;
  }

  async function readAnyFile(file) {
    const name = String((file && file.name) || 'document');
    if (/\.pdf$/i.test(name)) return readPdf(file);
    if (typeof file.text === 'function') return file.text();
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ''));
      r.onerror = () => reject(r.error || new Error('файл не прочитан'));
      r.readAsText(file);
    });
  }

  /* ================= ingest / list / delete ================= */

  async function ingestText(name, text, opts) {
    const chunks = chunkText(text, opts);
    if (!chunks.length) throw new Error('EMPTY_DOCUMENT');

    const vectors = await embedMany(chunks);
    const semantic = vectors.some((v) => !!v);

    const doc = {
      id: newId(),
      name: String(name || 'document').slice(0, 200),
      size: String(text == null ? '' : text).length,
      chunks: chunks.map((t, i) => ({ text: t, embedding: vectors[i] || null })),
      semantic,
      createdAt: Date.now(),
    };
    await tx('readwrite', (os) => { os.put(doc); return doc; });
    return doc;
  }

  async function ingestFile(file, opts) {
    const text = await readAnyFile(file);
    if (!normalize(text)) throw new Error('EMPTY_DOCUMENT');
    return ingestText((file && file.name) || 'document', text, opts);
  }

  function listDocuments() {
    return tx('readonly', (os) => os.getAll())
      .then((rows) => (Array.isArray(rows) ? rows : []).sort((a, b) => Number(b.createdAt) - Number(a.createdAt)))
      .catch(() => []);
  }

  function deleteDocument(id) {
    if (!id) return Promise.resolve();
    return tx('readwrite', (os) => { os.delete(id); }).catch(() => {});
  }

  function clearAll() {
    return tx('readwrite', (os) => { os.clear(); }).catch(() => {});
  }

  function stats() {
    return listDocuments().then((docs) => ({
      documents: docs.length,
      chunks: docs.reduce((n, d) => n + ((d.chunks && d.chunks.length) || 0), 0),
      semanticDocs: docs.filter((d) => d.semantic).length,
      bytes: docs.reduce((n, d) => n + (Number(d.size) || 0), 0),
    }));
  }

  /* ================= поиск ================= */

  async function retrieve(query, opts) {
    const k = Math.max(1, Number(opts && opts.k) || TOP_K);
    const docs = await listDocuments();
    const all = [];
    for (const d of docs) {
      for (const c of (d.chunks || [])) {
        if (!c || !c.text) continue;
        all.push({ docId: d.id, docName: d.name, text: c.text, embedding: c.embedding || null });
      }
    }
    if (!all.length) return [];

    const qv = await embedOne(query);
    if (qv) {
      const scored = topK(all, k, (it) => (it.embedding ? cosine(qv, it.embedding) : 0));
      return scored.map((s) => ({ ...s, mode: 'semantic' }));
    }
    const qt = tokenize(query);
    const scored = topK(all, k, (it) => lexicalScore(qt, it.text));
    return scored.map((s) => ({ ...s, mode: 'lexical' }));
  }

  /* Контекст для сообщения `system`.
   *
   * Порог разный для двух режимов намеренно: косинус у MiniLM даже для
   * нерелевантного текста даёт 0.1–0.2, а доля совпавших слов ниже 0.15
   * означает «совпало одно общее слово». Один порог на оба режима либо
   * пропускал бы мусор в семантике, либо не находил ничего в лексике. */
  async function contextFor(query, opts) {
    try {
      const hits = await retrieve(query, opts);
      if (!hits.length) return '';
      const mode = hits[0].mode;
      const min = (opts && opts.minScore != null) ? Number(opts.minScore) : (mode === 'semantic' ? 0.25 : 0.15);
      const good = hits.filter((h) => h.score >= min);
      if (!good.length) return '';

      let body = '';
      for (const h of good) {
        /* `topK` возвращает обёртку `{item, score, mode}`, а не сам
         * чанк: имя документа лежит в `h.item.docName`. Здесь раньше
         * читалось `h.docName` с верхнего уровня — всегда `undefined`,
         * и в контекст уходил источник «[undefined]». Модель видела
         * фрагмент без того, откуда он, а человек не мог проверить
         * ответ по документу. Обе формы поддержаны намеренно: если
         * `retrieve` когда-нибудь отдаст чанк напрямую, контекст не
         * потеряет имя снова. */
        const chunk = h.item || h;
        const piece = `[${chunk.docName || 'документ'}]\n${chunk.text}`;
        if (body.length + piece.length > MAX_CONTEXT_CHARS) break;
        body += (body ? '\n---\n' : '') + piece;
      }
      if (!body) return '';
      return '[Контекст из документов пользователя]\n---\n' + body +
        '\n---\nОтвечай на основе этого контекста. Если ответа в нём нет — скажи прямо, а не выдумывай.';
    } catch (_e) {
      /* RAG не имеет права ломать чат: любой сбой — пустой контекст,
       * и вопрос уходит как обычно. */
      return '';
    }
  }

  /* ================= UI ================= */

  const fmtKb = (n) => (Number(n) >= 1024 ? `${(Number(n) / 1024).toFixed(1)} КБ` : `${Number(n) || 0} Б`);

  async function renderList() {
    const box = document.getElementById('kbList');
    if (!box) return;
    const docs = await listDocuments();
    const st = semanticState();
    const statusEl = document.getElementById('kbStatus');
    if (statusEl) {
      statusEl.textContent = st.ready
        ? 'поиск: семантический (all-MiniLM-L6-v2)'
        : st.loading
          ? 'поиск: загружаю модель…'
          : docs.some((d) => d.semantic)
            ? 'поиск: семантический (модель в кэше браузера)'
            : 'поиск: лексический — модель недоступна, работает по словам';
    }
    box.innerHTML = '';
    if (!docs.length) {
      const p = document.createElement('p');
      p.className = 'kb-empty';
      p.textContent = 'Документов пока нет';
      box.appendChild(p);
      return;
    }
    for (const d of docs) {
      const row = document.createElement('div');
      row.className = 'kb-item';
      const name = document.createElement('span');
      name.className = 'kb-name';
      name.textContent = d.name;
      name.title = `${d.name} · ${fmtKb(d.size)} · чанков ${(d.chunks || []).length}`;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'kb-del';
      del.setAttribute('aria-label', `Удалить ${d.name}`);
      del.textContent = '×';
      del.addEventListener('click', async () => {
        await deleteDocument(d.id);
        renderList();
      });
      row.appendChild(name);
      row.appendChild(del);
      box.appendChild(row);
    }
  }

  async function handleFiles(files) {
    const list = Array.from(files || []);
    if (!list.length) return;
    const statusEl = document.getElementById('kbStatus');
    for (const f of list) {
      try {
        if (statusEl) statusEl.textContent = `индексирую ${f.name}…`;
        const doc = await ingestFile(f);
        if (statusEl) statusEl.textContent = `${doc.name}: ${doc.chunks.length} чанков, ${doc.semantic ? 'семантически' : 'лексически'}`;
      } catch (e) {
        if (statusEl) statusEl.textContent = `${f.name}: не удалось — ${e && e.message ? e.message : e}`;
      }
    }
    await renderList();
  }

  function init() {
    const btn = document.getElementById('kbUpload');
    const input = document.getElementById('kbFile');
    if (btn && input) {
      btn.addEventListener('click', () => input.click());
      input.addEventListener('change', () => {
        handleFiles(input.files).then(() => { input.value = ''; });
      });
    }
    const clear = document.getElementById('kbClear');
    if (clear) clear.addEventListener('click', async () => { await clearAll(); renderList(); });
    renderList();
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  const api = {
    /* чистые — их проверяет гейт */
    normalize, chunkText, cosine, tokenize, lexicalScore, topK,
    /* хранилище */
    ingestText, ingestFile, listDocuments, deleteDocument, clearAll, stats,
    /* поиск */
    retrieve, contextFor,
    /* эмбеддинги */
    loadEmbedder, embedMany, embedOne, semanticState,
    /* UI */
    renderList,
    /* константы — чтобы тест сверял их, а не литералы в двух местах */
    CONST: { DB_NAME, CHUNK_SIZE, CHUNK_OVERLAP, TOP_K, MAX_CONTEXT_CHARS, EMBED_MODEL },
  };

  if (typeof window !== 'undefined') window.TarNetKnowledge = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
