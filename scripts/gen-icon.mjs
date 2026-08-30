/**
 * 生成应用图标（纯 Node，无外部依赖）：一枚垃圾桶。
 *   build/icon.png      256×256，electron-builder 转 ico 用
 *   app/assets/tray.png 32×32（保留，托盘虽未启用但窗口图标沿用）
 * 用法： node scripts/gen-icon.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, rgbaAt) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = rgbaAt(x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 垃圾桶剪影：盖 + 桶身，亮蓝描边 */
function trash(size) {
  const s = size / 32;
  const covOf = (d, w) => Math.max(0, Math.min(1, (w - d) / Math.max(0.5, s)));
  return png(size, (x, y) => {
    // 坐标归一（桶身参考框：x 7..25，y 5..29）
    const px = x / s, py = y / s;
    // 桶盖：y 8..11，x 9..23（含提手 y 5..8, x 14..18）
    const lid = (py >= 8 && py <= 11.5 && px >= 9 && px <= 23);
    const handle = (py >= 5 && py <= 8.5 && px >= 14 && px <= 18 && !(py >= 6.5 && py <= 8.5 && px >= 15 && px <= 17));
    // 桶身：上口 x 8.5..23.5，下口 x 11..21，y 11.5..29
    const body = py >= 11.5 && py <= 29 && px >= (11 + (py - 11.5) * (21 - 11) / 17.5) && px <= (21 + (py - 11.5) * (23.5 - 8.5) / 17.5);
    if (!lid && !handle && !body) return [0, 0, 0, 0];
    // 距离最近边界的近似距离（用于描边过渡）
    const edges = [];
    if (lid) edges.push(Math.min(px - 9, 23 - px, py - 8, 11.5 - py));
    if (handle) edges.push(Math.min(px - 14, 18 - px, py - 5, 8.5 - py, px - 15, 17 - px, py - 6.5, 8.5 - py));
    if (body) edges.push(Math.min(px - (11 + (py - 11.5) * (21 - 11) / 17.5), (21 + (py - 11.5) * (23.5 - 8.5) / 17.5) - px, py - 11.5, 29 - py));
    const d = Math.min(...edges);
    const cov = Math.min(1, Math.max(0, covOf(d, 1.15 * s)));
    return [122, 162, 255, Math.round(cov * 255)];
  });
}

mkdirSync(join(ROOT, 'build'), { recursive: true });
mkdirSync(join(ROOT, 'app', 'assets'), { recursive: true });
writeFileSync(join(ROOT, 'build', 'icon.png'), trash(256));
writeFileSync(join(ROOT, 'app', 'assets', 'tray.png'), trash(32));
console.log('图标已生成：build/icon.png (256) · app/assets/tray.png (32)');
