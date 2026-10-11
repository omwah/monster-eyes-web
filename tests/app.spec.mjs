// End-to-end checks of the three builds in dist/, opened the way their users
// will: straight from disk over file://, and the web build over http too.
//
// Most features are checked on the simple build, which has every eye built
// in. Importing is checked on the web build, which has built-in eyes and
// importing both, and on the customizable build, which starts with none.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { ROOT, readPng } from './lib/node-env.mjs';

const SIMPLE = 'file://' + path.join(ROOT, 'dist/monster-eyes-simple.html');
const CUSTOMIZABLE = 'file://' + path.join(ROOT, 'dist/monster-eyes-customizable.html');
const WEB_DIR = path.join(ROOT, 'dist/web');
const WEB = 'file://' + path.join(WEB_DIR, 'index.html');
const PAGE = SIMPLE;
const app = (page, expr) => page.evaluate(new Function('return (' + expr + ')'));

async function open(page, errors = [], url = PAGE) {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(url);
  await page.waitForFunction(() => window.monsterEyesApp && monsterEyesApp.renderer);
  return errors;
}

// What is on screen, as a viewer would see it (controls hidden first).
async function snapshot(page) {
  await page.evaluate(() => document.body.classList.add('idle'));
  await page.waitForTimeout(450);
  const shot = readPng(await page.screenshot());
  return (x, y) => shot.at(Math.round(x), Math.round(y));
}

test.beforeAll(() => {
  for (const f of ['dist/monster-eyes-simple.html', 'dist/monster-eyes-customizable.html', 'dist/web/index.html'])
    if (!fs.existsSync(path.join(ROOT, f))) throw new Error('Run python3 tools/build.py first');
});

test('opens from file:// and draws every bundled package as circles on black', async ({ page }) => {
  const errors = await open(page);
  const n = await app(page, 'monsterEyesApp.packageCount');
  expect(n).toBe(26);
  const BLACK = [0, 0, 0];
  const dark = (p) => p.every((v) => v <= 8);
  for (let i = 0; i < n; i++) {
    // Hold the eye still, looking ahead with its lids open: a lid that
    // tracks a downward glance, or a blink, can legitimately cover it.
    await page.evaluate((i) => {
      monsterEyesApp.select(i);
      const r = monsterEyesApp.renderer;
      r.autoBlink = false;
      r.autoGaze = false;
      r.setScreenGaze(0, 0);
      for (const E of r.eye) { E.blinkState = 0; E.blinkFactor = 0; }
    }, i);
    await page.waitForTimeout(250);
    const info = await page.evaluate(() => {
      const r = monsterEyesApp.renderer;
      return { key: monsterEyesApp.packageKey, warnings: r.warnings, rects: monsterEyesApp.layout() };
    });
    const pixel = await snapshot(page);
    // The window is black everywhere outside the eyes.
    for (const [x, y] of [[2, 2], [1277, 2], [2, 717], [1277, 717]])
      expect(pixel(x, y), `${info.key} corner ${x},${y}`).toEqual(BLACK);
    const inAnyEye = (x, y) => info.rects.some((r) => Math.hypot(x - r.x, y - r.y) <= r.radius + 2);
    for (const r of info.rects)
      for (let a = 0; a < 8; a++) {
        const x = r.x + Math.cos((a * Math.PI) / 4) * (r.radius + 6);
        const y = r.y + Math.sin((a * Math.PI) / 4) * (r.radius + 6);
        if (x < 0 || y < 0 || x > 1279 || y > 719 || inAnyEye(x, y)) continue;
        expect(dark(pixel(x, y)), `${info.key} just outside the circle at ${a * 45} degrees`).toBe(true);
      }
    // And the eyes themselves are not just black.
    let lit = 0;
    for (const r of info.rects)
      for (let j = -3; j <= 3; j++)
        for (let k = -3; k <= 3; k++) {
          const x = r.x + (k * r.radius) / 4, y = r.y + (j * r.radius) / 4;
          if (Math.hypot(x - r.x, y - r.y) < r.radius - 2 && !dark(pixel(x, y))) lit++;
        }
    expect(lit, `${info.key} draws something`).toBeGreaterThan(3);
    expect(info.warnings, info.key).toEqual([]);
  }
  expect(errors).toEqual([]);
});

test('the eyeball is drawn whole, not cut off at the sides of its square', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    monsterEyesApp.select(monsterEyesApp.indexOf('anime'));
    const r = monsterEyesApp.renderer;
    r.autoBlink = false;
    r.autoGaze = false;
    r.setScreenGaze(0, 0);
    for (const E of r.eye) { E.blinkState = 0; E.blinkFactor = 0; }
  });
  await page.waitForTimeout(300);
  const rects = await app(page, 'monsterEyesApp.layout()');
  const pixel = await snapshot(page);
  for (const r of rects) {
    // The eyeball reaches past the edge of the square it is laid out in.
    expect(r.radius).toBeGreaterThan(r.size / 2);
    for (const side of [-1, 1]) {
      const inside = pixel(r.x + side * (r.radius - 4), r.y);
      const outside = pixel(r.x + side * (r.radius + 4), r.y);
      expect(inside.some((v) => v > 8), `side ${side} inside the ball`).toBe(true);
      expect(outside.every((v) => v <= 8), `side ${side} past the ball`).toBe(true);
    }
  }
});

