// Generates the PWA icons with zlib alone -- no image library, no binary assets
// checked in. Draws the app's own motif: a progress bar part-way to the line.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return (buf) => {
    let c = -1;
    for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, draw) {
  const px = Buffer.alloc(size * size * 4);
  const set = (x, y, [r, g, b, a = 255]) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  };
  draw(set, size);

  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // no filter
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const BG = [20, 24, 31];
const TRACK = [38, 44, 55];
const GREEN = [34, 210, 106];
const WHITE = [255, 255, 255];

const roundedRect = (set, x0, y0, x1, y1, r, color) => {
  for (let y = Math.floor(y0); y < y1; y++) {
    for (let x = Math.floor(x0); x < x1; x++) {
      const dx = Math.max(x0 + r - x, 0, x - (x1 - r));
      const dy = Math.max(y0 + r - y, 0, y - (y1 - r));
      if (dx * dx + dy * dy <= r * r) set(x, y, color);
    }
  }
};

const circle = (set, cx, cy, r, color) => {
  for (let y = Math.floor(cy - r); y <= cy + r; y++) {
    for (let x = Math.floor(cx - r); x <= cx + r; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) set(x, y, color);
    }
  }
};

function draw(set, S) {
  const u = S / 512;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) set(x, y, BG);
  // three stat bars, the last one cleared and green
  const rows = [[150, 0.42, TRACK], [256, 0.62, TRACK], [362, 0.78, GREEN]];
  for (const [cy, frac, color] of rows) {
    const y0 = (cy - 16) * u, y1 = (cy + 16) * u;
    roundedRect(set, 70 * u, y0, 442 * u, y1, 16 * u, TRACK);
    roundedRect(set, 70 * u, y0, (70 + (442 - 70) * frac) * u, y1, 16 * u, color === TRACK ? [75, 116, 255] : GREEN);
    circle(set, (70 + (442 - 70) * frac) * u, cy * u, 26 * u, WHITE);
  }
}

mkdirSync(new URL('../public/icons/', import.meta.url), { recursive: true });
for (const size of [192, 512]) {
  const out = new URL(`../public/icons/icon-${size}.png`, import.meta.url);
  writeFileSync(out, png(size, draw));
  console.log('wrote', out.pathname);
}
