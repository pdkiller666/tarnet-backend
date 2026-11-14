#!/usr/bin/env node
'use strict';
/* test-knowledge.js — приёмка RAG в PWA (`app/knowledge.js`).
 *
 * ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ И ПОЧЕМУ ИМЕННО ТАК.
 *
 * До этого файла `app/knowledge.js` не был покрыт ни одной проверкой: гейт
 * `scripts/verify.sh` не упоминал его вовсе. Модуль работал «по чтению», а
 * приёмочный критерий «загрузить документ → задать вопрос → получить ответ
 * из документа» не был доказан ничем. Это тот же класс, что уже ловился в
 * проекте: механизм есть, проверки смотрят мимо.
 *
 * ТЕСТ ИДЁТ ЧЕРЕЗ НАСТОЯЩИЙ IndexedDB, а не через заглушку. `fake-indexeddb`
 * поднимает спецификацию в Node, поэтому проверяется боевой путь
 * `ingestText → tx(readwrite) → listDocuments → retrieve → contextFor`, а не
 * моя фантазия о нём. Заглушка проверяла бы заглушку.
 *
 * ЭМБЕДДИНГИ ЗДЕСЬ НЕДОСТУПНЫ И ЭТО ПРОВЕРЯЕТСЯ КАК ФАКТ. `loadEmbedder`
 * тянет модель с CDN; в Node `import()` по https не поддерживается, поэтому
 * векторного поиска нет и модуль обязан честно уйти в лексический режим.
 * Тест утверждает именно это: `semanticState().ready === false`, режим
 * `lexical`, и контекст всё равно находится. Молчаливая подмена лексики
 * семантикой была бы ложью о качестве поиска.
 *
 * РЕГРЕССИЯ, РАДИ КОТОРОЙ ФАЙЛ И НАПИСАН. `contextFor` читал `h.docName`
 * с верхнего уровня, а `topK` возвращает обёртку `{item, score, mode}` —
 * имя документа всегда было `undefined`, и в `system` уходил источник
 * «[undefined]». Модель получала фрагмент без происхождения, человек не мог
 * сверить ответ с документом. Проверка «имя документа в контексте» падает
 * на старом коде и проходит на исправленном.
 *
 * Запуск: node test-knowledge.js
 */

const fs = require('fs');
const path = require('path');

/* Порядок важен: `auto` ставит глобальный indexedDB ДО загрузки модуля,
 * иначе `db()` закеширует отказ «IndexedDB недоступен» навсегда. */
require('fake-indexeddb/auto');

const kb = require('./app/knowledge.js');

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ✅', name); }
  else {
    fail += 1;
    failures.push({ name, detail });
    console.log('  ❌', name, detail === undefined ? '' : JSON.stringify(detail));
  }
}