test('eye count: Auto follows the package, 1 and 2 override it', async ({ page }) => {
  await open(page);
  const idx = (id) => page.evaluate((id) => monsterEyesApp.indexOf(id), id);
  const sauron = await idx('sauron'), deer = await idx('deer');
  await page.evaluate((i) => monsterEyesApp.select(i), sauron);
  expect(await app(page, 'monsterEyesApp.renderer.numEyes')).toBe(1);
  await page.click('#count-2');
  expect(await app(page, 'monsterEyesApp.renderer.numEyes')).toBe(2);
  await page.click('#count-auto');
  expect(await app(page, 'monsterEyesApp.renderer.numEyes')).toBe(1);
  await page.evaluate((i) => monsterEyesApp.select(i), deer);
  expect(await app(page, 'monsterEyesApp.renderer.numEyes')).toBe(2);
  await page.keyboard.press('1');
  expect(await app(page, 'monsterEyesApp.renderer.numEyes')).toBe(1);
  // Remembered across a reload.
  await page.reload();
  await page.waitForFunction(() => window.monsterEyesApp && monsterEyesApp.renderer);
  expect(await app(page, 'monsterEyesApp.renderer.numEyes')).toBe(1);
  expect(await app(page, 'monsterEyesApp.packageKey')).toBe('bundled:deer');
});

test('arrow keys step through packages', async ({ page }) => {
  await open(page);
  const first = await app(page, 'monsterEyesApp.packageKey');
  await page.keyboard.press('ArrowRight');
  const second = await app(page, 'monsterEyesApp.packageKey');
  expect(second).not.toBe(first);
  await page.keyboard.press('ArrowLeft');
  expect(await app(page, 'monsterEyesApp.packageKey')).toBe(first);
});

test('the eyes follow the pointer, and converge on a point between them', async ({ page }) => {
  await open(page);
  await page.click('#count-2');
  const rects = await app(page, 'monsterEyesApp.layout()');
  const gaze = () => app(page, 'monsterEyesApp.renderer.screenGaze()');
  await page.mouse.move(1270, 360);
  await page.mouse.move(1275, 360);
  await expect.poll(async () => (await gaze()).x, { timeout: 3000 }).toBeGreaterThan(0.5);
  await page.mouse.move(640, 5);
  await expect.poll(async () => (await gaze()).y, { timeout: 3000 }).toBeGreaterThan(0.3);
  // Pointer between the eyes: the left eye looks right, the right eye left.
  // (Map space is mirrored, so rightward is negative there.)
  await page.mouse.move((rects[0].x + rects[1].x) / 2, rects[0].y);
  await expect.poll(() => app(page, '[...monsterEyesApp.renderer.convergeX]'), { timeout: 3000 })
    .toEqual([expect.any(Number), expect.any(Number)]);
  await expect.poll(async () => {
    const c = await app(page, '[...monsterEyesApp.renderer.convergeX]');
    return c[0] < 0 && c[1] > 0;
  }, { timeout: 3000 }).toBe(true);
});

test('controls and cursor hide when idle and come back on movement', async ({ page }) => {
  await open(page);
  await page.mouse.move(100, 100);
  await expect(page.locator('body')).not.toHaveClass(/idle/);
  await page.waitForTimeout(3600);
  await expect(page.locator('body')).toHaveClass(/idle/);
  expect(await page.evaluate(() => getComputedStyle(document.getElementById('stage')).cursor)).toBe('none');
  expect(Number(await page.evaluate(() => getComputedStyle(document.getElementById('bar')).opacity))).toBeLessThan(0.05);
  await page.mouse.move(200, 200);
  await expect(page.locator('body')).not.toHaveClass(/idle/);
});

test('dragging moves the pair; separate mode or shift moves one eye; a click blinks', async ({ page }) => {
  await open(page);
  await page.click('#count-2');
  const before = await app(page, 'monsterEyesApp.layout()');
  const drag = async (from, dx, dy, shift) => {
    await page.mouse.move(from.x, from.y);
    if (shift) await page.keyboard.down('Shift');
    await page.mouse.down();
    await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 4 });
    await page.mouse.move(from.x + dx, from.y + dy, { steps: 4 });
    await page.mouse.up();
    if (shift) await page.keyboard.up('Shift');
  };
  await drag(before[0], -60, 40);
  const moved = await app(page, 'monsterEyesApp.layout()');
  for (let e = 0; e < 2; e++) {
    expect(moved[e].x - before[e].x).toBeCloseTo(-60, 0);
    expect(moved[e].y - before[e].y).toBeCloseTo(40, 0);
  }
  await drag(moved[1], 50, 0, true);
  const one = await app(page, 'monsterEyesApp.layout()');
  expect(one[0].x).toBeCloseTo(moved[0].x, 0);
  expect(one[1].x - moved[1].x).toBeCloseTo(50, 0);
  // Survives a reload, then Fit puts it back.
  await page.reload();
  await page.waitForFunction(() => window.monsterEyesApp && monsterEyesApp.renderer);
  const kept = await app(page, 'monsterEyesApp.layout()');
  expect(kept[1].x).toBeCloseTo(one[1].x, 0);
  await page.keyboard.press('0');
  const fitted = await app(page, 'monsterEyesApp.layout()');
  expect(fitted[0].x).toBeCloseTo(before[0].x, 0);
  // A click with no drag blinks.
  const blinks = await app(page, 'monsterEyesApp.blinkCount');
  await page.mouse.click(fitted[0].x, fitted[0].y);
  expect(await app(page, 'monsterEyesApp.blinkCount')).toBe(blinks + 1);
});

