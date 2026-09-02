/**
 * scripts/gen-icon.js — 生成应用图标（PNG + ICO）
 *
 * 纯 Node 实现，无 native 依赖：
 *   - 用 Buffer 绘制 256x256 RGBA bitmap
 *   - PNG 编码（zlib + CRC32）
 *   - ICO 容器封装（内嵌多个尺寸的 PNG，Windows Vista+ 支持）
 *
 * 输出：
 *   assets/icon.png  - 主图标 (256x256)
 *   assets/icon.ico  - Windows 多尺寸 ICO (16/32/48/64/128/256)
 *   assets/tray.png  - 托盘用 32x32 PNG（实际上 main.js 用 createFromBitmap 实时画，
 *                     这里也写一份备用）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.resolve(__dirname, '..', 'assets');

// ---------- CRC32 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ---------- PNG 编码 ----------
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // 每行加 filter byte 0
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- 图标绘制 ----------
function drawIcon(size) {
  const buf = Buffer.alloc(size * size * 4);

  // 渐变色（蓝 → 绿）
  const c1 = [77, 171, 247];
  const c2 = [105, 219, 124];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const t = y / size;
      buf[i]     = Math.round(c1[0] + (c2[0] - c1[0]) * t);
      buf[i + 1] = Math.round(c1[1] + (c2[1] - c1[1]) * t);
      buf[i + 2] = Math.round(c1[2] + (c2[2] - c1[2]) * t);
      buf[i + 3] = 255;

      // 圆角矩形（alpha 渐变）
      const radius = size * 0.18;
      const dx = Math.max(0, radius - - x, x - - (size - 1 - radius));
      const dy = Math.max(0, radius - - y, y - - (size - 1 - radius));
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > radius) buf[i + 3] = 0;
      else if (dist > radius - 1) buf[i + 3] = Math.round(255 * (radius - dist));

      // 顶部红色装订条（占顶部 14% 高度，水平方向 6% 内边距）
      const barTop = Math.round(size * 0.18);
      const barBot = Math.round(size * 0.30);
      const barPad = Math.round(size * 0.06);
      if (y >= barTop && y <= barBot && x >= barPad && x < size - barPad) {
        buf[i]     = 255;
        buf[i + 1] = 122;
        buf[i + 2] = 89;
        buf[i + 3] = 255;
      }

      // 中间白色"日"字：横 + 竖
      const cx = size / 2, cy = size / 2 + size * 0.08;
      const horizH = size * 0.10;
      const horizW = size * 0.30;
      const vertW  = size * 0.09;
      const vertH  = size * 0.30;
      const inHoriz = (Math.abs(y - cy) < horizH / 2) && (Math.abs(x - cx) < horizW / 2);
      const inVert  = (Math.abs(x - cx) < vertW / 2)  && (Math.abs(y - cy) < vertH / 2);
      if (inHoriz || inVert) {
        buf[i]     = 255;
        buf[i + 1] = 255;
        buf[i + 2] = 255;
        buf[i + 3] = 240;
      }
    }
  }
  return buf;
}

// ---------- ICO 容器 ----------
function toICO(pngs) {
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  const entries = [];
  let offset = 6 + count * 16;
  for (const { size, png } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;   // width
    e[1] = size >= 256 ? 0 : size;   // height
    e[2] = 0;                         // color palette
    e[3] = 0;                         // reserved
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...pngs.map(p => p.png)]);
}

// ---------- 主流程 ----------
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

// 主 PNG (256x256)
const main256 = drawIcon(256);
const png256 = encodePNG(256, 256, main256);
fs.writeFileSync(path.join(OUT, 'icon.png'), png256);
console.log(`[icon] icon.png  written (${png256.length} bytes)`);

// 托盘 PNG (32x32)
const png32 = encodePNG(32, 32, drawIcon(32));
fs.writeFileSync(path.join(OUT, 'tray.png'), png32);
console.log(`[icon] tray.png  written (${png32.length} bytes)`);

// ICO（多尺寸）
const sizes = [16, 32, 48, 64, 128, 256];
const pngs = sizes.map(s => ({ size: s, png: encodePNG(s, s, drawIcon(s)) }));
const ico = toICO(pngs);
fs.writeFileSync(path.join(OUT, 'icon.ico'), ico);
console.log(`[icon] icon.ico  written (${ico.length} bytes, sizes: ${sizes.join(', ')})`);

console.log('[icon] done ✓');