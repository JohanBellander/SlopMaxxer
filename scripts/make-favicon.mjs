// Renders public/favicon.ico (16, 32, 48 px PNGs) from the chevron in public/favicon.svg.
// Zero dependencies: polygon fill with 4x4 supersampling, PNG via zlib. Run: node scripts/make-favicon.mjs
import fs from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const svg = fs.readFileSync(fileURLToPath(new URL('../public/favicon.svg', import.meta.url)), 'utf8');
const fill = svg.match(/fill="#([0-9a-f]{6})"/i)[1].match(/../g).map(h => parseInt(h, 16));
// Same shape as the SVG path "M12 4h16l24 28-24 28H12l24-28Z" in a 64x64 box.
const poly = [[12, 4], [28, 4], [52, 32], [28, 60], [12, 60], [36, 32]];
const inside = (x, y) => {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
};

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); data.copy(out, 8);
  out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};

function png(size) {
  const S = 4, raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      let n = 0;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++)
        n += inside((x + (sx + .5) / S) * 64 / size, (y + (sy + .5) / S) * 64 / size);
      raw.set([...fill, Math.round(255 * n / (S * S))], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const images = [16, 32, 48].map(size => ({ size, data: png(size) }));
const header = Buffer.alloc(6 + 16 * images.length);
header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
let offset = header.length;
images.forEach(({ size, data }, i) => {
  const e = 6 + 16 * i;
  header[e] = size; header[e + 1] = size; header.writeUInt16LE(1, e + 4); header.writeUInt16LE(32, e + 6);
  header.writeUInt32LE(data.length, e + 8); header.writeUInt32LE(offset, e + 12);
  offset += data.length;
});
fs.writeFileSync(fileURLToPath(new URL('../public/favicon.ico', import.meta.url)), Buffer.concat([header, ...images.map(i => i.data)]));
console.log('wrote public/favicon.ico');