test('size: wheel, + and - scale the eyes, and the render size follows', async ({ page }) => {
  await open(page);
  await page.setViewportSize({ width: 800, height: 450 });
  await page.waitForTimeout(500);
  const a = await app(page, 'monsterEyesApp.layout()[0].size');
  const ra = await app(page, 'monsterEyesApp.renderer.size');
  await page.mouse.move(400, 225);
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(600);
  const b = await app(page, 'monsterEyesApp.layout()[0].size');
  expect(b).toBeGreaterThan(a * 1.3);
  expect(await app(page, 'monsterEyesApp.renderer.size')).toBeGreaterThan(ra);
  await page.keyboard.press('-');
  expect(await app(page, 'monsterEyesApp.layout()[0].size')).toBeLessThan(b);
});

test('keeps the screen awake', async ({ page }) => {
  await open(page);
  await page.mouse.click(5, 5);
  await page.waitForTimeout(300);
  expect(await app(page, 'monsterEyesApp.wakeLocked')).toBe(true);
});

test('Add eyes… takes a single package folder or a folder of them', async ({ page }) => {
  await open(page, [], WEB);
  await page.setInputFiles('#folder', path.join(ROOT, 'eyes/deer'));
  await page.waitForFunction(() => monsterEyesApp.packageKey === 'added:deer');
  expect(await app(page, 'monsterEyesApp.packageCount')).toBe(27);
  expect(await app(page, 'monsterEyesApp.renderer.warnings')).toEqual([]);
  await page.setInputFiles('#folder', path.join(ROOT, 'eyes'));
  await page.waitForFunction(() => monsterEyesApp.packageCount === 52);
  // Imported eyes carry a * next to the built-in ones of the same name.
  const names = await app(page, 'monsterEyesApp.names()');
  const added = names.filter((n) => n.key.startsWith('added:'));
  expect(added.length).toBe(26);
  expect(added.every((n) => n.name.endsWith(' *'))).toBe(true);
  expect(names.filter((n) => n.key.startsWith('bundled:')).some((n) => n.name.endsWith('*'))).toBe(false);
});

test('performance: two eyes at 1920x1080 hold 60 fps', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await open(page);
  await page.click('#count-2');
  await page.waitForTimeout(1500);
  // Time the app's own frames, and separately the renderer's pixel work.
  const result = await page.evaluate(() => new Promise((resolve) => {
    const times = [];
    let last = 0;
    const end = performance.now() + 5000;
    function tick(ts) {
      if (last) times.push(ts - last);
      last = ts;
      if (ts < end) requestAnimationFrame(tick);
      else {
        const r = monsterEyesApp.renderer, work = [];
        for (let i = 0; i < 120; i++) {
          const t0 = performance.now();
          r.update(ts * 1000 + i * 16667); r.draw();
          work.push(performance.now() - t0);
        }
        const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
        resolve({ medianFrame: med(times), p95Frame: times.slice().sort((x, y) => x - y)[Math.floor(times.length * 0.95)],
                  medianRender: med(work), size: r.size, frames: times.length });
      }
    }
    requestAnimationFrame(tick);
  }));
  console.log('performance', JSON.stringify(result));
  test.info().annotations.push({ type: 'performance', description: JSON.stringify(result) });
  expect(result.medianRender).toBeLessThan(8);
  expect(result.medianFrame).toBeLessThan(17.5);
});

test('slow rendering does not progressively lower eye resolution', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await open(page);
  await page.evaluate(() => {
    const r = monsterEyesApp.renderer;
    const draw = r.draw.bind(r);
    r.draw = (...args) => {
      draw(...args);
      const end = performance.now() + 12;
      while (performance.now() < end) {} // Simulate a consistently slow renderer.
    };
  });
  const original = await app(page, 'monsterEyesApp.renderer.size');
  await page.evaluate(() => new Promise((resolve) => {
    let frames = 0;
    const tick = () => ++frames >= 110 ? resolve() : requestAnimationFrame(tick);
    requestAnimationFrame(tick);
  }));
  expect(await app(page, 'monsterEyesApp.renderer.size')).toBe(original);
});

test('a rebuilt eye is drawn before it is shown, and does not blink', async ({ page }) => {
  await open(page);
  const anime = await page.evaluate(() => monsterEyesApp.indexOf('anime'));
  await page.evaluate((i) => monsterEyesApp.select(i), anime);
  await page.waitForTimeout(500); // Past the blink a freshly chosen eye opens with
  // Rebuilding in place, as resizing does. Read the
  // new canvases synchronously, before the browser has had a frame.
  const res = await page.evaluate(() => {
    const r0 = monsterEyesApp.renderer;
    r0.eye.forEach((E) => { E.blinkState = 0; E.blinkFactor = 0; });
    monsterEyesApp.select(monsterEyesApp.indexOf('anime'));
    const c = document.querySelector('#stage canvas');
    return { corner: Array.from(c.getContext('2d').getImageData(1, 1, 1, 1).data.slice(0, 3)),
             bg: monsterEyesApp.background, replaced: monsterEyesApp.renderer !== r0,
             blinking: monsterEyesApp.renderer.eye.some((E) => E.blinkState) };
  });
  expect(res.replaced).toBe(true);
  expect(res.corner).toEqual(res.bg.match(/\d+/g).map(Number)); // Lid colour, not black
  expect(res.blinking).toBe(false);
});

