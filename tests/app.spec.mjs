// End-to-end checks of dist/monster-eyes.html, opened the way its user will:
// straight from disk over file://.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { ROOT, readPng } from './lib/node-env.mjs';

const PAGE = 'file://' + path.join(ROOT, 'dist/monster-eyes.html');
const app = (page, expr) => page.evaluate(new Function('return (' + expr + ')'));

async function open(page, errors = []) {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(PAGE);
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
  if (!fs.existsSync(path.join(ROOT, 'dist/monster-eyes.html')))
    throw new Error('Run python3 tools/build.py first');
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
    const o = [...document.querySelectorAll('#pkg option')].find((o) => o.textContent === 'Anime');
    monsterEyesApp.select(Number(o.value));
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
  const idx = (id) => page.evaluate((id) => {
    const opts = [...document.querySelectorAll('#pkg option')];
    return Number(opts.find((o) => o.textContent.toLowerCase() === id).value);
  }, id);
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
  await open(page);
  await page.setInputFiles('#folder', path.join(ROOT, 'eyes/deer'));
  await page.waitForFunction(() => monsterEyesApp.packageKey === 'added:deer');
  expect(await app(page, 'monsterEyesApp.packageCount')).toBe(27);
  expect(await app(page, 'monsterEyesApp.renderer.warnings')).toEqual([]);
  await page.setInputFiles('#folder', path.join(ROOT, 'eyes'));
  await page.waitForFunction(() => monsterEyesApp.packageCount === 52);
  expect(await page.locator('#pkg optgroup[label="Added"] option').count()).toBe(26);
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

test('a rebuilt eye is drawn before it is shown, and does not blink', async ({ page }) => {
  await open(page);
  const anime = await page.evaluate(() =>
    Number([...document.querySelectorAll('#pkg option')].find((o) => o.textContent === 'Anime').value));
  await page.evaluate((i) => monsterEyesApp.select(i), anime);
  await page.waitForTimeout(500); // Past the blink a freshly chosen eye opens with
  // Rebuilding in place, as the resolution governor and resizing do. Read the
  // new canvases synchronously, before the browser has had a frame.
  const res = await page.evaluate(() => {
    const r0 = monsterEyesApp.renderer;
    r0.eye.forEach((E) => { E.blinkState = 0; E.blinkFactor = 0; });
    monsterEyesApp.select(Number(document.getElementById('pkg').value));
    const c = document.querySelector('#stage canvas');
    return { corner: Array.from(c.getContext('2d').getImageData(1, 1, 1, 1).data.slice(0, 3)),
             bg: monsterEyesApp.background, replaced: monsterEyesApp.renderer !== r0,
             blinking: monsterEyesApp.renderer.eye.some((E) => E.blinkState) };
  });
  expect(res.replaced).toBe(true);
  expect(res.corner).toEqual(res.bg.match(/\d+/g).map(Number)); // Lid colour, not black
  expect(res.blinking).toBe(false);
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
