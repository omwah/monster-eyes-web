// Load the browser scripts into Node, and read eye packages and PNGs from disk.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function loadMonsterEyes() {
  const ctx = { TextDecoder, atob, console, Math };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of ['eyes-assets.js', 'eyes-renderer.js'])
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', f), 'utf8'), ctx, { filename: f });
  return ctx.MonsterEyes;
}

export function readPackage(dir) {
  const files = {};
  const walk = (d, rel) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name), r = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) walk(p, r);
      else files[r] = new Uint8Array(fs.readFileSync(p));
    }
  };
  walk(dir, '');
  return { id: path.basename(dir), files };
}

export function listPackages() {
  const dir = path.join(ROOT, 'eyes');
  return fs.readdirSync(dir).filter((n) => !n.startsWith('.') &&
    fs.existsSync(path.join(dir, n, 'config.eye'))).sort();
}

// Minimal PNG reader: 8-bit RGB or RGBA, any filter, no interlace.
export function readPng(file) {
  const buf = Buffer.isBuffer(file) ? file : fs.readFileSync(file);
  let p = 8, w = 0, h = 0, ct = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3, stride = w * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = new Uint8Array(w * h * bpp);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[dst + x - bpp] : 0, b = y ? px[dst + x - stride] : 0;
      const c = x >= bpp && y ? px[dst + x - stride - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[dst + x] = v & 255;
    }
  }
  const rgb565 = new Uint16Array(w * h);
  for (let i = 0; i < w * h; i++)
    rgb565[i] = ((px[i * bpp] >> 3) << 11) | ((px[i * bpp + 1] >> 2) << 5) | (px[i * bpp + 2] >> 3);
  const at = (x, y) => { const i = (y * w + x) * bpp; return [px[i], px[i + 1], px[i + 2]]; };
  return { width: w, height: h, rgb565, at };
}

// Packed 0xAABBGGRR words to RGB565.
export function wordsTo565(words) {
  const out = new Uint16Array(words.length);
  for (let i = 0; i < words.length; i++) {
    const v = words[i];
    out[i] = (((v & 255) >> 3) << 11) | ((((v >> 8) & 255) >> 2) << 5) | (((v >> 16) & 255) >> 3);
  }
  return out;
}