test('black lids are see-through, so overlapping eyes show through each other; coloured lids are not', async ({ page }) => {
  await open(page);
  const probe = (name) => page.evaluate((name) => {
    monsterEyesApp.select(monsterEyesApp.indexOf(name));
    const r = monsterEyesApp.renderer;
    r.eye.forEach((E) => { E.blinkState = 0; E.blinkFactor = 0; });
    const c = document.querySelector('#stage canvas');
    const W = c.width, ctx = c.getContext('2d');
    // Just inside the circle at the top, which is lid; and the eye's centre.
    const lid = ctx.getImageData(W >> 1, Math.round(W / 2 - r.circleRadius + 3), 1, 1).data[3];
    const middle = ctx.getImageData(W >> 1, W >> 1, 1, 1).data[3];
    return { clear: r.clearLids, lid, middle };
  }, name);
  // Dragon's lids are 0x0001, black near enough.
  expect(await probe('dragon')).toEqual({ clear: true, lid: 0, middle: 255 });
  expect(await probe('pomni')).toEqual({ clear: false, lid: 255, middle: 255 });
});

test('the FPS overlay toggles, stays up with the controls hidden, and is remembered', async ({ page }) => {
  await open(page);
  const fps = page.locator('#fps');
  await expect(fps).toBeHidden();
  await page.click('#fps-toggle');
  await expect(fps).toBeVisible();
  await expect(fps).toContainText(/\d+ fps/);
  await expect(fps).toContainText(/eyes drawn in [\d.]+ ms/);
  await page.evaluate(() => document.body.classList.add('idle'));
  await expect(fps).toBeVisible();
  await page.reload();
  await page.waitForFunction(() => window.monsterEyesApp && monsterEyesApp.renderer);
  await expect(fps).toBeVisible();
  await page.keyboard.press('i');
  await expect(fps).toBeHidden();
});

// Packages whose config names lids in another folder: "../lids/upper.bmp"
// beside the packages, or Adafruit's "donor/upper.bmp" from another package.
const FIXTURE = path.join(ROOT, 'tests/fixtures/shared-eyes');

test('lids kept in another folder are bundled with the package that uses them', async ({ page }) => {
  const out = path.join(ROOT, 'build/fixture.html');
  execFileSync('python3', [path.join(ROOT, 'tools/build.py'), '--target', 'simple', '--eyes', FIXTURE, '--out', out], { stdio: 'pipe' });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('file://' + out);
  await page.waitForFunction(() => window.monsterEyesApp && monsterEyesApp.renderer);
  const result = await page.evaluate(() => {
    const out = {};
    for (let i = 0; i < monsterEyesApp.packageCount; i++) {
      monsterEyesApp.select(i);
      const r = monsterEyesApp.renderer;
      out[monsterEyesApp.packageKey] = { warnings: r.warnings, hasLids: r.hasLids };
    }
    return out;
  });
  for (const id of ['shared_lids', 'borrower', 'donor'])
    expect(result['bundled:' + id], id).toEqual({ warnings: [], hasLids: true });
  expect(errors).toEqual([]);
});

test('Add eyes… finds lids in a folder beside the eyes, and says when they are missing', async ({ page }) => {
  await open(page, [], WEB);
  await page.setInputFiles('#folder', FIXTURE);
  await page.waitForFunction(() => monsterEyesApp.packageCount === 29);
  for (const id of ['shared_lids', 'borrower']) {
    const r = await page.evaluate((id) => {
      monsterEyesApp.select(monsterEyesApp.indexOf(id));
      return { key: monsterEyesApp.packageKey, warnings: monsterEyesApp.renderer.warnings, hasLids: monsterEyesApp.renderer.hasLids };
    }, id);
    expect(r, id).toEqual({ key: 'added:' + id, warnings: [], hasLids: true });
  }
  // Only the package folder: its lids are not in what was picked.
  await page.setInputFiles('#folder', path.join(FIXTURE, 'shared_lids'));
  await expect(page.locator('#toast')).toContainText('Missing files');
  await expect(page.locator('#toast')).toContainText('../lids/upper.bmp');
});

