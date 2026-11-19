#!/usr/bin/env node
/**
 * Draws the desktop app's icons from the same geometry as docs/favicon.svg
 * (a rounded square with the Vault arch and its play notch) — no image
 * libraries needed, so it runs anywhere Node does.
 *
 *   node desktop/scripts/make-icons.js
 *
 * Writes into desktop/assets/:
 *   icon.png              1024², full-bleed rounded square (Windows, Linux)
 *   icon-mac.png          1024², inset on the macOS icon grid (Big Sur+)
 *   tray.png / @2x        coloured tray icon (Windows, Linux)
 *   trayTemplate.png / @2x  black-on-transparent menu-bar icon (macOS
 *                          recolours "Template" images for light/dark bars)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'assets');
const BG = [0x93, 0xbf, 0xf0];
const FG = [0x10, 0x1b, 0x28];

// --- geometry in the 64×64 favicon space --------------------------------
function inRoundedRect(x, y, size, r) {
  if (x < 0 || y < 0 || x > size || y > size) return false;
  const cx = Math.min(Math.max(x, r), size - r);
  const cy = Math.min(Math.max(y, r), size - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

// M14 54V32a18 18 0 0 1 36 0v22Z  — the arch
function inArch(x, y) {
  if (x < 14 || x > 50 || y > 54) return false;
  if (y >= 32) return true;
  return (x - 32) ** 2 + (y - 32) ** 2 <= 18 * 18;
}

// m13.5-24v16.5L41 38.25Z — the play notch cut out of it (even-odd)
function inNotch(x, y) {
  const ax = 27.5, ay = 30, bx = 27.5, by = 46.5, cx = 41, cy = 38.25;
  const s = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
  const d1 = s(x, y, ax, ay, bx, by);
  const d2 = s(x, y, bx, by, cx, cy);
  const d3 = s(x, y, cx, cy, ax, ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

const glyph = (x, y) => inArch(x, y) && !inNotch(x, y);

/**
 * Render `size`² RGBA. `inset` is the fraction of the canvas the tile
 * occupies (1 = full bleed). `mode`: 'tile' (blue square + dark arch),
 * 'glyph' (arch only, in `color`).
 */
function render(size, { inset = 1, mode = 'tile', color = FG, glyphScale = 1 } = {}) {
  const px = Buffer.alloc(size * size * 4);
  const SS = 4; // 4×4 supersampling for smooth edges
  const tile = size * inset;
  const offset = (size - tile) / 2;
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      let bg = 0, fg = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          // canvas → 64-unit favicon space
          const ux = ((pxl + (sx + 0.5) / SS - offset) / tile) * 64;
          const uy = ((py + (sy + 0.5) / SS - offset) / tile) * 64;
          // optionally shrink the arch around its visual centre (32, 34)
          const gx = (ux - 32) / glyphScale + 32;
          const gy = (uy - 34) / glyphScale + 34;
          if (mode === 'tile') {
            if (!inRoundedRect(ux, uy, 64, 16)) continue;
            if (glyph(gx, gy)) fg++; else bg++;
          } else if (glyph(gx, gy)) {
            fg++;
          }
        }
      }
      const n = SS * SS;
      const a = (bg + fg) / n;
      const i = (py * size + pxl) * 4;
      if (a === 0) continue;
      const mix = mode === 'tile' ? fg / (bg + fg) : 1;
      const base = mode === 'tile' ? BG : color;
      for (let c = 0; c < 3; c++) px[i + c] = Math.round(base[c] * (1 - mix) + color[c] * mix);
      px[i + 3] = Math.round(a * 255);
    }
  }
  return px;
}

// --- minimal PNG encoder ------------------------------------------------
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function write(name, size, opts) {
  fs.writeFileSync(path.join(OUT, name), png(size, render(size, opts)));
  console.log(`  ${name} (${size}×${size})`);
}

fs.mkdirSync(OUT, { recursive: true });
console.log('Writing icons to desktop/assets/');
write('icon.png', 1024, { inset: 1 });
// Apple's grid: an 824-px tile centred on a 1024 canvas.
write('icon-mac.png', 1024, { inset: 824 / 1024 });
write('tray.png', 16, { inset: 1 });
write('tray@2x.png', 32, { inset: 1 });
// Menu-bar glyph: the arch alone, a little larger so it reads at 16 px.
write('trayTemplate.png', 16, { mode: 'glyph', color: [0, 0, 0], glyphScale: 1.25 });
write('trayTemplate@2x.png', 32, { mode: 'glyph', color: [0, 0, 0], glyphScale: 1.25 });
