/* Генерация PNG-иконок без внешних зависимостей.
 *
 * Зачем свой энкодер: в окружении нет ни canvas, ни sharp, ни pngjs, а
 * ставить нативные пакеты ради двух картинок — лишний риск для сборки.
 * PNG собирается вручную: сигнатура + IHDR + IDAT(zlib) + IEND.
 *
 * Рисунок повторяет app/icon.svg: тёмный скруглённый квадрат, синее кольцо,
 * центр и четыре точки по сторонам. Сглаживание — суперсемплингом 4x4:
 * без него кольцо на 192 px выглядит рваным.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BG = [0x0b, 0x0e, 0x14];
const FG = [0x4f, 0x9c, 0xf9];

/* ---------- CRC32 (обязателен для каждого чанка PNG) ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  /* Каждая строка предваряется байтом фильтра. Filter 0 (None) — самый
   * простой; на иконках с крупными полями zlib жмёт и так хорошо. */
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- Рисование ---------- */
const SS = 4; // суперсемплинг

function drawIcon(size) {
  const S = size * SS;
  const buf = Buffer.alloc(S * S * 4); // прозрачный по умолчанию

  const px = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4;
    /* Простое наложение: иконка рисуется на прозрачном фоне, поэтому
     * для внутренних фигур достаточно перезаписи с учётом альфы. */
    const src = a / 255;
    const dst = buf[i + 3] / 255;
    const out = src + dst * (1 - src);
    if (out <= 0) return;
    buf[i] = Math.round((r * src + buf[i] * dst * (1 - src)) / out);
    buf[i + 1] = Math.round((g * src + buf[i + 1] * dst * (1 - src)) / out);
    buf[i + 2] = Math.round((b * src + buf[i + 2] * dst * (1 - src)) / out);
    buf[i + 3] = Math.round(out * 255);
  };

  /* Скруглённый квадрат: радиус 14 из 64, как в SVG. */
  const radius = (14 / 64) * S;
  const inRoundedRect = (x, y) => {
    const cx = Math.min(Math.max(x, radius), S - radius);
    const cy = Math.min(Math.max(y, radius), S - radius);
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  };

  for (let y = 0; y < S; y += 1) {
    for (let x = 0; x < S; x += 1) {
      if (inRoundedRect(x + 0.5, y + 0.5)) px(x, y, BG[0], BG[1], BG[2], 255);
    }
  }

  /* Кольцо: r=20, толщина 3 (из 64). Проверяем расстояние до окружности. */
  const cx = S / 2;
  const cy = S / 2;
  const k = S / 64;
  const ringR = 20 * k;
  const ringW = 3 * k;

  const disc = (dx, dy, r, algo) => {
    const x0 = Math.floor(cx + dx - r) - 1;
    const x1 = Math.ceil(cx + dx + r) + 1;
    const y0 = Math.floor(cy + dy - r) - 1;
    const y1 = Math.ceil(cy + dy + r) + 1;
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const d = Math.hypot(x + 0.5 - (cx + dx), y + 0.5 - (cy + dy));
        if (d <= r) algo(x, y);
      }
    }
  };

  const paint = (x, y) => px(x, y, FG[0], FG[1], FG[2], 255);

  /* Кольцо рисуем как разность двух дисков через проверку попадания в полосу. */
  const x0 = Math.floor(cx - ringR - ringW) - 1;
  const x1 = Math.ceil(cx + ringR + ringW) + 1;
  const y0 = Math.floor(cy - ringR - ringW) - 1;
  const y1 = Math.ceil(cy + ringR + ringW) + 1;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (Math.abs(d - ringR) <= ringW / 2) paint(x, y);
    }
  }

  disc(0, 0, 6 * k, paint);                       // центр
  disc(0, -20 * k, 3.5 * k, paint);               // верх
  disc(0, 20 * k, 3.5 * k, paint);                // низ
  disc(-20 * k, 0, 3.5 * k, paint);               // лево
  disc(20 * k, 0, 3.5 * k, paint);                // право

  /* Даунсемплинг: усредняем блок SSxSS. Здесь и появляется сглаживание. */
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const i = ((y * SS + sy) * S + (x * SS + sx)) * 4;
          r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3];
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

const dir = path.join(__dirname, '..', 'app');
for (const size of [192, 512]) {
  const rgba = drawIcon(size);
  const png = encodePng(size, size, rgba);
  const file = path.join(dir, `icon-${size}.png`);
  fs.writeFileSync(file, png);
  console.log(`${path.basename(file)}: ${png.length} байт, ${size}x${size}`);
}