test('eyes resize independently; Center keeps sizes, Fit resets them', async ({ page }) => {
  await open(page);
  await page.click('#count-2');
  const layout = () => app(page, 'monsterEyesApp.layout()');
  const fitted = await layout();
  // Adjusting separately: the wheel over an eye resizes only that eye.
  await page.keyboard.press('s');
  await page.mouse.move(fitted[1].x, fitted[1].y);
  await page.mouse.wheel(0, -300);
  let now = await layout();
  expect(now[1].size).toBeGreaterThan(fitted[1].size * 1.3);
  expect(now[0].size).toBeCloseTo(fitted[0].size, 1);
  // The ring marks that eye while the controls show.
  await expect(page.locator('#ring')).toBeVisible();
  // + and - act on the same eye.
  const before = now;
  await page.keyboard.press('-');
  now = await layout();
  expect(now[1].size).toBeLessThan(before[1].size);
  expect(now[0].size).toBeCloseTo(before[0].size, 1);
  // Together again: the wheel resizes both.
  await page.keyboard.press('s');
  await expect(page.locator('#ring')).toBeHidden();
  const both = await layout();
  await page.mouse.wheel(0, 300);
  now = await layout();
  expect(now[0].size).toBeLessThan(both[0].size);
  expect(now[1].size).toBeLessThan(both[1].size);
  // Move the pair away, then Center: back in the middle, sizes kept.
  const sizes = now.map((r) => r.size);
  await page.mouse.move(now[0].x, now[0].y);
  await page.mouse.down();
  await page.mouse.move(now[0].x - 80, now[0].y + 60, { steps: 5 });
  await page.mouse.up();
  await page.click('#center');
  now = await layout();
  expect(now.map((r) => r.size)).toEqual(sizes);
  expect((now[0].x + now[1].x) / 2).toBeCloseTo(640, 0);
  expect(now[0].y).toBeCloseTo(360, 0);
  // Fit: fitted sizes and positions.
  await page.keyboard.press('0');
  now = await layout();
  for (let e = 0; e < 2; e++) {
    expect(now[e].size).toBeCloseTo(fitted[e].size, 1);
    expect(now[e].x).toBeCloseTo(fitted[e].x, 1);
  }
});

test('a layout saved by an earlier version, with one size for both eyes, still loads', async ({ page }) => {
  await open(page);
  const fitted = await app(page, 'monsterEyesApp.layout()');
  await page.evaluate(() => {
    const p = JSON.parse(localStorage.getItem('monsterEyes.v1') || '{}');
    p.eyes = 2;
    p.layouts = { 1: { scale: 1, off: [[0, 0], [0, 0]] }, 2: { scale: 0.5, off: [[0, 0], [0, 0]] } };
    localStorage.setItem('monsterEyes.v1', JSON.stringify(p));
  });
  await page.reload();
  await page.waitForFunction(() => window.monsterEyesApp && monsterEyesApp.renderer);
  const now = await app(page, 'monsterEyesApp.layout()');
  expect(now[0].size).toBeCloseTo(fitted[0].size * 0.5, 1);
  expect(now[1].size).toBeCloseTo(fitted[1].size * 0.5, 1);
});

test('the eye picker: unchecked eyes are skipped by ◀ ▶, at least one stays checked', async ({ page }) => {
  await open(page);
  const key = () => app(page, 'monsterEyesApp.packageKey');
  const included = async () => (await app(page, 'monsterEyesApp.names()')).filter((n) => n.included).length;
  await page.click('#pkg');
  await expect(page.locator('#picker')).toBeVisible();
  await expect(page.locator('.pick-row')).toHaveCount(26);
  await expect(page.locator('.pick-row.current .pick-name')).toHaveText('Anime');
  await expect(page.locator('#pkg-name')).toHaveText('Anime');
  // Uncheck the next two eyes; ▶ goes past them.
  await page.locator('.pick-row').nth(1).locator('input').uncheck();
  await page.locator('.pick-row').nth(2).locator('input').uncheck();
  expect(await included()).toBe(24);
  await expect(page.locator('#pick-count')).toHaveText('24 of 26 in rotation');
  const third = await page.evaluate(() => monsterEyesApp.names()[3].key);
  await page.click('#next');
  expect(await key()).toBe(third);
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowLeft');
  expect(await key()).toBe('bundled:anime');
  // Clicking an unchecked eye's name still shows it.
  await page.click('#pkg');
  await page.locator('.pick-row').nth(1).locator('.pick-name').click();
  expect(await key()).toBe(await page.evaluate(() => monsterEyesApp.names()[1].key));
  // None leaves just the eye showing; it can't be unchecked.
  await page.click('#pick-none');
  expect(await included()).toBe(1);
  const only = page.locator('.pick-row.current input');
  await expect(only).toBeChecked();
  await only.click();
  await expect(only).toBeChecked();
  await expect(page.locator('#toast')).toContainText('At least one eye');
  // Keyboard in the list: ↓ then Space checks the next eye.
  await page.locator('.pick-row.current .pick-name').focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press(' ');
  expect(await included()).toBe(2);
  // The controls stay up while the picker is open.
  await page.waitForTimeout(3600);
  await expect(page.locator('body')).not.toHaveClass(/idle/);
  await page.click('#pick-all');
  expect(await included()).toBe(26);
  await page.locator('.pick-row').nth(5).locator('input').uncheck();
  // Remembered.
  await page.reload();
  await page.waitForFunction(() => window.monsterEyesApp && monsterEyesApp.renderer);
  expect(await included()).toBe(25);
});

