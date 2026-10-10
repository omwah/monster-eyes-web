// Compare the JS port against the original C++ renderer (eye-sim) frame by frame.
//   node tests/parity.mjs [package ...]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, loadMonsterEyes, readPackage, listPackages, readPng, wordsTo565 } from './lib/node-env.mjs';

// Built by tools/build_sim.py; EYE_SIM points at an eye-sim built elsewhere.
const SIM = process.env.EYE_SIM || path.join(ROOT, 'vendor/sim-build/eye-sim');
if (!fs.existsSync(SIM)) {
  console.error(`No eye-sim at ${SIM}. Build it with: pixi run build-sim --sim DIR (see README)`);
  process.exit(2);
}
const OUT = path.join(ROOT, 'build/golden');
const ANIM_FRAMES = 60;
const STATIC = [
  { gaze: [0, 0], pupil: 0.5 },
  { gaze: [0.8, 0], pupil: 0.2 },
  { gaze: [-0.5, 0.6], pupil: 0.9 },
  { gaze: [0.3, -0.9], pupil: 0.0 },
];
fs.mkdirSync(OUT, { recursive: true });
const ME = loadMonsterEyes();

function sim(args, prefix) {
  execFileSync(SIM, ['--assets', ROOT, ...args, '--out', prefix], { stdio: 'pipe' });
}

function compare(r, pngFile) {
  const want = readPng(pngFile).rgb565;
  const got = wordsTo565(ME.composePanel(r));
  let diff = 0;
  for (let i = 0; i < want.length; i++) if (want[i] !== got[i]) diff++;
  return diff;
}

const ids = process.argv.length > 2 ? process.argv.slice(2) : listPackages();
let worst = 0, failures = 0;
for (const id of ids) {
  const pkg = readPackage(path.join(ROOT, 'eyes', id));
  const results = [];
  STATIC.forEach((st, k) => {
    const prefix = path.join(OUT, `${id}-s${k}`);
    sim(['--eye', id, '--frames', '1', '--no-auto-gaze', '--no-auto-blink',
      '--gaze', st.gaze.join(','), '--pupil', String(st.pupil)], prefix);
    const r = new ME.Renderer({ parity: true, seed: 1 });
    r.load(pkg, { eyes: 'auto' });
    r.autoGaze = false; r.autoBlink = false;
    r.setScreenGaze(st.gaze[0], st.gaze[1]);
    r.setPupil(st.pupil);
    r.animate(0);
    results.push(compare(r, prefix + '-000.png'));
  });
  // Seeded animation: gaze, blinks, pupil noise and flow all running.
  const prefix = path.join(OUT, `${id}-anim`);
  sim(['--eye', id, '--frames', String(ANIM_FRAMES)], prefix);
  const r = new ME.Renderer({ parity: true, seed: 1 });
  r.load(pkg, { eyes: 'auto' });
  let animDiff = 0, firstBad = -1;
  for (let i = 0; i < ANIM_FRAMES; i++) {
    r.animate(i * Math.floor(1000000 / 30));
    const d = compare(r, `${prefix}-${String(i).padStart(3, '0')}.png`);
    if (d && firstBad < 0) firstBad = i;
    animDiff = Math.max(animDiff, d);
  }
  const maxStatic = Math.max(...results);
  worst = Math.max(worst, maxStatic, animDiff);
  const ok = maxStatic === 0 && animDiff === 0;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'DIFF'} ${id.padEnd(12)} static px differing: [${results.join(', ')}]  ` +
    `animated max: ${animDiff}${firstBad >= 0 ? ` (first at frame ${firstBad})` : ''}` +
    (r.warnings.length ? `  warnings: ${r.warnings.join('; ')}` : ''));
}
console.log(`\n${ids.length - failures}/${ids.length} packages pixel-identical; worst frame differs in ${worst} of 76800 px`);
process.exitCode = failures ? 1 : 0;
