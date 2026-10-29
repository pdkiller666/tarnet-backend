#!/usr/bin/env node
"use strict";
/* Генератор иконок TarNet без зависимостей.
 *
 * Почему свой энкодер, а не sharp/canvas: в этом окружении нет ни одного
 * слоя рендера (canvas, pngjs, sharp, jimp — все отсутствуют; convert,
 * magick, rsvg-convert, inkscape — тоже). zlib входит в Node, поэтому PNG
 * пишется напрямую: сигнатура, IHDR, IDAT, IEND.
 *
 * Форма повторяет канонический логотип из app/icon.svg — тот же путь,
 * что в шапках трёх страниц. Рисуем в 4x и усредняем вниз: без этого
 * окружности и диагонали на 192 px выглядят рваными.
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SS = 4; // суперсэмплинг

/* ---------- PNG ---------- */
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
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // 8-bit RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // по одному байту фильтра на строку
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------- геометрия в системе 32x32 ---------- */
const hex = (h) => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];

const TEAL = "#5fe0d3";
const BLUE = "#3b82f6";
const INK = "#062522";

/* Скруглённый прямоугольник: x∈[1.5,30.5], радиус 9. */
function inRoundedRect(x, y) {
  const cx = 16, cy = 16, half = 14.5, r = 9;
  const qx = Math.abs(x - cx) - (half - r);
  const qy = Math.abs(y - cy) - (half - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r <= 0;
}

function inCircle(x, y, cx, cy, r) {
  return Math.hypot(x - cx, y - cy) <= r;
}

/* Расстояние до отрезка; нужно для «ножек» логотипа. */
function distToSegment(x, y, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = x - ax, wy = y - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 === 0 ? 0 : (wx * vx + wy * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (ax + t * vx), y - (ay + t * vy));
}

const STROKES = [
  [16, 12.8, 16, 10.2],
  [18.7, 17.5, 21.0, 18.9],
  [13.3, 17.5, 11.0, 18.9],
];
const DOTS = [
  [16, 16, 3.1],
  [16, 8.4, 2.1],
  [22.8, 19.9, 2.1],
  [9.2, 19.9, 2.1],
];

function render(size) {
  const S = size * SS;
  const buf = Buffer.alloc(S * S * 4); // прозрачно

  function blend(x, y, r, g, b) {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4;
    const src = 1, dst = buf[i + 3] / 255, out = src + dst * (1 - src);
    if (out <= 0) return;
    buf[i] = Math.round((r * src + buf[i] * dst * (1 - src)) / out);
    buf[i + 1] = Math.round((g * src + buf[i + 1] * dst * (1 - src)) / out);
    buf[i + 2] = Math.round((b * src + buf[i + 2] * dst * (1 - src)) / out);
    buf[i + 3] = Math.round(out * 255);
  }

  const [r1, g1, b1] = hex(TEAL);
  const [r2, g2, b2] = hex(BLUE);
  const [ri, gi, bi] = hex(INK);

  for (let sy = 0; sy < S; sy += 1) {
    for (let sx = 0; sx < S; sx += 1) {
      // переводим в систему 32x32
      const x = ((sx + 0.5) / S) * 32;
      const y = ((sy + 0.5) / S) * 32;

      if (!inRoundedRect(x, y)) continue;

      // градиент по диагонали, как в логотипе лендинга
      const t = Math.max(0, Math.min(1, (x + y) / 64));
      let r = Math.round(r1 + (r2 - r1) * t);
      let g = Math.round(g1 + (g2 - g1) * t);
      let b = Math.round(b1 + (b2 - b1) * t);

      // тёмные элементы поверх градиента
      let ink = false;
      for (const [cx, cy, rad] of DOTS) {
        if (inCircle(x, y, cx, cy, rad)) { ink = true; break; }
      }
      if (!ink) {
        for (const [ax, ay, bx, by] of STROKES) {
          if (distToSegment(x, y, ax, ay, bx, by) <= 0.85) { ink = true; break; }
        }
      }
      if (ink) { r = ri; g = gi; b = bi; }

      blend(sx, sy, r, g, b);
    }
  }

  // усреднение блоков SSxSS
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const i = ((y * SS + sy) * S + (x * SS + sx)) * 4;
          r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3];
        }
      }
      const n = SS * SS, o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return encodePng(size, size, out);
}

const appDir = path.join(__dirname, "..", "app");
const targets = [
  ["icon-192.png", 192],
  ["icon-512.png", 512],
  ["icon-180.png", 180], // apple-touch-icon
  ["favicon-32.png", 32],
];

for (const [name, size] of targets) {
  const png = render(size);
  fs.writeFileSync(path.join(appDir, name), png);
  const back = fs.readFileSync(path.join(appDir, name));
  const w = back.readUInt32BE(16), h = back.readUInt32BE(20);
  console.log(`${name.padEnd(16)} ${w}x${h} depth=${back[24]} colorType=${back[25]} ${back.length} B`);
}