test('slideshow: the eyes blink across to the next after the interval; Always stays put', async ({ page }) => {
  await open(page);
  const key = () => app(page, 'monsterEyesApp.packageKey');
  await page.click('#pkg');
  await page.click('[data-interval="30"]');
  await expect(page.locator('#pkg-badge')).toHaveText('▶ 30 s');
  await page.keyboard.press('Escape');
  const first = await key();
  const second = await page.evaluate((k) => {
    const n = monsterEyesApp.names();
    return n[n.findIndex((x) => x.key === k) + 1].key;
  }, first);
  // 29 s in: nothing yet.
  await page.evaluate(() => monsterEyesApp.slideshowSkip(29000));
  await page.waitForTimeout(300);
  expect(await key()).toBe(first);
  // Past 30 s: watch the change frame by frame in the page. The outgoing
  // eyes close, the swap happens as they meet, and the new eyes start shut.
  const seen = await page.evaluate(() => new Promise((resolve) => {
    const first = monsterEyesApp.packageKey;
    let closed = 0;
    monsterEyesApp.slideshowSkip(1500);
    const end = performance.now() + 3000;
    (function tick() {
      const r = monsterEyesApp.renderer;
      if (monsterEyesApp.packageKey === first) closed = Math.max(closed, r.eye[0].blinkFactor);
      else return resolve({ closed, opening: r.eye[0].blinkFactor, key: monsterEyesApp.packageKey });
      if (performance.now() < end) requestAnimationFrame(tick);
      else resolve({ closed, opening: null, key: first });
    })();
  }));
  expect(seen.key).toBe(second);
  expect(seen.closed).toBeGreaterThan(0.85);
  expect(seen.opening).toBeGreaterThan(0.8);
  // Always: no change however long it has been.
  await page.click('#pkg');
  await page.click('[data-interval="0"]');
  await page.keyboard.press('Escape');
  await expect(page.locator('#pkg-badge')).toBeHidden();
  const held = await key();
  await page.evaluate(() => monsterEyesApp.slideshowSkip(600000));
  await page.waitForTimeout(500);
  expect(await key()).toBe(held);
});

test('slideshow: random order never repeats an eye straight away and skips unchecked ones', async ({ page }) => {
  await open(page);
  await page.click('#pkg');
  await page.click('[data-order="random"]');
  await page.locator('.pick-row').nth(3).locator('input').uncheck();
  await page.locator('.pick-row').nth(7).locator('input').uncheck();
  const names = await app(page, 'monsterEyesApp.names()');
  const seq = await page.evaluate(() => {
    const out = [];
    let from = 0;
    for (let i = 0; i < 100; i++) out.push((from = monsterEyesApp.nextSlide(from)));
    return out;
  });
  for (let i = 1; i < seq.length; i++) expect(seq[i]).not.toBe(seq[i - 1]);
  expect(seq).not.toContain(3);
  expect(seq).not.toContain(7);
  // The first round shows every other checked eye once before any repeats.
  const firstRound = seq.slice(0, 23);
  expect(new Set(firstRound).size).toBe(23);
  expect(new Set(seq).size).toBe(names.length - 2);
  // Remembered.
  await page.reload();
  await page.waitForFunction(() => window.monsterEyesApp && monsterEyesApp.renderer);
  await page.click('#pkg');
  await expect(page.locator('[data-order="random"]')).toHaveAttribute('aria-pressed', 'true');
});

test('slideshow: eyes without lids fade through black instead', async ({ page }) => {
  await open(page);
  await page.evaluate(() => monsterEyesApp.select(monsterEyesApp.indexOf('sauron')));
  expect(await app(page, 'monsterEyesApp.renderer.hasLids')).toBe(false);
  await page.click('#pkg');
  await page.click('[data-interval="30"]');
  await page.keyboard.press('Escape');
  const seen = await page.evaluate(() => new Promise((resolve) => {
    const first = monsterEyesApp.packageKey, stage = document.getElementById('stage');
    let lowest = 1;
    monsterEyesApp.slideshowSkip(31000);
    const end = performance.now() + 3000;
    (function tick() {
      lowest = Math.min(lowest, Number(stage.style.opacity || 1));
      const done = monsterEyesApp.packageKey !== first && !monsterEyesApp.transitioning;
      if (done || performance.now() > end)
        return resolve({ lowest, changed: monsterEyesApp.packageKey !== first, opacity: stage.style.opacity });
      requestAnimationFrame(tick);
    })();
  }));
  expect(seen.changed).toBe(true);
  expect(seen.lowest).toBeLessThan(0.2);
  expect(seen.opacity).toBe('');
});

