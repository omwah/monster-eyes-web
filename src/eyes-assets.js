/**
 * eyes-assets.js -- everything that reads a package: config.eye and its BMPs.
 *
 * A port of Eyes_Assets.cpp from a C++ fork of Adafruit's Monster Eyes.
 * Function names follow the C++ so the two can be read side by side. Plain script, no modules: ES modules
 * do not load from file://, and this page has to work from a double-click.
 */
(function (root) {
  'use strict';

  const ME = (root.MonsterEyes = root.MonsterEyes || {});

  // ===========================================================================
  //  JSON WITH COMMENTS
  // ===========================================================================
  //
  // config.eye is parsed by ArduinoJson with comments enabled, which also
  // tolerates single-quoted strings and unquoted keys. JSON.parse does none of
  // that, and it also forgets whether a number was written as 1 or 1.0 --
  // which matters, because the renderer reads irisAngle 1 as a raw angle and
  // irisAngle 1.0 as a whole turn. So floats are kept as JFloat and integers
  // as plain numbers, which is the distinction ArduinoJson's is<int>() makes.

  class JFloat {
    constructor(value) {
      this.value = value;
    }
  }

  function parseJsonc(text) {
    let i = 0;
    const n = text.length;

    function fail(why) {
      throw new SyntaxError(why + ' at offset ' + i);
    }

    function skip() {
      for (;;) {
        while (i < n && /\s/.test(text[i])) i++;
        if (text[i] === '/' && text[i + 1] === '/') {
          while (i < n && text[i] !== '\n') i++;
        } else if (text[i] === '/' && text[i + 1] === '*') {
          const end = text.indexOf('*/', i + 2);
          if (end < 0) fail('unterminated comment');
          i = end + 2;
        } else {
          return;
        }
      }
    }

    function string() {
      const quote = text[i++];
      let out = '';
      while (i < n && text[i] !== quote) {
        let c = text[i++];
        if (c === '\\') {
          c = text[i++];
          if (c === 'n') out += '\n';
          else if (c === 't') out += '\t';
          else if (c === 'r') out += '\r';
          else if (c === 'b') out += '\b';
          else if (c === 'f') out += '\f';
          else if (c === 'u') {
            out += String.fromCharCode(parseInt(text.substr(i, 4), 16));
            i += 4;
          } else out += c;
        } else {
          out += c;
        }
      }
      if (i >= n) fail('unterminated string');
      i++;
      return out;
    }

    function bareword() {
      const start = i;
      while (i < n && /[A-Za-z0-9_$+\-.]/.test(text[i])) i++;
      return text.slice(start, i);
    }

    function value() {
      skip();
      const c = text[i];
      if (c === '{') {
        i++;
        const obj = {};
        skip();
        if (text[i] === '}') {
          i++;
          return obj;
        }
        for (;;) {
          skip();
          const key = text[i] === '"' || text[i] === "'" ? string() : bareword();
          if (!key) fail('expected a key');
          skip();
          if (text[i++] !== ':') fail('expected ":"');
          obj[key] = value();
          skip();
          if (text[i] === ',') {
            i++;
            continue;
          }
          if (text[i] === '}') {
            i++;
            return obj;
          }
          fail('expected "," or "}"');
        }
      }
      if (c === '[') {
        i++;
        const arr = [];
        skip();
        if (text[i] === ']') {
          i++;
          return arr;
        }
        for (;;) {
          arr.push(value());
          skip();
          if (text[i] === ',') {
            i++;
            continue;
          }
          if (text[i] === ']') {
            i++;
            return arr;
          }
          fail('expected "," or "]"');
        }
      }
      if (c === '"' || c === "'") return string();
      const word = bareword();
      if (word === 'true') return true;
      if (word === 'false') return false;
      if (word === 'null') return null;
      if (/^[+-]?\d+$/.test(word)) return parseInt(word, 10);
      if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(word))
        return new JFloat(parseFloat(word));
      fail('unexpected "' + (word || c) + '"');
    }

    const result = value();
    return result;
  }

  // ArduinoJson's type questions, for values out of parseJsonc().
  const isNull = (v) => v === undefined || v === null;
  const isInt = (v) => typeof v === 'number';
  const isFloat = (v) => typeof v === 'number' || v instanceof JFloat; // is<float>() takes ints too
  const isBool = (v) => typeof v === 'boolean';
  const isStr = (v) => typeof v === 'string';
  const asFloat = (v) => (v instanceof JFloat ? v.value : Number(v));
  const asInt = (v) => (v instanceof JFloat ? Math.trunc(v.value) : v | 0);
  const asBool = (v) => (isBool(v) ? v : isFloat(v) ? asFloat(v) !== 0 : false);
  // `if (v.is<bool>() || v.is<int>())`, the pattern used for every flag.
  const isFlag = (v) => isBool(v) || isInt(v);

  // strtol(s, NULL, 0): optional sign, then 0x for hex, a leading 0 for
  // octal, decimal otherwise; stops at the first character that does not fit.
  function strtol0(s) {
    let m = /^\s*([+-]?)(0[xX]([0-9a-fA-F]+)|0([0-7]*)|([1-9][0-9]*))/.exec(s || '');
    if (!m) return 0;
    let v;
    if (m[3] !== undefined) v = parseInt(m[3], 16);
    else if (m[4] !== undefined) v = m[4] ? parseInt(m[4], 8) : 0;
    else v = parseInt(m[5], 10);
    return m[1] === '-' ? -v : v;
  }

  // "Do What I Mean" decoder: 42, "0x2A", "0xF800", [255,0,0], ["0xFF",0,0],
  // [1.0,0.0,0.0]. Colours come back as RGB565, as on the device.
  function dwim(v, def = 0) {
    if (isInt(v)) return v;
    if (v instanceof JFloat) return Math.trunc(Math.fround(Math.fround(v.value) + 0.5));
    if (isStr(v)) return strtol0(v) | 0;
    if (Array.isArray(v)) {
      if (v.length >= 3) {
        const cc = [0, 0, 0];
        for (let i = 0; i < 3; i++) {
          const a = v[i];
          if (isInt(a)) cc[i] = a;
          else if (a instanceof JFloat) cc[i] = Math.trunc(Math.fround(Math.fround(a.value) * Math.fround(255.999)));
          else if (isStr(a)) cc[i] = strtol0(a);
          else cc[i] = 0;
          if (cc[i] > 255) cc[i] = 255;
          else if (cc[i] < 0) cc[i] = 0;
        }
        return ((cc[0] & 0xf8) << 8) | ((cc[1] & 0xfc) << 3) | (cc[2] >> 3);
      }
      if (v.length >= 1) {
        if (isInt(v[0])) return v[0];
        return strtol0(isStr(v[0]) ? v[0] : '') | 0;
      }
    }
    return def;
  }

  // RGB565 to 0xAABBGGRR for a little-endian Uint32 view of ImageData,
  // replicating the high bits into the low ones exactly as the simulator's
  // PNG writer does, so a parity comparison sees the same bytes.
  function rgb565to888(c) {
    const r = (c >> 11) & 31, g = (c >> 5) & 63, b = c & 31;
    return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
  }
  function pack(r, g, b) {
    return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
  }
  function pack565(c) {
    const [r, g, b] = rgb565to888(c & 0xffff);
    return pack(r, g, b);
  }

  // ===========================================================================
  //  BMP LOADING
  // ===========================================================================

  const TEX_MAX_W = 512; // Widest texture the renderer can address
  const TEX_MAX_H = 128; // Tallest texture the renderer can address

  function bmpReadHeader(bytes) {
    if (!bytes || bytes.length < 54) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes[0] !== 0x42 || bytes[1] !== 0x4d) return null; // "BM"
    const info = {};
    info.dataOffset = dv.getUint32(10, true);
    const dibSize = dv.getUint32(14, true);
    const w = dv.getInt32(18, true);
    const h = dv.getInt32(22, true);
    info.bpp = dv.getUint16(28, true);
    const compression = dv.getUint32(30, true);
    if (dibSize < 40) return null;
    if (compression !== 0) return null;
    if (info.bpp !== 1 && info.bpp !== 24) return null;
    if (w <= 0) return null;
    info.topDown = h < 0;
    info.height = info.topDown ? -h : h;
    info.width = w;
    if (info.height <= 0) return null;
    info.rowSize = Math.floor((w * info.bpp + 31) / 32) * 4;
    info.whiteIndex = 1;
    if (info.bpp === 1) {
      const p = 14 + dibSize;
      if (p + 8 > bytes.length) return null;
      const lum0 = bytes[p] + bytes[p + 1] + bytes[p + 2];
      const lum1 = bytes[p + 4] + bytes[p + 5] + bytes[p + 6];
      info.whiteIndex = lum1 > lum0 ? 1 : 0;
    }
    if (info.dataOffset + info.rowSize * info.height > bytes.length) return null;
    return info;
  }

  // Per column, the topmost and bottommost lit pixel, scaled to the eye size
  // and flipped into render space where +Y is up.
  function bmpLoadEyelid(bytes, openTable, closedTable, size, isUpper) {
    const info = bmpReadHeader(bytes);
    if (!info || info.bpp !== 1 || info.height < 2) return false;
    const init = isUpper ? size - 1 : 0;
    openTable.fill(init);
    closedTable.fill(init);
    // The device folds source columns into destination columns, which only
    // works when the eye is no wider than the bitmap. Drawn larger, as a
    // browser can, it would leave every other column without a lid, so there
    // each destination column instead interpolates between the two source
    // columns either side of it. Below the bitmap's width, the original.
    const upscale = size > info.width;
    const cols = upscale ? info.width : size;
    const minRow = new Float64Array(cols).fill(0xffff);
    const maxRow = new Float64Array(cols);
    for (let fileRow = 0; fileRow < info.height; fileRow++) {
      const base = info.dataOffset + fileRow * info.rowSize;
      const imageRow = info.topDown ? fileRow : info.height - 1 - fileRow;
      for (let sx = 0; sx < info.width; sx++) {
        const bit = (bytes[base + (sx >> 3)] >> (7 - (sx & 7))) & 1;
        if (bit !== info.whiteIndex) continue;
        let dx = upscale ? sx : Math.floor((sx * size) / info.width);
        if (dx < 0) dx = 0;
        else if (dx >= cols) dx = cols - 1;
        if (imageRow < minRow[dx]) minRow[dx] = imageRow;
        if (imageRow > maxRow[dx]) maxRow[dx] = imageRow;
      }
    }
    for (let dx = 0; dx < size; dx++) {
      let lo = minRow[dx], hi = maxRow[dx];
      if (upscale) {
        const fx = Math.max(0, ((dx + 0.5) * info.width) / size - 0.5);
        const a = Math.min(Math.floor(fx), cols - 1), b = Math.min(a + 1, cols - 1), f = fx - a;
        if (minRow[a] === 0xffff && minRow[b] === 0xffff) continue;
        if (minRow[a] === 0xffff || minRow[b] === 0xffff) {
          const s = minRow[a] === 0xffff ? b : a;
          lo = minRow[s];
          hi = maxRow[s];
        } else {
          lo = minRow[a] + (minRow[b] - minRow[a]) * f;
          hi = maxRow[a] + (maxRow[b] - maxRow[a]) * f;
        }
      } else if (lo === 0xffff) {
        continue; // No data; keep the init value
      }
      let my = Math.floor((lo * (size - 1)) / (info.height - 1));
      let My = Math.floor((hi * (size - 1)) / (info.height - 1));
      my = Math.min(Math.max(my, 0), size - 1);
      My = Math.min(Math.max(My, 0), size - 1);
      if (isUpper) {
        openTable[dx] = size - 1 - my;
        closedTable[dx] = size - 1 - My;
      } else {
        closedTable[dx] = size - 1 - my;
        openTable[dx] = size - 1 - My;
      }
    }
    return true;
  }

  // A 24-bit texture as packed RGBA words. maxBytes is the device's budget at
  // two bytes a pixel; Infinity keeps the full resolution (up to 512x128).
  // quantize565 drops the low bits as the device's RGB565 panel does.
  function bmpLoadTexture(bytes, maxBytes, quantize565) {
    const info = bmpReadHeader(bytes);
    if (!info || info.bpp !== 24) return null;
    let dw = Math.min(info.width, TEX_MAX_W);
    let dh = Math.min(info.height, TEX_MAX_H);
    while (dw * dh * 2 > maxBytes && (dw > 8 || dh > 4)) {
      if (dw * info.height > dh * info.width) {
        if (dw > 8) dw--;
        else dh--;
      } else {
        if (dh > 4) dh--;
        else dw--;
      }
    }
    if (dw * dh * 2 > maxBytes) return null;
    const data = new Uint32Array(dw * dh);
    for (let dy = 0; dy < dh; dy++) {
      const imageRow = Math.floor((dy * info.height) / dh);
      const fileRow = info.topDown ? imageRow : info.height - 1 - imageRow;
      const base = info.dataOffset + fileRow * info.rowSize;
      for (let dx = 0; dx < dw; dx++) {
        const sx = Math.floor((dx * info.width) / dw);
        const p = base + sx * 3; // Stored B, G, R
        const b = bytes[p], g = bytes[p + 1], r = bytes[p + 2];
        data[dy * dw + dx] = quantize565
          ? pack565(((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3))
          : pack(r, g, b);
      }
    }
    return { data, width: dw, height: dh };
  }

  // ===========================================================================
  //  PACKAGES
  // ===========================================================================
  //
  // A package is { id, files } where files maps a path relative to the
  // package directory to its bytes. The config sits at "config.eye", and the
  // renderer is told its device-style path, /eyes/<id>/config.eye, so asset
  // names resolve exactly as copyAssetPath() resolves them on the device.

  function configPathFor(id) {
    return '/eyes/' + id + '/config.eye';
  }

  // Resolve an asset name from config.eye against the config's directory. An
  // Adafruit config says "hazel/iris.bmp" from the drive root; inside a
  // directory already named hazel that leading component is dropped.
  function copyAssetPath(asset, configFile) {
    if (!isStr(asset) || !asset) return '';
    if (asset[0] === '/') return asset;
    const slash = configFile.lastIndexOf('/');
    const dir = slash >= 0 ? configFile.slice(0, slash) : '';
    const dirName = dir.slice(dir.lastIndexOf('/') + 1);
    const assetSlash = asset.indexOf('/');
    if (slash >= 0 && assetSlash >= 0 && asset.slice(0, assetSlash) === dirName)
      asset = asset.slice(assetSlash + 1);
    return dir + '/' + asset;
  }

  // Tidy a relative path: forward slashes, no "." segments, and ".." folded
  // into the segment before it where there is one. A ".." that climbs above
  // the start is kept, so "../lids/upper.bmp" stays as written.
  function normalizePath(path) {
    const out = [];
    for (const part of String(path).replace(/\\/g, '/').split('/')) {
      if (!part || part === '.') continue;
      if (part === '..' && out.length && out[out.length - 1] !== '..') out.pop();
      else out.push(part);
    }
    return out.join('/');
  }

  // A config asset name as the renderer will look for it, relative to the
  // package directory: what copyAssetPath() makes of it, minus the package's
  // own prefix.
  function packageRelative(asset, id) {
    const resolved = copyAssetPath(asset, configPathFor(id));
    const prefix = '/eyes/' + id + '/';
    return normalizePath(resolved.startsWith(prefix) ? resolved.slice(prefix.length) : resolved);
  }

  // Find a resolved device path among a package's files. FAT is not case
  // sensitive, so neither is this. Files a package borrows from elsewhere --
  // "../lids/upper.bmp", or another package's "demon/upper.bmp" -- were stored
  // with it under that same relative name when it was taken in, so they are
  // found the same way. Failing that, a file of the same name will do.
  function findFile(pkg, path) {
    if (!path) return null;
    const prefix = '/eyes/' + pkg.id + '/';
    const rel = normalizePath(path.startsWith(prefix) ? path.slice(prefix.length) : path).toLowerCase();
    let fallback = null;
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    for (const name of Object.keys(pkg.files)) {
      const l = normalizePath(name).toLowerCase();
      if (l === rel) return pkg.files[name];
      if (!fallback && l.slice(l.lastIndexOf('/') + 1) === base) fallback = pkg.files[name];
    }
    return fallback;
  }

  const ASSET_KEYS = ['irisTexture', 'scleraTexture', 'upperEyelid', 'lowerEyelid'];

  // Every asset name a config mentions, at the root and in its per-eye blocks.
  function configAssetRefs(config) {
    const refs = new Set();
    for (const block of [config, config && config.left, config && config.right])
      if (block && typeof block === 'object')
        for (const k of ASSET_KEYS) if (isStr(block[k]) && block[k]) refs.add(block[k]);
    return [...refs];
  }

  // Gather the files a package's config names from outside its own folder.
  //   configText  the package's config.eye
  //   id          the package's id (its directory name)
  //   pkgDir      its directory, relative to whatever the user picked ('' for
  //               the root)
  //   have        names already in the package, relative to its directory
  //   pool        Map of every picked file, path relative to the pick -> file
  // A name is tried against the package directory (so ".." works), then the
  // directory holding the packages (Adafruit's "demon/upper.bmp" style), then
  // the root of the pick. Returns { found: [{ key, file }], missing: [names] },
  // with each found file keyed by the name the renderer will look for.
  function collectExternalAssets(configText, id, pkgDir, have, pool) {
    let config;
    try {
      config = parseJsonc(decodeText(configText));
    } catch (e) {
      return { found: [], missing: [] };
    }
    const lowerPool = new Map();
    for (const [path, file] of pool) lowerPool.set(normalizePath(path).toLowerCase(), file);
    const haveLower = new Set([...have].map((n) => normalizePath(n).toLowerCase()));
    const parent = pkgDir.includes('/') ? pkgDir.slice(0, pkgDir.lastIndexOf('/')) : '';
    const found = [], missing = [];
    for (const ref of configAssetRefs(config)) {
      const rel = packageRelative(ref, id);
      if (haveLower.has(rel.toLowerCase())) continue;
      const candidates = [pkgDir ? pkgDir + '/' + rel : rel, parent ? parent + '/' + rel : rel, rel];
      const hit = candidates.map((c) => normalizePath(c).toLowerCase())
        .filter((c) => !c.startsWith('..')).find((c) => lowerPool.has(c));
      if (hit) found.push({ key: rel, file: lowerPool.get(hit) });
      else missing.push(ref);
    }
    return { found, missing };
  }

  function decodeText(bytes) {
    if (typeof bytes === 'string') return bytes;
    return new TextDecoder('utf-8').decode(bytes);
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  Object.assign(ME, {
    JFloat,
    parseJsonc,
    isNull, isInt, isFloat, isBool, isStr, isFlag, asFloat, asInt, asBool,
    strtol0,
    dwim,
    rgb565to888,
    pack,
    pack565,
    bmpReadHeader,
    bmpLoadEyelid,
    bmpLoadTexture,
    configPathFor,
    copyAssetPath,
    normalizePath,
    packageRelative,
    findFile,
    configAssetRefs,
    collectExternalAssets,
    decodeText,
    base64ToBytes,
    TEX_MAX_W,
    TEX_MAX_H,
  });
})(typeof window !== 'undefined' ? window : globalThis);
