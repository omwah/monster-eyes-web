/**
 * app.js -- the page around the renderer: layout, the render loop, pointer
 * following, dragging and sizing, the control bar, keeping the screen awake,
 * and eye packages (bundled ones, plus folders the viewer adds).
 */
(function () {
  'use strict';

  const ME = window.MonsterEyes;
  const $ = (id) => document.getElementById(id);
  const stage = $('stage');

  const IDLE_MS = 3000;          // Controls hide after this long untouched
  const FOLLOW_MS = 5000;        // Pointer gaze lasts this long after it stops
  const DRAG_THRESHOLD = 6;      // CSS px before a press becomes a drag
  const MIN_SCALE = 0.2, MAX_SCALE = 3;
  const DEVICE_GAP = 28;         // The panel's default gap, against a 128 px eye
  const MAX_RENDER = 512, MIN_RENDER = 128;
  const RENDER_BUDGET_MS = 9;    // Above this the governor lowers resolution

  // ===========================================================================
  //  PREFERENCES -- best-effort; the page works the same without storage
  // ===========================================================================

  const STORE_KEY = 'monsterEyes.v1';
  const freshLayout = () => ({ scale: 1, off: [[0, 0], [0, 0]] });
  const prefs = {
    pkg: null,
    eyes: 'auto',
    follow: true,
    separate: false,
    showFps: false,
    layouts: { 1: freshLayout(), 2: freshLayout() },
  };
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved && typeof saved === 'object') {
      Object.assign(prefs, saved);
      for (const n of [1, 2]) {
        const l = prefs.layouts && prefs.layouts[n];
        if (!l || typeof l.scale !== 'number' || !Array.isArray(l.off)) {
          prefs.layouts = prefs.layouts || {};
          prefs.layouts[n] = freshLayout();
        }
      }
    }
  } catch (e) { /* No storage: defaults it is */ }

  function savePrefs() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(prefs));
    } catch (e) { /* Private window or blocked storage */ }
  }

  // ===========================================================================
  //  TOAST
  // ===========================================================================

  let toastTimer = 0;
  function toast(msg, ms = 3500) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  // ===========================================================================
  //  PACKAGES
  // ===========================================================================
  //
  // Each entry: { key, id, label, source: 'bundled' | 'added', b64 | files }.
  // Bundled packages arrive as base64 and are decoded the first time they are
  // shown, so a large bundle does not hold up the first frame.

  const packages = [];
  let current = -1;

  const bundle = window.MONSTER_EYES_BUNDLE;
  if (bundle && Array.isArray(bundle.packages)) {
    for (const p of bundle.packages)
      packages.push({ key: 'bundled:' + p.id, id: p.id, label: p.id, source: 'bundled', b64: p.files });
  }

  function materialize(entry) {
    if (!entry.files) {
      entry.files = {};
      for (const name of Object.keys(entry.b64)) entry.files[name] = ME.base64ToBytes(entry.b64[name]);
      entry.b64 = null;
    }
    return { id: entry.id, files: entry.files };
  }

  function prettyName(id) {
    return id.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function refreshPicker() {
    const sel = $('pkg');
    sel.textContent = '';
    const groups = { bundled: null, added: null };
    if (packages.some((p) => p.source === 'added')) {
      groups.bundled = document.createElement('optgroup');
      groups.bundled.label = 'Included';
      groups.added = document.createElement('optgroup');
      groups.added.label = 'Added';
    }
    packages.forEach((p, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = prettyName(p.label);
      (groups[p.source] || sel).appendChild(o);
    });
    if (groups.bundled) {
      if (groups.bundled.children.length) sel.appendChild(groups.bundled);
      sel.appendChild(groups.added);
    }
    if (current >= 0) sel.value = String(current);
  }

  // ===========================================================================
  //  LAYOUT
  // ===========================================================================
  //
  // The eyes are fitted to the window, then the viewer's size and position
  // are applied on top as a scale and per-eye offsets, the offsets measured in
  // units of the window's short side. Stored that way, a layout survives a
  // resize, a move to a projector, and a change of package.

  const view = { w: 1, h: 1, dpr: 1 };

  function resize() {
    view.dpr = Math.min(window.devicePixelRatio || 1, 3);
    view.w = Math.max(1, window.innerWidth);
    view.h = Math.max(1, window.innerHeight);
    placed = '';
    scheduleRebuild();
  }

  function gapRatio() {
    const gap = renderer && renderer.eyeGapSet ? renderer.eyeGap : DEVICE_GAP;
    return gap / 128;
  }

  // Eye squares in CSS px: [{ x, y, size }] with x, y the centre.
  function layoutFor(n) {
    const W = view.w, H = view.h, unit = Math.min(W, H);
    const L = prefs.layouts[n];
    const rects = [];
    if (n === 1) {
      const size = Math.min(W, H) * 0.92 * L.scale;
      rects.push({ x: W / 2, y: H / 2, size });
    } else {
      const g = gapRatio();
      const base = Math.min((W * 0.94) / (2 + g), H * 0.92);
      const size = base * L.scale;
      const sep = size * (1 + g);
      rects.push({ x: W / 2 - sep / 2, y: H / 2, size });
      rects.push({ x: W / 2 + sep / 2, y: H / 2, size });
    }
    rects.forEach((r, e) => {
      r.x += L.off[e][0] * unit;
      r.y += L.off[e][1] * unit;
    });
    return rects;
  }

  // ===========================================================================
  //  RENDERER
  // ===========================================================================

  let renderer = null;
  let eyeCanvases = [];   // One canvas per eye at render size, scaled by CSS
  let eyeContexts = [];
  let eyeImages = [];     // ImageData wrapping the renderer's own buffers
  let placed = '';        // The layout the canvases were last positioned for
  let background = { css: '#000', word: 0 };
  let renderCap = MAX_RENDER; // Lowered by the governor on a slow machine
  let rebuildTimer = 0;

  function wantedEyes() {
    return prefs.eyes === 1 || prefs.eyes === 2 ? prefs.eyes : 'auto';
  }

  function renderSizeFor(n) {
    const size = layoutFor(n)[0].size * view.dpr;
    return Math.max(MIN_RENDER, Math.min(renderCap, Math.round(size / 2) * 2));
  }

  function build(index) {
    if (index < 0 || index >= packages.length) return;
    const entry = packages[index];
    let pkg;
    try {
      pkg = materialize(entry);
    } catch (e) {
      toast('Could not read “' + entry.label + '”: ' + e.message);
      return;
    }
    const want = wantedEyes();
    const guess = want === 'auto' ? (renderer ? renderer.numEyes : 2) : want;
    const seed = (Math.random() * 0xffffffff) >>> 0;
    let r = new ME.Renderer({ seed });
    r.load(pkg, { eyes: want, size: renderSizeFor(guess) });
    // The package may have asked for a different number of eyes than guessed,
    // and one eye wants a different render size than two.
    if (r.ready && r.numEyes !== guess) {
      const size = renderSizeFor(r.numEyes);
      if (Math.abs(size - r.size) > 8) {
        r = new ME.Renderer({ seed });
        r.load(pkg, { eyes: want, size });
      }
    }
    if (!r.ready) {
      toast('Could not draw “' + entry.label + '”: ' + (r.error || 'unknown problem'));
      return;
    }
    // Rebuilding the same package at another resolution should not show: keep
    // the gaze where it was and skip the blink a fresh eye opens with.
    const prev = renderer;
    if (prev && index === current && prev.numEyes === r.numEyes) {
      const now = performance.now() * 1000;
      const g = prev.screenGaze();
      r.now = now;
      r.setScreenGaze(g.x, g.y);
      if (!prev.gazeExternal) r.releaseGaze();
      r.autoGaze = prev.autoGaze;
      r.autoBlink = prev.autoBlink;
      r.timeOfLastBlink = now;
      r.timeToNextBlink = 1000000 + Math.random() * 3000000;
      // A blink already under way carries on; the clocks are the same.
      prev.eye.slice(0, prev.numEyes).forEach((E, e) => {
        for (const k of ['blinkState', 'blinkStartTime', 'blinkDuration', 'blinkFactor'])
          r.eye[e][k] = E[k];
      });
    }
    renderer = r;
    current = index;
    for (const c of eyeCanvases) c.remove();
    eyeCanvases = [];
    eyeContexts = [];
    eyeImages = [];
    for (let e = 0; e < r.numEyes; e++) {
      const c = document.createElement('canvas');
      c.width = c.height = r.canvasSize;
      // Everything outside the eyeball's circle stays black.
      c.style.clipPath = 'circle(' + ((100 * r.circleRadius) / r.canvasSize).toFixed(3) + '% at 50% 50%)';
      c.className = 'eye';
      stage.appendChild(c);
      eyeCanvases.push(c);
      eyeContexts.push(c.getContext('2d', { alpha: false }));
      eyeImages.push(new ImageData(new Uint8ClampedArray(r.buffers[e].buffer), r.canvasSize, r.canvasSize));
    }
    placed = '';
    background = r.background();
    $('pkg').value = String(index);
    if (r.warnings.length) toast(prettyName(entry.label) + ': ' + r.warnings[0]);
    governor.reset();
    paint(performance.now());
  }

  function selectPackage(index, announce) {
    if (!packages.length) return;
    index = ((index % packages.length) + packages.length) % packages.length;
    build(index);
    prefs.pkg = packages[current] ? packages[current].key : null;
    savePrefs();
    if (announce) toast(prettyName(packages[current].label), 1500);
  }

  // Rebuild at a new resolution once the size has settled, rather than on
  // every wheel notch or resize event.
  function scheduleRebuild() {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      if (!renderer) return;
      const want = renderSizeFor(renderer.numEyes);
      if (Math.abs(want - renderer.size) / renderer.size > 0.12) build(current);
    }, 300);
  }

  // Keeps rendering inside its budget: if a frame's pixel work averages over
  // RENDER_BUDGET_MS, the render size steps down and the canvas scales it up.
  const governor = {
    ema: 0,
    frames: 0,
    reset() {
      this.ema = 0;
      this.frames = 0;
    },
    sample(ms) {
      this.ema = this.frames ? this.ema * 0.95 + ms * 0.05 : ms;
      if (++this.frames < 90 || !renderer) return;
      if (this.ema > RENDER_BUDGET_MS && renderer.size > MIN_RENDER) {
        renderCap = Math.max(MIN_RENDER, Math.round(renderer.size * 0.85));
        build(current);
      }
    },
  };

  // ===========================================================================
  //  POINTER: FOLLOWING, DRAGGING, SIZING
  // ===========================================================================

  const pointer = { x: 0, y: 0, t: -Infinity };
  const gaze = { x: 0, y: 0, cx: [0, 0], cy: [0, 0] };
  let drag = null;

  function eyeAt(x, y) {
    if (!renderer) return -1;
    const rects = layoutFor(renderer.numEyes);
    for (let e = rects.length - 1; e >= 0; e--) {
      const r = rects[e];
      if (Math.hypot(x - r.x, y - r.y) <= onScreen(r).radius) return e;
    }
    return -1;
  }

  stage.addEventListener('pointerdown', (ev) => {
    wake();
    keepAwake();
    pointer.x = ev.clientX;
    pointer.y = ev.clientY;
    pointer.t = performance.now();
    const n = renderer ? renderer.numEyes : 2;
    const e = eyeAt(ev.clientX, ev.clientY);
    drag = {
      id: ev.pointerId,
      eye: e,
      separate: prefs.separate || ev.shiftKey,
      x0: ev.clientX,
      y0: ev.clientY,
      off0: prefs.layouts[n].off.map((o) => o.slice()),
      n,
      moved: false,
    };
    try {
      stage.setPointerCapture(ev.pointerId);
    } catch (e2) { /* Synthetic events in tests */ }
  });

  stage.addEventListener('pointermove', (ev) => {
    pointer.x = ev.clientX;
    pointer.y = ev.clientY;
    pointer.t = performance.now();
    wake();
    if (!drag || drag.id !== ev.pointerId || drag.eye < 0) return;
    const dx = ev.clientX - drag.x0, dy = ev.clientY - drag.y0;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    drag.moved = true;
    document.body.classList.add('dragging');
    const unit = Math.min(view.w, view.h);
    const off = prefs.layouts[drag.n].off;
    for (let e = 0; e < 2; e++) {
      if (drag.separate && e !== drag.eye) continue;
      off[e][0] = drag.off0[e][0] + dx / unit;
      off[e][1] = drag.off0[e][1] + dy / unit;
    }
  });

  function endDrag(ev) {
    if (!drag || drag.id !== ev.pointerId) return;
    if (drag.moved) savePrefs();
    else if (ev.type === 'pointerup') blinkNow();
    drag = null;
    document.body.classList.remove('dragging');
  }
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);

  stage.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    wake();
    scaleBy(Math.exp(-ev.deltaY * 0.0015));
  }, { passive: false });

  let blinkCount = 0;
  function blinkNow() {
    if (!renderer) return;
    renderer.blink(performance.now() * 1000);
    blinkCount++;
  }

  function scaleBy(k) {
    const n = renderer ? renderer.numEyes : 2;
    const L = prefs.layouts[n];
    L.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, L.scale * k));
    savePrefs();
    scheduleRebuild();
  }

  function fitLayout() {
    const n = renderer ? renderer.numEyes : 2;
    prefs.layouts[n] = freshLayout();
    savePrefs();
    scheduleRebuild();
    toast('Fitted to the screen', 1200);
  }

  // Steer the gaze toward the pointer. Each eye aims from its own centre, so
  // a pointer between the eyes makes them converge; the shared part goes to
  // the animator's gaze and the remainder to per-eye convergence.
  function followPointer(now, dt) {
    if (!renderer) return;
    const active = prefs.follow && now - pointer.t < FOLLOW_MS;
    if (!active) {
      if (renderer.gazeExternal) {
        renderer.releaseGaze();
        gaze.cx = [0, 0];
        gaze.cy = [0, 0];
      }
      const g = renderer.screenGaze();
      gaze.x = g.x;
      gaze.y = g.y;
      return;
    }
    const rects = layoutFor(renderer.numEyes);
    const reach = Math.max(rects[0].size * 1.2, Math.min(view.w, view.h) * 0.45);
    const tx = [], ty = [];
    for (const r of rects) {
      tx.push((pointer.x - r.x) / reach);
      ty.push(-(pointer.y - r.y) / reach);
    }
    const mx = tx.reduce((a, b) => a + b) / tx.length;
    const my = ty.reduce((a, b) => a + b) / ty.length;
    const k = 1 - Math.exp(-dt / 90);
    gaze.x += (mx - gaze.x) * k;
    gaze.y += (my - gaze.y) * k;
    renderer.setScreenGaze(gaze.x, gaze.y);
    for (let e = 0; e < rects.length; e++) {
      gaze.cx[e] += (tx[e] - mx - gaze.cx[e]) * k;
      gaze.cy[e] += (ty[e] - my - gaze.cy[e]) * k;
      renderer.setConvergence(e, gaze.cx[e], gaze.cy[e]);
    }
  }

  // ===========================================================================
  //  RENDER LOOP
  // ===========================================================================

  let lastFrame = 0;
  const fpsMeter = { frames: 0, since: 0, text: '' };

  // Position the eye canvases; only touches the DOM when something moved.
  // Where an eye's canvas and circle land on screen. rect.size is the eye's
  // square; the canvas is larger by the renderer's pad on each side.
  function onScreen(rect) {
    const k = rect.size / renderer.size;
    return { canvas: renderer.canvasSize * k, radius: renderer.circleRadius * k };
  }

  function place() {
    const rects = layoutFor(renderer.numEyes);
    const key = rects.map((r) => r.x.toFixed(1) + ',' + r.y.toFixed(1) + ',' + r.size.toFixed(1)).join(';');
    if (key === placed) return;
    placed = key;
    rects.forEach((r, e) => {
      const st = eyeCanvases[e].style;
      const c = onScreen(r).canvas;
      st.width = st.height = c + 'px';
      st.transform = 'translate(' + (r.x - c / 2) + 'px,' + (r.y - c / 2) + 'px)';
    });
  }

  let frameCount = 0;
  function frame(ts) {
    requestAnimationFrame(frame);
    frameCount++;
    const dt = lastFrame ? Math.min(ts - lastFrame, 100) : 16;
    lastFrame = ts;
    if (wakeVideo) {
      wakeCtx.fillStyle = (fpsMeter.frames & 1) ? '#010101' : '#000';
      wakeCtx.fillRect(0, 0, 2, 2);
    }
    if (!renderer) return;

    followPointer(ts, dt);
    const ms = paint(ts);
    governor.sample(ms);
    meter(ts, dt, ms);
  }

  // Draw the eyes for time ts and show them. Also called straight after a
  // rebuild, so new canvases never reach the screen empty -- a fresh opaque
  // canvas is black, and for one frame that reads as a black blink.
  function paint(ts) {
    const t0 = performance.now();
    renderer.update(ts * 1000);
    renderer.draw();
    for (let e = 0; e < renderer.numEyes; e++) eyeContexts[e].putImageData(eyeImages[e], 0, 0);
    place();
    return performance.now() - t0;
  }

  // The FPS overlay: frame rate, the slowest frame, the time the eyes take
  // to draw, and the resolution they are drawn at. Twice a second.
  function meter(ts, dt, ms) {
    fpsMeter.frames++;
    fpsMeter.worst = Math.max(fpsMeter.worst || 0, dt);
    fpsMeter.work = (fpsMeter.work || 0) + ms;
    if (ts - fpsMeter.since < 500) return;
    if (prefs.showFps) {
      const fps = (fpsMeter.frames * 1000) / (ts - fpsMeter.since);
      $('fps').textContent = fps.toFixed(0) + ' fps\n' +
        'slowest frame ' + fpsMeter.worst.toFixed(1) + ' ms\n' +
        'eyes drawn in ' + (fpsMeter.work / fpsMeter.frames).toFixed(1) + ' ms\n' +
        renderer.numEyes + ' × ' + renderer.size + ' px';
    }
    fpsMeter.frames = 0;
    fpsMeter.worst = 0;
    fpsMeter.work = 0;
    fpsMeter.since = ts;
  }

  // ===========================================================================
  //  CONTROLS
  // ===========================================================================

  let idleTimer = 0;
  function wake() {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(goIdle, IDLE_MS);
  }
  function goIdle() {
    // Not while the viewer is using the bar.
    if ($('bar').matches(':hover') || (document.activeElement && document.activeElement.tagName === 'SELECT')) {
      idleTimer = setTimeout(goIdle, IDLE_MS);
      return;
    }
    if (document.activeElement && $('bar').contains(document.activeElement)) document.activeElement.blur();
    document.body.classList.add('idle');
  }

  function syncButtons() {
    $('count-auto').setAttribute('aria-pressed', String(prefs.eyes === 'auto'));
    $('count-1').setAttribute('aria-pressed', String(prefs.eyes === 1));
    $('count-2').setAttribute('aria-pressed', String(prefs.eyes === 2));
    $('follow').setAttribute('aria-pressed', String(!!prefs.follow));
    $('separate').setAttribute('aria-pressed', String(!!prefs.separate));
    $('fps-toggle').setAttribute('aria-pressed', String(!!prefs.showFps));
    document.body.classList.toggle('show-fps', !!prefs.showFps);
    $('fullscreen').setAttribute('aria-pressed', String(!!fullscreenElement()));
  }

  function setEyes(v) {
    prefs.eyes = v;
    savePrefs();
    syncButtons();
    build(current);
  }

  function toggleFollow() {
    prefs.follow = !prefs.follow;
    savePrefs();
    syncButtons();
    toast(prefs.follow ? 'Eyes follow the pointer' : 'Eyes look around on their own', 1500);
  }

  function toggleFps() {
    prefs.showFps = !prefs.showFps;
    savePrefs();
    syncButtons();
    fpsMeter.since = 0; // Fill the overlay on the next frame
  }

  function toggleSeparate() {
    prefs.separate = !prefs.separate;
    savePrefs();
    syncButtons();
  }

  const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement;
  function toggleFullscreen() {
    const de = document.documentElement;
    if (fullscreenElement()) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else {
      const req = de.requestFullscreen || de.webkitRequestFullscreen;
      if (req) {
        const p = req.call(de);
        if (p && p.catch) p.catch(() => toast('Full screen is not available here'));
      }
    }
  }
  document.addEventListener('fullscreenchange', () => { syncButtons(); keepAwake(); });
  document.addEventListener('webkitfullscreenchange', () => { syncButtons(); keepAwake(); });

  $('prev').onclick = () => selectPackage(current - 1);
  $('next').onclick = () => selectPackage(current + 1);
  $('pkg').onchange = (ev) => {
    selectPackage(Number(ev.target.value));
    ev.target.blur();
  };
  $('count-auto').onclick = () => setEyes('auto');
  $('count-1').onclick = () => setEyes(1);
  $('count-2').onclick = () => setEyes(2);
  $('smaller').onclick = () => scaleBy(1 / 1.1);
  $('bigger').onclick = () => scaleBy(1.1);
  $('fit').onclick = fitLayout;
  $('separate').onclick = toggleSeparate;
  $('follow').onclick = toggleFollow;
  $('blink').onclick = blinkNow;
  $('fullscreen').onclick = toggleFullscreen;
  $('fps-toggle').onclick = toggleFps;
  $('add').onclick = () => $('folder').click();
  $('bar').addEventListener('pointerdown', () => { wake(); keepAwake(); });
  $('bar').addEventListener('pointermove', wake);

  document.addEventListener('keydown', (ev) => {
    wake();
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.target && ev.target.tagName === 'SELECT' && /^Arrow/.test(ev.key)) return;
    const k = ev.key;
    let handled = true;
    if (k === 'ArrowRight' || k === 'PageDown') selectPackage(current + 1, true);
    else if (k === 'ArrowLeft' || k === 'PageUp') selectPackage(current - 1, true);
    else if (k === ' ' || k === 'b' || k === 'B') blinkNow();
    else if (k === 'a' || k === 'A') setEyes('auto');
    else if (k === '1') setEyes(1);
    else if (k === '2') setEyes(2);
    else if (k === 'f' || k === 'F') toggleFullscreen();
    else if (k === 'm' || k === 'M') toggleFollow();
    else if (k === 's' || k === 'S') toggleSeparate();
    else if (k === '+' || k === '=') scaleBy(1.1);
    else if (k === '-' || k === '_') scaleBy(1 / 1.1);
    else if (k === '0') fitLayout();
    else if (k === 'h' || k === 'H') { clearTimeout(idleTimer); goIdle(); }
    else if (k === 'i' || k === 'I') toggleFps();
    else handled = false;
    if (handled) ev.preventDefault();
  });

  // ===========================================================================
  //  KEEPING THE SCREEN AWAKE
  // ===========================================================================
  //
  // The Screen Wake Lock API where there is one; a browser drops the lock
  // whenever the page is hidden, so it is asked for again on the way back.
  // Without the API, a muted video of the canvas plays in a corner, which is
  // what keeps a display awake on browsers that only respect playing media.

  let wakeLock = null;
  let wakeVideo = null;
  const wakeCanvas = document.createElement('canvas'); // Changes every frame, so the video plays
  wakeCanvas.width = wakeCanvas.height = 2;
  const wakeCtx = wakeCanvas.getContext('2d');
  async function keepAwake() {
    if (document.visibilityState !== 'visible') return;
    if ('wakeLock' in navigator) {
      if (wakeLock) return;
      try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
        return;
      } catch (e) { /* Refused; fall back below */ }
    }
    if (!wakeVideo && wakeCanvas.captureStream) {
      try {
        wakeVideo = document.createElement('video');
        wakeVideo.muted = true;
        wakeVideo.playsInline = true;
        wakeVideo.setAttribute('playsinline', '');
        wakeVideo.loop = true;
        wakeVideo.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none';
        wakeVideo.srcObject = wakeCanvas.captureStream(1);
        document.body.appendChild(wakeVideo);
      } catch (e) {
        wakeVideo = null;
      }
    }
    if (wakeVideo && wakeVideo.paused) wakeVideo.play().catch(() => {});
  }
  document.addEventListener('visibilitychange', keepAwake);

  // ===========================================================================
  //  ADDING EYE FOLDERS
  // ===========================================================================
  //
  // Any directory holding a config.eye is a package; a file belongs to the
  // deepest package directory above it. So one package folder, or a folder of
  // them, both work, whichever the viewer picks or drops.

  async function addFiles(items) {
    const dirs = new Set();
    for (const it of items) {
      const parts = it.path.split('/');
      if (parts[parts.length - 1].toLowerCase() === 'config.eye') dirs.add(parts.slice(0, -1).join('/'));
    }
    if (!dirs.size) {
      toast('No config.eye found there. Pick a folder with an eye package (or a folder of them) inside.', 6000);
      return;
    }
    const sorted = [...dirs].sort((a, b) => b.length - a.length);
    const owner = (p) => sorted.find((d) => d === '' || p.startsWith(d + '/'));
    const found = new Map();
    for (const d of dirs) found.set(d, {});
    for (const it of items) {
      const d = owner(it.path);
      if (d === undefined) continue;
      const rel = d ? it.path.slice(d.length + 1) : it.path;
      if (rel.length > 0 && !rel.split('/').some((s) => s.startsWith('.')))
        found.get(d)[rel] = it.file;
    }
    let added = 0, firstIndex = -1;
    const skipped = [], unresolved = [];
    // Every picked file, for packages that borrow lids or textures from a
    // folder beside them.
    const pool = new Map(items.map((it) => [it.path, it.file]));
    for (const [dir, fileMap] of found) {
      const id = (dir.split('/').pop() || 'eyes').replace(/[^\w.-]+/g, '_');
      const files = {};
      for (const rel of Object.keys(fileMap)) {
        if (!/\.(eye|bmp)$/i.test(rel)) continue; // Sounds and the rest are not needed
        files[rel.toLowerCase() === 'config.eye' ? 'config.eye' : rel] =
          new Uint8Array(await fileMap[rel].arrayBuffer());
      }
      try {
        ME.parseJsonc(ME.decodeText(files['config.eye']));
      } catch (e) {
        skipped.push(id + ' (config.eye: ' + e.message + ')');
        continue;
      }
      const ext = ME.collectExternalAssets(files['config.eye'], id, dir, Object.keys(files), pool);
      for (const { key, file } of ext.found) files[key] = new Uint8Array(await file.arrayBuffer());
      if (ext.missing.length) unresolved.push(id + ' (' + ext.missing.join(', ') + ')');
      const key = 'added:' + id;
      const entry = { key, id, label: id, source: 'added', files };
      const existing = packages.findIndex((p) => p.key === key);
      if (existing >= 0) packages[existing] = entry;
      else packages.push(entry);
      storeAdded(entry);
      added++;
      if (firstIndex < 0) firstIndex = packages.findIndex((p) => p.key === key);
    }
    refreshPicker();
    if (firstIndex >= 0) selectPackage(firstIndex);
    let msg = added ? 'Added ' + added + ' eye package' + (added === 1 ? '' : 's') : 'Nothing added';
    if (!db && added) msg += ' (for this session only: this browser will not keep them)';
    if (skipped.length) msg += '. Skipped: ' + skipped.join(', ');
    if (unresolved.length)
      msg += '. Missing files: ' + unresolved.join(', ') +
        '. If they are in a folder beside the eyes, pick the folder that holds both.';
    toast(msg, unresolved.length ? 10000 : 6000);
  }

  $('folder').addEventListener('change', (ev) => {
    const items = [...ev.target.files].map((f) => ({ path: f.webkitRelativePath || f.name, file: f }));
    ev.target.value = '';
    addFiles(items);
  });

  // Folders dropped onto the page.
  let dragDepth = 0;
  window.addEventListener('dragenter', (ev) => {
    ev.preventDefault();
    dragDepth++;
    document.body.classList.add('dropping');
  });
  window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) document.body.classList.remove('dropping');
  });
  window.addEventListener('dragover', (ev) => ev.preventDefault());
  window.addEventListener('drop', async (ev) => {
    ev.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dropping');
    const entries = [...(ev.dataTransfer.items || [])]
      .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null)).filter(Boolean);
    const items = [];
    const walk = async (entry, prefix) => {
      if (entry.isFile) {
        const file = await new Promise((res, rej) => entry.file(res, rej));
        items.push({ path: prefix + entry.name, file });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        for (;;) {
          const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
          if (!batch.length) break;
          for (const child of batch) await walk(child, prefix + entry.name + '/');
        }
      }
    };
    try {
      if (entries.length) for (const en of entries) await walk(en, '');
      else for (const f of ev.dataTransfer.files) items.push({ path: f.name, file: f });
    } catch (e) {
      toast('Could not read what was dropped: ' + e.message);
      return;
    }
    addFiles(items);
  });

  // Added packages are kept in IndexedDB where the browser allows it, which
  // for a page opened from a file it may not.
  let db = null;
  function openDb() {
    return new Promise((resolve) => {
      try {
        const req = indexedDB.open('monster-eyes', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('packages', { keyPath: 'key' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    });
  }
  function storeAdded(entry) {
    if (!db) return;
    try {
      const files = {};
      for (const k of Object.keys(entry.files)) files[k] = entry.files[k];
      db.transaction('packages', 'readwrite').objectStore('packages').put({ key: entry.key, id: entry.id, files });
    } catch (e) { /* Quota or a closed database: session only */ }
  }
  function loadAdded() {
    return new Promise((resolve) => {
      if (!db) return resolve([]);
      try {
        const req = db.transaction('packages').objectStore('packages').getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch (e) {
        resolve([]);
      }
    });
  }

  // ===========================================================================
  //  START
  // ===========================================================================

  window.addEventListener('resize', resize);
  resize();
  syncButtons();

  async function start() {
    db = await Promise.race([openDb(), new Promise((r) => setTimeout(() => r(null), 1500))]);
    for (const rec of await loadAdded()) {
      if (!rec || !rec.files || !rec.files['config.eye']) continue;
      packages.push({ key: rec.key, id: rec.id, label: rec.id, source: 'added', files: rec.files });
    }
    refreshPicker();
    if (!packages.length) {
      toast('No eyes yet. Use “Add eyes…” to pick a folder of eye packages.', 8000);
      return;
    }
    let index = packages.findIndex((p) => p.key === prefs.pkg);
    if (index < 0) index = 0;
    selectPackage(index);
    toast('Move the mouse to show the controls', 2500);
  }

  start();
  wake();
  keepAwake();
  requestAnimationFrame(frame);

  // For the tests: a read-only look at the running state.
  window.monsterEyesApp = {
    get renderer() { return renderer; },
    get frameCount() { return frameCount; },
    get blinkCount() { return blinkCount; },
    get packageKey() { return packages[current] ? packages[current].key : null; },
    get packageCount() { return packages.length; },
    get background() { return background.css; },
    get prefs() { return JSON.parse(JSON.stringify(prefs)); },
    get wakeLocked() { return !!wakeLock || !!(wakeVideo && !wakeVideo.paused); },
    layout() { return renderer ? layoutFor(renderer.numEyes).map((r) => ({ ...r, radius: onScreen(r).radius })) : []; },
    select(i) { selectPackage(i); },
  };
})();