test('Auto-blink toggles blinking on its own; Space still blinks; no lids, no toggle', async ({ page }) => {
  await open(page);
  const blink = page.locator('#blink');
  await expect(blink).toHaveAttribute('aria-pressed', 'true');
  // Off: the eyes never start a blink on their own, even when one is due.
  await blink.click();
  await expect(blink).toHaveAttribute('aria-pressed', 'false');
  const blinked = await page.evaluate(() => new Promise((resolve) => {
    const r = monsterEyesApp.renderer;
    r.timeToNextBlink = 0; // Due now, if it were allowed
    let any = false;
    const end = performance.now() + 1500;
    (function tick() {
      if (r.eye.some((E) => E.blinkState)) any = true;
      if (performance.now() < end) requestAnimationFrame(tick);
      else resolve(any);
    })();
  }));
  expect(blinked).toBe(false);
  // Space blinks once regardless.
  const before = await app(page, 'monsterEyesApp.blinkCount');
  await page.keyboard.press(' ');
  expect(await app(page, 'monsterEyesApp.blinkCount')).toBe(before + 1);
  // Remembered, and B turns it back on.
  await page.reload();
  await page.waitForFunction(() => window.monsterEyesApp && monsterEyesApp.renderer);
  await expect(blink).toHaveAttribute('aria-pressed', 'false');
  expect(await app(page, 'monsterEyesApp.renderer.autoBlink')).toBe(false);
  await page.keyboard.press('b');
  await expect(blink).toHaveAttribute('aria-pressed', 'true');
  expect(await app(page, 'monsterEyesApp.renderer.autoBlink')).toBe(true);
  // An eye with no lids: the toggle is greyed out and says why.
  await page.evaluate(() => monsterEyesApp.select(monsterEyesApp.indexOf('sauron')));
  await expect(blink).toBeDisabled();
  await expect(blink).toHaveAttribute('title', /no eyelids/);
  // A package that doesn't blink on its own stays that way with the toggle on.
  await page.evaluate(() => monsterEyesApp.select(monsterEyesApp.indexOf('pomni')));
  await expect(blink).toBeEnabled();
  expect(await app(page, 'monsterEyesApp.renderer.autoBlink')).toBe(false);
});

// ---------------------------------------------------------------------------
//  The three builds
// ---------------------------------------------------------------------------

test('simple: every eye built in, and no way to import', async ({ page }) => {
  const errors = await open(page);
  expect(await app(page, 'monsterEyesApp.variant')).toBe('simple');
  expect(await app(page, 'monsterEyesApp.readyCount')).toBe(26);
  for (const id of ['#add', '#folder', '#drop', '#empty-add']) await expect(page.locator(id)).toHaveCount(0);
  // Dragging files over the page does nothing.
  await page.evaluate(() => window.dispatchEvent(new DragEvent('dragenter', { bubbles: true })));
  await expect(page.locator('body')).not.toHaveClass(/dropping/);
  expect(errors).toEqual([]);
});

test('customizable: starts empty, imports eyes, keeps them, and can remove one', async ({ page }) => {
  expect(fs.statSync(path.join(ROOT, 'dist/monster-eyes-customizable.html')).size).toBeLessThan(200 * 1024);
  expect(fs.readFileSync(path.join(ROOT, 'dist/monster-eyes-customizable.html'), 'utf8')).not.toContain('MONSTER_EYES_BUNDLE =');
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(CUSTOMIZABLE);
  await expect(page.locator('#empty')).toBeVisible();
  expect(await app(page, 'monsterEyesApp.packageCount')).toBe(0);
  // The controls stay up while there is nothing to show.
  await page.waitForTimeout(3600);
  await expect(page.locator('body')).not.toHaveClass(/idle/);
  await page.setInputFiles('#folder', path.join(ROOT, 'eyes'));
  await page.waitForFunction(() => monsterEyesApp.packageCount === 26 && monsterEyesApp.renderer);
  await expect(page.locator('#empty')).toBeHidden();
  // Everything is imported, so nothing needs a * to set it apart.
  expect((await app(page, 'monsterEyesApp.names()')).some((n) => n.name.endsWith('*'))).toBe(false);
  // Kept by the browser.
  await page.reload();
  await page.waitForFunction(() => window.monsterEyesApp && monsterEyesApp.renderer);
  expect(await app(page, 'monsterEyesApp.packageCount')).toBe(26);
  // × forgets one, for good.
  page.on('dialog', (d) => d.accept());
  await page.click('#pkg');
  const doomed = await page.locator('.pick-row').nth(2).locator('.pick-name').textContent();
  await page.locator('.pick-row').nth(2).locator('.pick-remove').click();
  await expect.poll(() => app(page, 'monsterEyesApp.packageCount')).toBe(25);
  await page.waitForTimeout(500); // Let the browser's storage write finish
  await page.reload();
  await page.waitForFunction(() => window.monsterEyesApp && monsterEyesApp.renderer);
  expect(await app(page, 'monsterEyesApp.packageCount')).toBe(25);
  expect((await app(page, 'monsterEyesApp.names()')).map((n) => n.name)).not.toContain(doomed);
  expect(errors).toEqual([]);
});

test('web, from disk: every eye file loads and draws', async ({ page }) => {
  const errors = await open(page, [], WEB);
  expect(await app(page, 'monsterEyesApp.variant')).toBe('web');
  await page.waitForFunction(() => monsterEyesApp.readyCount === 26);
  expect(errors).toEqual([]);
});

test('every build shows its version, from package.json, in the eye picker', async ({ page }) => {
  const want = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  for (const url of [SIMPLE, CUSTOMIZABLE, WEB]) {
    await page.goto(url);
    await page.waitForFunction(() => window.monsterEyesApp);
    const version = await app(page, 'monsterEyesApp.version');
    // A release says just the version; any other commit adds itself to it.
    expect(version, url).toMatch(new RegExp('^' + want.replace(/\./g, '\\.') + '(\\+g[0-9a-f]{7,}(\\.dirty)?)?$'));
    await expect(page.locator('#version')).toHaveText('Monster Eyes ' + version);
  }
});

