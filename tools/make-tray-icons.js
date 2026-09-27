'use strict';
/*
 * Draws the tray icons and writes them to src/tray/.
 *
 *   node tools/make-tray-icons.js
 *
 * The output is committed, so this only runs when the marks change - but it
 * runs with no dependencies at all, which is the point. Sereno ships zero
 * runtime deps and adding an image toolchain to produce three shapes would be
 * a poor trade. tools/test.js runs this and byte-compares, so the committed
 * files cannot drift from the script that made them.
 *
 * TWO SETS, one per taskbar theme. Windows only auto-inverts template images on
 * macOS, so a single light-on-transparent set disappears on a light taskbar:
 * measured, the off-white equalizer came out at 1.02:1 against Windows 11's
 * light taskbar, which is invisible, and the other two marks were no better.
 * The suffix names the taskbar the set is FOR, not the colour of the ink.
 *
 * Everything is drawn at 4x and boxed down, which is all the antialiasing a
 * 16px glyph needs. PNG is written by hand: node:zlib does the only hard part.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT = path.join(__dirname, '..', 'src', 'tray');
const SS = 4;                                   // supersample factor

/*
 * Shape carries the state; colour only reinforces it, and amber is reserved for
 * the one state that interrupts you. Each palette is chosen to clear 3:1
 * against its own taskbar - see the contrast assertions in tools/test.js.
 */
const PALETTE = {
  dark: {                                       // for a dark taskbar
    mark: [243, 241, 235, 255],
    muted: [176, 178, 182, 255],
    accent: [231, 184, 121, 255],
    onAccent: [37, 31, 22, 255],
  },
  light: {                                      // for a light taskbar
    mark: [46, 51, 56, 255],
    muted: [90, 96, 103, 255],
    accent: [150, 85, 10, 255],
    onAccent: [255, 252, 246, 255],
  },
};

/* ---------- a very small RGBA canvas ---------- */

function canvas(size) {
  return { size, px: new Uint8ClampedArray(size * size * 4) };
}

function put(c, x, y, rgba) {
  if (x < 0 || y < 0 || x >= c.size || y >= c.size) return;
  const i = (y * c.size + x) * 4;
  c.px[i] = rgba[0]; c.px[i + 1] = rgba[1]; c.px[i + 2] = rgba[2]; c.px[i + 3] = rgba[3];
}

function disc(c, cx, cy, r, rgba) {
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) put(c, x, y, rgba);
    }
  }
}

function ring(c, cx, cy, r, w, rgba) {
  const outer = r + w / 2;
  for (let y = Math.floor(cy - outer); y <= Math.ceil(cy + outer); y++) {
    for (let x = Math.floor(cx - outer); x <= Math.ceil(cx + outer); x++) {
      if (Math.abs(Math.hypot(x - cx, y - cy) - r) <= w / 2) put(c, x, y, rgba);
    }
  }
}

function rect(c, x0, y0, w, h, rgba, radius) {
  const r = radius || 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (r) {
        const dx = Math.max(x0 + r - x, 0, x - (x0 + w - 1 - r));
        const dy = Math.max(y0 + r - y, 0, y - (y0 + h - 1 - r));
        if (dx && dy && dx * dx + dy * dy > r * r) continue;
      }
      put(c, x, y, rgba);
    }
  }
}

/* ---------- the three marks, in a 32-unit design space ---------- */

const STATES = ['needs', 'busy', 'quiet'];

function drawState(c, state, u, p) {
  const C = 16 * u;
  if (state === 'needs') {
    // A filled disc with a bang over-painted on it. The bang is what survives
    // being shrunk to 16px, and it still reads with the colour stripped away.
    disc(c, C, C, 14 * u, p.accent);
    rect(c, Math.round(13.6 * u), Math.round(7 * u),
      Math.round(4.8 * u), Math.round(11 * u), p.onAccent, 1.5 * u);
    disc(c, C, 23 * u, 2.6 * u, p.onAccent);
  } else if (state === 'busy') {
    // The equalizer: three bars of unequal height, as on a running row.
    for (const [bx, h] of [[5, 11], [13, 21], [21, 15]]) {
      rect(c, Math.round(bx * u), Math.round((26 - h) * u),
        Math.round(6 * u), Math.round(h * u), p.mark, 1.5 * u);
    }
  } else {
    ring(c, C, C, 11 * u, 3.6 * u, p.muted);
  }
}

function render(state, size, theme) {
  const p = PALETTE[theme];
  const big = canvas(size * SS);
  drawState(big, state, (size * SS) / 32, p);

  // Box downsample: crude antialiasing, entirely sufficient at this scale.
  const out = canvas(size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * big.size + (x * SS + sx)) * 4;
          const al = big.px[i + 3];
          r += big.px[i] * al; g += big.px[i + 1] * al; b += big.px[i + 2] * al; a += al;
        }
      }
      const i = (y * size + x) * 4;
      // Premultiplied average, then back out, so edges do not darken.
      out.px[i] = a ? r / a : 0;
      out.px[i + 1] = a ? g / a : 0;
      out.px[i + 2] = a ? b / a : 0;
      out.px[i + 3] = a / (SS * SS);
    }
  }
  return out;
}

/* ---------- PNG ---------- */

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return (buf) => {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(td));
  return Buffer.concat([len, td, crc]);
}

function png(c) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(c.size, 0);
  ihdr.writeUInt32BE(c.size, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 6;      // RGBA
  // 10,11,12 = compression, filter, interlace: all 0

  const stride = c.size * 4;
  const raw = Buffer.alloc((stride + 1) * c.size);
  for (let y = 0; y < c.size; y++) {
    raw[y * (stride + 1)] = 0;               // filter: none
    Buffer.from(c.px.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- api / cli ---------- */

/** "<state>-<theme>-<size>.png" - the theme names the taskbar it is FOR. */
function iconName(state, theme, size) {
  return state + '-' + theme + '-' + size + '.png';
}

function buildAll() {
  const files = new Map();
  for (const state of STATES) {
    for (const theme of Object.keys(PALETTE)) {
      for (const size of [16, 32]) {
        files.set(iconName(state, theme, size), png(render(state, size, theme)));
      }
    }
  }
  return files;
}

module.exports = { STATES, PALETTE, iconName, buildAll, render, png };

if (require.main === module) {
  fs.mkdirSync(OUT, { recursive: true });
  // Anything stale would otherwise keep shipping; the suite fails on extras.
  for (const f of fs.readdirSync(OUT)) if (f.endsWith('.png')) fs.unlinkSync(path.join(OUT, f));
  for (const [name, buf] of buildAll()) {
    fs.writeFileSync(path.join(OUT, name), buf);
    console.log('  src/tray/' + name + '  ' + buf.length + ' bytes');
  }
}