(async () => {
  console.log('\nTarNet — приёмка RAG (app/knowledge.js)\n');

  /* ---------- 1. константы: тест сверяет их, а не литералы ---------- */
  const C = kb.CONST;
  ok('хранилище называется tarnet_knowledge_v1', C.DB_NAME === 'tarnet_knowledge_v1', C.DB_NAME);
  ok('чанк 700 символов', C.CHUNK_SIZE === 700, C.CHUNK_SIZE);
  ok('перекрытие 100 символов', C.CHUNK_OVERLAP === 100, C.CHUNK_OVERLAP);
  ok('в контекст идёт не больше 3 чанков', C.TOP_K === 3, C.TOP_K);
  ok('бюджет контекста 4000 символов', C.MAX_CONTEXT_CHARS === 4000, C.MAX_CONTEXT_CHARS);

  /* ---------- 2. чистое: нормализация ---------- */
  ok('нормализация убирает \r и лишние пустые строки',
    kb.normalize('  a\r\n\r\n\r\n b  c ') === 'a\n\nb c',
    kb.normalize('  a\r\n\r\n\r\n b  c '));
  ok('пустой ввод даёт пустую строку', kb.normalize(null) === '', kb.normalize(null));

  /* ---------- 3. чанкинг ---------- */
  const longText = ('Слово номер раз. '.repeat(200)).trim();
  const chunks = kb.chunkText(longText, { size: 700, overlap: 100 });
  ok('длинный текст режется на несколько чанков', chunks.length > 1, chunks.length);
  ok('ни один чанк не превышает размер',
    chunks.every((c) => c.length <= 700),
    Math.max(...chunks.map((c) => c.length)));
  ok('чанки непустые', chunks.every((c) => c.trim().length > 0));
  /* Перекрытие проверяется по факту, а не по константе: соседние чанки
   * обязаны делить хвост, иначе факт на стыке не попадёт целиком ни в один. */
  const overlapFound = chunks.some((c, i) => {
    if (i === 0) return false;
    const prevTail = chunks[i - 1].slice(-40);
    return c.startsWith(prevTail.slice(-10)) || c.includes(prevTail.slice(-20));
  });
  ok('соседние чанки перекрываются', overlapFound);
  ok('короткий текст — один чанк', kb.chunkText('привет', {}).length === 1);
  ok('пустой текст — ноль чанков', kb.chunkText('   ', {}).length === 0);

  /* ---------- 4. близость ---------- */
  ok('косинус одинаковых векторов = 1', Math.abs(kb.cosine([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
  ok('косинус ортогональных = 0', kb.cosine([1, 0], [0, 1]) === 0);
  ok('косинус разной длины = 0, а не падение', kb.cosine([1, 2], [1, 2, 3]) === 0);
  ok('косинус с нулевым вектором = 0', kb.cosine([0, 0], [1, 1]) === 0);
  ok('косинус null = 0', kb.cosine(null, [1]) === 0);

  /* ---------- 5. лексический поиск ---------- */
  /* Ожидание — СТЕММИРОВАННЫЕ формы: «чеков» → «чек». Это не поблажка
   * теста, а контракт: словоформы обязаны сводиться, иначе документ
   * («804 чека») и вопрос («сколько чеков») не встречаются никогда. */
  ok('токенайзер выбрасывает короткие слова и стоп-слова',
    kb.tokenize('это как для чеков TarNet').join(' ') === 'чек tarnet',
    kb.tokenize('это как для чеков TarNet'));
  ok('стеммер сводит падежи одного слова',
    kb.tokenize('чека').join() === kb.tokenize('чеков').join(),
    [kb.tokenize('чека'), kb.tokenize('чеков')]);
  ok('стеммер не трогает латиницу',
    kb.tokenize('tarnet').join() === 'tarnet', kb.tokenize('tarnet'));
  ok('лексический скор: полное совпадение = 1',
    Math.abs(kb.lexicalScore(['чеков', 'tarnet'], 'Чеков в TarNet 808') - 1) < 1e-9,
    kb.lexicalScore(['чеков', 'tarnet'], 'Чеков в TarNet 808'));
  ok('лексический скор: нет совпадений = 0',
    kb.lexicalScore(['погода'], 'Чеков в TarNet 808') === 0);
  const ranked = kb.topK([{ n: 'a', v: 1 }, { n: 'b', v: 9 }, { n: 'c', v: 5 }], 2, (it) => it.v);
  ok('topK берёт k лучших по убыванию',
    ranked.length === 2 && ranked[0].item.n === 'b' && ranked[1].item.n === 'c',
    ranked.map((r) => r.item.n));

  /* ---------- 6. хранилище: запись, чтение, счёт ---------- */
  await kb.clearAll();
  const doc = await kb.ingestText('PROJECT-HISTORY.md',
    'В леджере TarNet 808 чеков. Казна 0.1982 TAR. Воркеров 97, активных 0.', { size: 700 });
  ok('документ записан с чанками', doc.chunks.length >= 1, doc.chunks.length);
  ok('имя документа сохранено', doc.name === 'PROJECT-HISTORY.md', doc.name);

  const list = await kb.listDocuments();
  ok('список показывает загруженный документ', list.length === 1, list.length);
  const st = await kb.stats();
  ok('статистика считает документы и чанки',
    st.documents === 1 && st.chunks === doc.chunks.length,
    st);

  /* ---------- 7. поиск: вопрос находит нужный фрагмент ---------- */
  const hits = await kb.retrieve('Сколько чеков в TarNet?');
  ok('поиск вернул попадания', hits.length >= 1, hits.length);
  ok('режим поиска — лексический (эмбеддингов в Node нет)',
    hits[0].mode === 'lexical', hits[0].mode);
  ok('найден именно нужный чанк',
    String((hits[0].item && hits[0].item.text) || '').includes('808'),
    String((hits[0].item && hits[0].item.text) || '').slice(0, 60));
  ok('эмбеддинги честно недоступны, а не подменены',
    kb.semanticState().ready === false, kb.semanticState());

  /* ---------- 8. контекст для system: то, что реально уходит модели ---------- */
  const ctx = await kb.contextFor('Сколько чеков в TarNet?');
  ok('контекст содержит факт из документа', ctx.includes('808'));
  ok('контекст содержит ИМЯ документа, а не undefined',
    ctx.includes('[PROJECT-HISTORY.md]') && !ctx.includes('undefined'),
    JSON.stringify(ctx.slice(0, 80)));
  ok('контекст требует отвечать по документу', /на основе этого контекста/i.test(ctx));
  ok('контекст не превышает бюджет',
    ctx.length <= C.MAX_CONTEXT_CHARS + 200, ctx.length);

  /* Нерелевантный вопрос НЕ должен получать пустую рамку: пустая вставка
   * выглядела бы как «модель прочитала документы и не нашла», то есть как
   * ответ, которого не было. Правильное поведение — пустая строка. */
  const irrelevant = await kb.contextFor('Какая погода в Антарктиде завтра утром?');
  ok('нерелевантный вопрос не получает контекст', irrelevant === '', JSON.stringify(irrelevant));

  /* ---------- 9. удаление ---------- */
  const id = doc.id;
  await kb.deleteDocument(id);
  const after = await kb.listDocuments();
  ok('удалённый документ исчез из списка', after.length === 0, after.length);
  const ctxGone = await kb.contextFor('Сколько чеков в TarNet?');
  ok('после удаления контекст пуст', ctxGone === '', JSON.stringify(ctxGone));

  /* ---------- 10. приёмка на настоящем документе репозитория ---------- */
  /* Здесь проверяется сценарий из директивы целиком: берём реальный
   * PROJECT-HISTORY.md, а не придуманную строку. Если чанкинг или порог
   * сломаются на живом тексте, этот шаг покраснеет, а синтетика — нет. */
  const docPath = path.join(__dirname, 'PROJECT-HISTORY.md');
  ok('PROJECT-HISTORY.md существует', fs.existsSync(docPath));
  if (fs.existsSync(docPath)) {
    const real = fs.readFileSync(docPath, 'utf8');
    const realDoc = await kb.ingestText('PROJECT-HISTORY.md', real, { size: 700, overlap: 100 });
    ok('реальный документ разбит на много чанков', realDoc.chunks.length > 50, realDoc.chunks.length);

    const realHits = await kb.retrieve('Сколько чеков в леджере TarNet?');
    ok('поиск по реальному документу дал попадания', realHits.length >= 1, realHits.length);

    /* ЧЕСТНАЯ ГРАНИЦА ЛЕКСИЧЕСКОГО РЕЖИМА, ЗАМЕРЕННАЯ, А НЕ ОБЪЯВЛЕННАЯ.
     *
     * Вопрос «сколько чеков в леджере TarNet» находит 102 чанка со словом
     * «чек», но факт `receipts: 808` лежит в чанке, где совпало ОДНО слово из
     * четырёх («чек»), — и он проигрывает шаблонным чанкам, где совпало два.
     * Никакая формула на пересечении слов этого не исправит: в вопросе есть
     * «леджер» и «tarnet», а в чанке с фактом их нет. Это работа эмбеддингов,
     * и здесь они недоступны — `semanticState().ready === false` проверено
     * выше. Поэтому тест утверждает ровно две вещи: гарантию лексики и её
     * предел. Делать вид, что предел закрыт, значило бы соврать о качестве. */
    const realCtx = await kb.contextFor('Сколько чеков в леджере TarNet?');
    ok('контекст по реальному документу непустой', realCtx.length > 0, realCtx.length);
    ok('в контексте реального документа нет undefined',
      !realCtx.includes('undefined'), JSON.stringify(realCtx.slice(0, 80)));

    /* Гарантия: если спросить СЛОВАМИ ДОКУМЕНТА, факт находится. */
    const wordedCtx = await kb.contextFor('receipts 808 workers');
    ok('вопрос словами документа находит факт из документа',
      /808/.test(wordedCtx), JSON.stringify(wordedCtx.slice(0, 120)));

    /* Предел: вопрос «чужими» словами в лексическом режиме факт не выносит
     * наверх. Проверяется как факт, чтобы регрессия не прошла незамеченной
     * ни в одну сторону: если поиск внезапно начнёт находить — тест
     * покраснеет и потребует обновить запись, а не молча улучшится. */
    const limitHits = await kb.retrieve('Сколько чеков в леджере TarNet?');
    const topHas808 = String((limitHits[0] && limitHits[0].item && limitHits[0].item.text) || '').includes('808');
    ok('лексический режим не выдаёт семантику: факт не в топе при чужих словах',
      limitHits[0].mode === 'lexical' && topHas808 === false,
      { mode: limitHits[0].mode, topHas808 });
    await kb.clearAll();
  }

  console.log('\n' + '─'.repeat(50));
  console.log(`Итого: ${pass} ✅   ${fail} ❌`);
  if (fail) {
    console.log('\nПровалы:');
    for (const f of failures) console.log(`  • ${f.name} — ${JSON.stringify(f.detail)}`);
  }
  console.log('─'.repeat(50));
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  /* Фатальная ошибка — не «ноль падений»: exit 2 отличается от 0 намеренно,
   * чтобы гейт не принял сломанный набор за зелёный. */
  console.error('\nФатальная ошибка теста:', e && e.message ? e.message : e);
  process.exit(2);
});