test('the release: its eyes zip adds to the customizable version as it is', async ({ page }) => {
  const RELEASE = path.join(ROOT, 'dist/release');
  test.skip(!fs.existsSync(RELEASE), 'Run python3 tools/build.py --release first');
  const names = fs.readdirSync(RELEASE);
  const sums = fs.readFileSync(path.join(RELEASE, 'SHA256SUMS'), 'utf8').trim().split('\n').map((l) => l.split('  ')[1]);
  expect(names.sort()).toEqual([...sums, 'SHA256SUMS'].sort());
  for (const kind of ['simple-', 'customizable-', 'web-', 'eyes-']) expect(sums.some((n) => n.startsWith('monster-eyes-' + kind))).toBe(true);
  // Unzipped, the folder inside is picked with Add eyes…, README and all.
  const zip = path.join(RELEASE, sums.find((n) => n.startsWith('monster-eyes-eyes-')));
  const out = fs.mkdtempSync(path.join(ROOT, 'test-results', 'eyes-zip-'));
  execFileSync('python3', ['-c', 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zip, out]);
  const [top] = fs.readdirSync(out);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(CUSTOMIZABLE);
  await page.setInputFiles('#folder', path.join(out, top));
  await page.waitForFunction(() => monsterEyesApp.packageCount === 26 && monsterEyesApp.renderer);
  expect(errors).toEqual([]);
});

// The web build over http, as the website serves it.
test.describe('web, over http', () => {
  let server, base;
  const manifest = () => {
    const html = fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8');
    return JSON.parse(html.match(/window\.MONSTER_EYES_MANIFEST = (\[.*?\]);/)[1]);
  };
  test.beforeAll(async () => {
    server = http.createServer((req, res) => {
      const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
      const file = path.join(WEB_DIR, rel);
      if (!file.startsWith(WEB_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : 'text/javascript' });
      fs.createReadStream(file).pipe(res);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = 'http://127.0.0.1:' + server.address().port + '/';
  });
  test.afterAll(() => server && server.close());

  test('the page is small and the first eye shows before the rest arrive', async ({ page }) => {
    expect(fs.statSync(path.join(WEB_DIR, 'index.html')).size).toBeLessThan(200 * 1024);
    const lead = manifest()[0].file;
    const held = [];
    await page.route('**/eyes/*.js', (route) => (route.request().url().endsWith(lead) ? route.continue() : held.push(route)));
    await page.goto(base);
    await page.waitForFunction(() => window.monsterEyesApp && monsterEyesApp.renderer);
    // Drawing, with everything else still on its way.
    expect(await app(page, 'monsterEyesApp.readyCount')).toBe(1);
    expect(held.length).toBeGreaterThan(0);
    const lit = await page.evaluate(() => {
      const c = document.querySelector('#stage canvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) return true;
      return false;
    });
    expect(lit).toBe(true);
    // Let the rest through, one by one as the page asks.
    for (const r of held) await r.continue().catch(() => {});
    await page.unroute('**/eyes/*.js');
    await page.waitForFunction(() => monsterEyesApp.readyCount === 26);
  });

  test('choosing an eye that has not arrived fetches it ahead of the rest', async ({ page }) => {
    const files = manifest();
    const lead = files[0].file, wanted = files[10];
    const held = new Map();
    await page.route('**/eyes/*.js', (route) => {
      const url = route.request().url();
      if (url.endsWith(lead)) return route.continue();
      held.set(url.slice(url.lastIndexOf('/eyes/') + 1), route);
    });
    await page.goto(base);
    await page.waitForFunction(() => window.monsterEyesApp && monsterEyesApp.renderer);
    await page.click('#pkg');
    await page.locator('.pick-row').nth(10).locator('.pick-name').click();
    await expect(page.locator('.pick-row').nth(10).locator('.pick-state')).toHaveText('loading…');
    // Still showing the first eye while it loads.
    expect(await app(page, 'monsterEyesApp.packageKey')).toBe('bundled:' + files[0].id);
    await expect.poll(() => held.has(wanted.file)).toBe(true);
    await held.get(wanted.file).continue();
    await page.waitForFunction((k) => monsterEyesApp.packageKey === k, 'bundled:' + wanted.id);
    expect(await app(page, 'monsterEyesApp.readyCount')).toBeLessThan(26);
    for (const [f, r] of held) if (f !== wanted.file) await r.continue().catch(() => {});
    await page.unroute('**/eyes/*.js');
  });

  test('an eye file that will not load is marked unavailable; the rest carry on', async ({ page }) => {
    const deer = manifest().find((m) => m.id === 'deer');
    await page.route('**/' + deer.file, (route) => route.fulfill({ status: 404, body: '' }));
    await page.goto(base);
    await page.waitForFunction(() => window.monsterEyesApp && monsterEyesApp.readyCount === 25);
    await expect.poll(async () => (await app(page, 'monsterEyesApp.names()')).find((n) => n.key === 'bundled:deer').state).toBe('failed');
    await page.click('#pkg');
    const row = page.locator('.pick-row', { hasText: 'Deer' });
    await expect(row.locator('.pick-state')).toHaveText('unavailable');
  });
});
