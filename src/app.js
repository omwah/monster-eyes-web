/**
 * app.js -- the page around the renderer: layout, the render loop, pointer
 * following, dragging and sizing, the control bar, keeping the screen awake,
 * and eye packages (bundled ones, plus folders the viewer adds).
 */
(function () {
  'use strict';

  const ME = window.MonsterEyes;

  // Which build this is: 'simple' (eyes built in, no importing),
  // 'customizable' (no built-in eyes; import your own), 'web' (built-in eyes
  // loaded from separate files, plus importing), or 'dev' for src/index.html.
  const VARIANT = window.MONSTER_EYES_VARIANT || 'dev';
  const CAN_IMPORT = VARIANT !== 'simple';
  // Stamped in by the build: "1.2.0", or "1.2.0+g1a2b3c4" between releases.
  const VERSION = window.MONSTER_EYES_VERSION || 'dev';
  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const ring = $('ring');

  const IDLE_MS = 3000;          // Controls hide after this long untouched
  const FOLLOW_MS = 5000;        // Pointer gaze lasts this long after it stops
  const DRAG_THRESHOLD = 6;      // CSS px before a press becomes a drag
  const MIN_SCALE = 0.2, MAX_SCALE = 3;
  const DEVICE_GAP = 28;         // The panel's default gap, against a 128 px eye
  const MIN_RENDER = 128;
  const RESOLUTIONS = ['auto', 1024, 512, 320, 192]; // Render px caps; Auto depends on the renderer
  const FRAME_RATES = [0, 30]; // 0: every screen refresh
  const SLIDE_INTERVALS = [0, 30, 60, 120, 300]; // Seconds; 0 keeps one eye
  const CLOSE_MS = 150, OPEN_MS = 250, FADE_MS = 300; // Slideshow transition

  // ===========================================================================
  //  PREFERENCES -- best-effort; the page works the same without storage
  // ===========================================================================

  const STORE_KEY = 'monsterEyes.v1';
  // Each eye has its own size (a multiple of the fitted size) and its own
  // offset from the fitted position.
  const freshLayout = () => ({ scale: [1, 1], off: [[0, 0], [0, 0]] });
  const prefs = {
    pkg: null,
    eyes: 'auto',
    follow: true,
    separate: false,
    showFps: false,
    autoBlink: true, // Let the eyes blink on their own, where the package allows
    excluded: [], // Keys of eyes left out of ◀ ▶ and the slideshow
    slideshow: { interval: 0, order: 'order' }, // Seconds per eye (0: always this one)
    layouts: { 1: freshLayout(), 2: freshLayout() },
    quality: { resolution: 'auto', fps: 0 },
  };
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved && typeof saved === 'object') {
      Object.assign(prefs, saved);
      prefs.layouts = prefs.layouts || {};
      for (const n of [1, 2]) {
        const l = prefs.layouts[n];
        // Earlier versions kept one size for both eyes.
        if (l && typeof l.scale === 'number') l.scale = [l.scale, l.scale];
        const ok = l && Array.isArray(l.scale) && l.scale.length === 2 && l.scale.every((v) => v > 0) &&
          Array.isArray(l.off) && l.off.length === 2;
        if (!ok) prefs.layouts[n] = freshLayout();
      }
      if (!Array.isArray(prefs.excluded)) prefs.excluded = [];
      const ss = prefs.slideshow;
      if (!ss || !SLIDE_INTERVALS.includes(ss.interval) || !['order', 'random'].includes(ss.order))
        prefs.slideshow = { interval: 0, order: 'order' };
      const q = prefs.quality;
      if (!q || typeof q !== 'object') prefs.quality = { resolution: 'auto', fps: 0 };
      if (!RESOLUTIONS.includes(prefs.quality.resolution)) prefs.quality.resolution = 'auto';
      if (!FRAME_RATES.includes(prefs.quality.fps)) prefs.quality.fps = 0;
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
  // Each entry: { key, id, label, source: 'bundled' | 'added', state, and
  // b64 | files | src }. Bundled packages arrive as base64 and are decoded the
  // first time they are shown, so a large bundle does not hold up the first
  // frame. In the web build they are not here at all to begin with: each has
  // a script of its own (src) and is 'pending' until that has loaded.

  const packages = [];
  let current = -1;

  const bundle = window.MONSTER_EYES_BUNDLE;
  if (bundle && Array.isArray(bundle.packages)) {
    for (const p of bundle.packages)
      packages.push({ key: 'bundled:' + p.id, id: p.id, label: p.id, source: 'bundled', state: 'ready', b64: p.files });
  }
  const manifest = window.MONSTER_EYES_MANIFEST;
  if (Array.isArray(manifest)) {
    for (const m of manifest)
      packages.push({ key: 'bundled:' + m.id, id: m.id, label: m.id, source: 'bundled', state: 'pending', src: m.file });
  }
  const isReady = (p) => p.state === 'ready';

  // ---------------------------------------------------------------------------
  //  Loading the web build's eye files: one <script> each, which hands its
  //  package to MonsterEyes.registerPackage. A script loads from file:// as
  //  well as from a server, so the build also works unzipped from disk.
  // ---------------------------------------------------------------------------

  ME.onRegister = (id) => {
    const entry = packages.find((p) => p.src && p.id === id && !isReady(p));
    if (!entry) return;
    entry.b64 = ME.registered[id];
    delete ME.registered[id];
    entry.state = 'ready';
  };

  function loadEntry(entry) {
    if (isReady(entry)) return Promise.resolve(entry);
    if (entry.state === 'failed') return Promise.reject(new Error('it could not be loaded'));
    if (!entry.loading) {
      entry.state = 'loading';
      entry.loading = new Promise((resolve, reject) => {
        const fail = (why) => {
          entry.state = 'failed';
          reject(new Error(why));
        };
        const tag = document.createElement('script');
        tag.src = entry.src;
        tag.onload = () => (isReady(entry) ? resolve(entry) : fail('its file held no eye package'));
        tag.onerror = () => fail('its file (' + entry.src + ') could not be loaded');
        document.head.appendChild(tag);
      });
      entry.loading.then(refreshPicker, (e) => {
        refreshPicker();
        toast('Could not load “' + prettyName(entry) + '”: ' + e.message, 5000);
      });
      refreshPicker();
    }
    return entry.loading;
  }

  // After the first eye is up, fetch the rest one at a time so they don't
  // compete with it or with drawing.
  async function preloadRest() {
    for (const entry of packages.slice()) {
      if (entry.state !== 'pending') continue;
      try {
        await loadEntry(entry);
      } catch (e) { /* Marked unavailable; carry on with the rest */ }
    }
  }

  function materialize(entry) {
    if (!entry.files) {
      entry.files = {};
      for (const name of Object.keys(entry.b64)) entry.files[name] = ME.base64ToBytes(entry.b64[name]);
      entry.b64 = null;
    }
    return { id: entry.id, files: entry.files };
  }

  const isAdded = (p) => p.source === 'added';
  // Built-in and imported eyes side by side; only then is it worth marking
  // which is which.
  const mixed = () => packages.some(isAdded) && packages.some((p) => !isAdded(p));
  const isIncluded = (p) => !prefs.excluded.includes(p.key);

  // "big_blue" -> "Big Blue". An imported eye gets " *" when the list mixes
  // built-in and imported eyes, so it can be told apart however it is reached.
  function prettyName(entry) {
    const base = entry.label.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    return isAdded(entry) && mixed() ? base + ' *' : base;
  }

  // ---------------------------------------------------------------------------
  //  The eye picker: a list with a checkbox per eye. Unchecked eyes are skipped
  //  by ◀ ▶ and the slideshow, but can still be shown by clicking their name.
  // ---------------------------------------------------------------------------

  const picker = $('picker');

  function refreshPicker() {
    const list = $('pick-list');
    const focused = picker.contains(document.activeElement) && document.activeElement.closest('.pick-row');
    const focusIndex = focused ? Number(focused.dataset.index) : -1;
    list.textContent = '';
    const grouped = mixed();
    let lastSource = null;
    packages.forEach((p, i) => {
      if (grouped && p.source !== lastSource) {
        const head = document.createElement('li');
        head.className = 'pick-group';
        head.textContent = isAdded(p) ? 'Added' : 'Included';
        list.appendChild(head);
        lastSource = p.source;
      }
      const name = prettyName(p);
      const row = document.createElement('li');
      row.className = 'pick-row' + (i === current ? ' current' : '');
      row.dataset.index = String(i);
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = isIncluded(p);
      cb.tabIndex = -1;
      cb.title = 'Include in ◀ ▶ and the slideshow';
      cb.setAttribute('aria-label', 'Include ' + name);
      cb.onchange = () => setIncluded(i, cb.checked);
      const btn = document.createElement('button');
      btn.className = 'pick-name';
      btn.textContent = name;
      btn.title = 'Show ' + name;
      if (i === current) btn.setAttribute('aria-current', 'true');
      btn.onclick = () => selectPackage(i);
      row.append(cb, btn);
      if (p.state === 'loading' || p.state === 'failed') {
        const mark = document.createElement('span');
        mark.className = 'pick-state';
        mark.textContent = p.state === 'loading' ? 'loading…' : 'unavailable';
        row.appendChild(mark);
        if (p.state === 'failed') row.classList.add('failed');
      }
      if (CAN_IMPORT && isAdded(p)) {
        const x = document.createElement('button');
        x.className = 'pick-remove icon';
        x.textContent = '×';
        x.title = 'Remove ' + name;
        x.setAttribute('aria-label', 'Remove ' + name);
        x.onclick = () => removeAdded(i);
        row.appendChild(x);
      }
      list.appendChild(row);
    });
    const included = packages.filter(isIncluded).length;
    $('pick-count').textContent = included + ' of ' + packages.length + ' in rotation';
    $('pkg-name').textContent = current >= 0 && packages[current] ? prettyName(packages[current]) : '—';
    if (focusIndex >= 0) {
      const again = list.querySelector('.pick-row[data-index="' + focusIndex + '"] .pick-name');
      if (again) again.focus();
    }
  }

  // Forget an imported eye, here and in the browser's storage.
  function removeAdded(index) {
    const entry = packages[index];
    if (!entry || !isAdded(entry)) return;
    if (!window.confirm('Remove “' + prettyName(entry) + '”? This browser will forget it.')) return;
    const showing = packages[current];
    packages.splice(index, 1);
    prefs.excluded = prefs.excluded.filter((k) => k !== entry.key);
    savePrefs();
    deleteAdded(entry.key);
    if (entry !== showing) {
      current = packages.indexOf(showing);
    } else {
      current = -1;
      dropRenderer();
      const next = packages.findIndex((p) => isIncluded(p) && p.state !== 'failed');
      if (next >= 0 || packages.length) selectPackage(next >= 0 ? next : 0);
    }
    refreshPicker();
    updateEmpty();
  }

  function setIncluded(index, on) {
    const key = packages[index].key;
    if (!on && !packages.some((p, j) => j !== index && isIncluded(p))) {
      toast('At least one eye has to stay checked');
      refreshPicker();
      return;
    }
    prefs.excluded = prefs.excluded.filter((k) => k !== key);
    if (!on) prefs.excluded.push(key);
    savePrefs();
    refreshPicker();
  }

  // With no eyes at all (the customizable build before any are added), a
  // panel explains how to add some, and stays until there are.
  function updateEmpty() {
    $('empty').hidden = packages.length > 0;
  }

  function dropRenderer() {
    renderer = null;
    for (const c of eyeCanvases) c.remove();
    eyeCanvases = [];
    eyeContexts = [];
    eyeImages = [];
    placed = '';
    ring.classList.remove('on');
  }

  function openPicker(open) {
    picker.hidden = !open;
    $('pkg').setAttribute('aria-expanded', String(open));
    if (open) {
      openQuality(false);
      refreshPicker();
      const cur = picker.querySelector('.pick-row.current .pick-name') || picker.querySelector('.pick-name');
      if (cur) {
        cur.focus();
        cur.scrollIntoView({ block: 'nearest' });
      }
    }
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
      const size = Math.min(W, H) * 0.92 * L.scale[0];
      rects.push({ x: W / 2, y: H / 2, size });
    } else {
      // The pair stays centred, spaced by its mean size and the package's gap.
      const g = gapRatio();
      const base = Math.min((W * 0.94) / (2 + g), H * 0.92);
      const s0 = base * L.scale[0], s1 = base * L.scale[1];
      const sep = ((s0 + s1) / 2) * (1 + g);
      rects.push({ x: W / 2 - sep / 2, y: H / 2, size: s0 });
      rects.push({ x: W / 2 + sep / 2, y: H / 2, size: s1 });
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
  let rebuildTimer = 0;

  function wantedEyes() {
    return prefs.eyes === 1 || prefs.eyes === 2 ? prefs.eyes : 'auto';
  }

  // The most pixels across an eye is drawn with, from the Quality setting.
  function maxRender() {
    const res = prefs.quality.resolution;
    return res === 'auto' ? 512 : res;
  }

  // Both eyes share one render size: enough for the larger of them.
  function renderSizeFor(n) {
    const size = Math.max(...layoutFor(n).map((r) => r.size)) * view.dpr;
    return Math.max(MIN_RENDER, Math.min(maxRender(), Math.round(size / 2) * 2));
  }

  function build(index) {
    if (index < 0 || index >= packages.length) return;
    const entry = packages[index];
    let pkg;
    try {
      pkg = materialize(entry);
    } catch (e) {
      toast('Could not read “' + prettyName(entry) + '”: ' + e.message);
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
      toast('Could not draw “' + prettyName(entry) + '”: ' + (r.error || 'unknown problem'));
      return;
    }
    // Rebuilding the same package at another resolution should not show: keep
    // the gaze where it was and skip the blink a fresh eye opens with.
    // Blinking on its own needs both the package's leave and the viewer's.
    r.packageAutoBlink = r.autoBlink;
    r.autoBlink = r.packageAutoBlink && prefs.autoBlink;
    const prev = renderer;
    if (prev && index === current && prev.numEyes === r.numEyes) {
      const now = performance.now() * 1000;
      const g = prev.screenGaze();
      r.now = now;
      r.setScreenGaze(g.x, g.y);
      if (!prev.gazeExternal) r.releaseGaze();
      r.autoGaze = prev.autoGaze;
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
      eyeContexts.push(c.getContext('2d', { alpha: r.clearLids }));
      eyeImages.push(new ImageData(new Uint8ClampedArray(r.buffers[e].buffer), r.canvasSize, r.canvasSize));
    }
    placed = '';
    background = r.background();
    refreshPicker();
    if (r.warnings.length) toast(prettyName(entry) + ': ' + r.warnings[0]);
    paint(performance.now());
    syncButtons();
  }

  let wantedIndex = -1; // An eye asked for that is still loading
  function selectPackage(index, announce) {
    if (!packages.length) return;
    index = ((index % packages.length) + packages.length) % packages.length;
    const entry = packages[index];
    if (!isReady(entry)) {
      // Fetch it ahead of the queue; the eyes showing stay up until it lands.
      wantedIndex = index;
      loadEntry(entry).then(() => {
        if (wantedIndex === index && packages[index] === entry) {
          wantedIndex = -1;
          selectPackage(index, announce);
        }
      }, () => {
        if (wantedIndex === index) wantedIndex = -1;
      });
      return;
    }
    wantedIndex = -1;
    endTransition();
    slideClock = performance.now();
    index = ((index % packages.length) + packages.length) % packages.length;
    build(index);
    prefs.pkg = packages[current] ? packages[current].key : null;
    savePrefs();
    if (announce) toast(prettyName(packages[current]), 1500);
  }

  // The next or previous eye that is checked, skipping unchecked ones and
  // any that could not be loaded.
  function stepPackage(dir, announce) {
    const n = packages.length;
    for (let k = 1; k < n; k++) {
      const i = (((current + dir * k) % n) + n) % n;
      if (isIncluded(packages[i]) && packages[i].state !== 'failed') {
        selectPackage(i, announce);
        return;
      }
    }
    if (!isIncluded(packages[current])) toast('No other eyes are checked', 1500);
  }

  // ---------------------------------------------------------------------------
  //  Slideshow: after each interval the eyes blink across to the next checked
  //  eye, in list order or at random. Random draws from a shuffled bag, so
  //  every checked eye has its turn before any comes round again, and a new
  //  bag never starts with the eye just shown.
  // ---------------------------------------------------------------------------

  let slideClock = 0;   // When the current eye came up
  let slideBag = [];    // Keys still to come in this random round
  let transition = null;

  function nextSlide(from) {
    const n = packages.length;
    if (prefs.slideshow.order === 'random') {
      for (let tries = 0; tries < 2; tries++) {
        while (slideBag.length) {
          const key = slideBag.pop();
          const i = packages.findIndex((p) => p.key === key);
          if (i >= 0 && i !== from && isIncluded(packages[i]) && isReady(packages[i])) return i;
        }
        slideBag = packages.filter((p, i) => i !== from && isIncluded(p) && isReady(p)).map((p) => p.key);
        for (let i = slideBag.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [slideBag[i], slideBag[j]] = [slideBag[j], slideBag[i]];
        }
      }
      return from;
    }
    for (let k = 1; k < n; k++) {
      const i = (((from + k) % n) + n) % n;
      if (isIncluded(packages[i]) && isReady(packages[i])) return i;
    }
    return from;
  }

  // Close the eyes (or fade, for eyes without lids), swap, then open them.
  function slideTo(index) {
    transition = { to: index, start: performance.now(), phase: 'close', lids: !!(renderer && renderer.hasLids) };
  }

  function endTransition() {
    if (!transition) return;
    transition = null;
    stage.style.opacity = '';
    if (renderer) renderer.blinkExternal = false;
  }

  function runSlideshow(now) {
    if (transition) {
      const t = transition, dt = now - t.start;
      if (t.phase === 'close') {
        const k = Math.min(1, dt / (t.lids ? CLOSE_MS : FADE_MS));
        if (t.lids) {
          renderer.blinkExternal = true;
          renderer.blinkForced = k;
        } else {
          stage.style.opacity = String(1 - k);
        }
        if (k < 1) return;
        const to = t.to;
        transition = null;
        selectPackage(to);
        if (renderer.hasLids) {
          stage.style.opacity = '';
          renderer.openFromClosed(now * 1000, OPEN_MS * 1000);
        } else {
          transition = { phase: 'open', start: now };
          stage.style.opacity = '0';
        }
      } else {
        const k = Math.min(1, dt / FADE_MS);
        stage.style.opacity = k < 1 ? String(k) : '';
        if (k >= 1) transition = null;
      }
      return;
    }
    const secs = prefs.slideshow.interval;
    if (!secs || !renderer || now - slideClock < secs * 1000) return;
    const next = nextSlide(current);
    if (next === current) slideClock = now;
    else slideTo(next);
  }

  function setSlideshow(change) {
    Object.assign(prefs.slideshow, change);
    slideBag = [];
    slideClock = performance.now();
    savePrefs();
    syncSlideshow();
  }

  function syncSlideshow() {
    const ss = prefs.slideshow;
    for (const b of document.querySelectorAll('[data-interval]'))
      b.setAttribute('aria-pressed', String(Number(b.dataset.interval) === ss.interval));
    for (const b of document.querySelectorAll('[data-order]'))
      b.setAttribute('aria-pressed', String(b.dataset.order === ss.order));
    const label = { 30: '30 s', 60: '1 min', 120: '2 min', 300: '5 min' }[ss.interval];
    $('pkg-badge').textContent = label ? '▶ ' + label : '';
    $('pkg-badge').hidden = !label;
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

  // ===========================================================================
  //  POINTER: FOLLOWING, DRAGGING, SIZING
  // ===========================================================================

  const pointer = { x: 0, y: 0, t: -Infinity };
  const gaze = { x: 0, y: 0, cx: [0, 0], cy: [0, 0] };
  let drag = null;
  let selectedEye = -1; // The eye "Adjust separately" acts on; -1 for none yet

  function eyeAt(x, y) {
    if (!renderer) return -1;
    // Eyes can overlap; the one whose centre is nearer wins.
    let best = -1, bestD = Infinity;
    layoutFor(renderer.numEyes).forEach((r, e) => {
      const d = Math.hypot(x - r.x, y - r.y);
      if (d <= onScreen(r).radius && d < bestD) { best = e; bestD = d; }
    });
    return best;
  }

  stage.addEventListener('pointerdown', (ev) => {
    wake();
    keepAwake();
    pointer.x = ev.clientX;
    pointer.y = ev.clientY;
    pointer.t = performance.now();
    const n = renderer ? renderer.numEyes : 2;
    const e = eyeAt(ev.clientX, ev.clientY);
    if (e >= 0 && selectedEye !== e) {
      selectedEye = e;
      placed = '';
    }
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

  // The wheel over an eye resizes just that eye when adjusting separately or
  // with Shift held; otherwise it resizes the pair.
  stage.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    wake();
    const e = eyeAt(ev.clientX, ev.clientY);
    const one = (prefs.separate || ev.shiftKey) && e >= 0;
    if (one && selectedEye !== e) {
      selectedEye = e;
      placed = '';
    }
    scaleBy(Math.exp(-ev.deltaY * 0.0015), one ? e : undefined);
  }, { passive: false });

  let blinkCount = 0;
  function blinkNow() {
    if (!renderer) return;
    renderer.blink(performance.now() * 1000);
    blinkCount++;
  }

  // Resize one eye, or both. With no eye named, "Adjust separately" means
  // the last eye touched, and otherwise the pair.
  function scaleBy(k, eye) {
    const n = renderer ? renderer.numEyes : 2;
    const L = prefs.layouts[n];
    if (eye === undefined) eye = prefs.separate && selectedEye >= 0 && n === 2 ? selectedEye : -1;
    for (let e = 0; e < 2; e++)
      if (eye < 0 || e === eye) L.scale[e] = Math.min(MAX_SCALE, Math.max(MIN_SCALE, L.scale[e] * k));
    savePrefs();
    scheduleRebuild();
  }

  // Back to the default positions, keeping the sizes.
  function centerLayout() {
    const n = renderer ? renderer.numEyes : 2;
    prefs.layouts[n].off = [[0, 0], [0, 0]];
    savePrefs();
    toast('Centred', 1200);
  }

  // Back to the default sizes and positions.
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
  let lastPaint = 0;
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
    const key = rects.map((r) => r.x.toFixed(1) + ',' + r.y.toFixed(1) + ',' + r.size.toFixed(1)).join(';') +
      '|' + selectedEye;
    if (key === placed) return;
    placed = key;
    // A ring marks the eye "Adjust separately" will act on.
    const sel = rects[selectedEye];
    ring.classList.toggle('on', !!sel);
    if (sel) {
      const d = onScreen(sel).radius * 2 + 8;
      ring.style.width = ring.style.height = d + 'px';
      ring.style.transform = 'translate(' + (sel.x - d / 2) + 'px,' + (sel.y - d / 2) + 'px)';
    }
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

    runSlideshow(ts);
    followPointer(ts, dt);
    // A frame rate cap skips drawing, not time: the eyes move as fast, in
    // fewer steps. The few ms of slack keep a 60 Hz screen at an even 30.
    const fps = prefs.quality.fps;
    if (fps && lastPaint && ts - lastPaint < 1000 / fps - 4) return;
    const paintDt = lastPaint ? Math.min(ts - lastPaint, 100) : dt;
    lastPaint = ts;
    const ms = paint(ts);
    meter(ts, paintDt, ms);
  }

  // Draw the eyes for time ts and show them. Also called straight after a
  // rebuild, so new canvases never reach the screen empty -- a fresh opaque
  // canvas is black, and for one frame that reads as a black blink.
  let paintCount = 0;
  function paint(ts) {
    paintCount++;
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
    if ($('bar').matches(':hover') || !picker.hidden || !qualityPanel.hidden || !$('empty').hidden) {
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
    document.body.classList.toggle('adjust-separately', !!prefs.separate);
    $('fps-toggle').setAttribute('aria-pressed', String(!!prefs.showFps));
    // Auto-blink: greyed out for eyes with no lids to blink with.
    const blink = $('blink');
    const lidless = !!renderer && !renderer.hasLids;
    blink.setAttribute('aria-pressed', String(!!prefs.autoBlink && !lidless));
    blink.disabled = lidless;
    blink.title = lidless ? "This eye has no eyelids, so it can't blink"
      : renderer && !renderer.packageAutoBlink ? "This eye is drawn not to blink on its own; click it or press Space to blink (B)"
      : 'Blink now and then on their own (B). Click an eye or press Space to blink once';
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

  function toggleAutoBlink() {
    prefs.autoBlink = !prefs.autoBlink;
    savePrefs();
    if (renderer) renderer.autoBlink = renderer.packageAutoBlink && prefs.autoBlink;
    syncButtons();
    toast(prefs.autoBlink ? 'The eyes blink on their own' : 'The eyes only blink when clicked', 1500);
  }

  function toggleFps() {
    prefs.showFps = !prefs.showFps;
    savePrefs();
    syncButtons();
    fpsMeter.since = 0; // Fill the overlay on the next frame
  }

  // ---------------------------------------------------------------------------
  //  Quality: resolution and frame rate, for machines that cannot keep up.
  // ---------------------------------------------------------------------------

  const qualityPanel = $('quality-panel');
  function openQuality(open) {
    qualityPanel.hidden = !open;
    $('quality').setAttribute('aria-expanded', String(open));
    if (open) {
      openPicker(false);
      syncQuality();
      const cur = qualityPanel.querySelector('[aria-pressed="true"]');
      if (cur) cur.focus();
    }
  }

  function setQuality(change) {
    Object.assign(prefs.quality, change);
    savePrefs();
    syncQuality();
    if (renderer && renderSizeFor(renderer.numEyes) !== renderer.size) build(current);
  }

  function syncQuality() {
    const q = prefs.quality;
    for (const b of qualityPanel.querySelectorAll('[data-res]'))
      b.setAttribute('aria-pressed', String(String(q.resolution) === b.dataset.res));
    for (const b of qualityPanel.querySelectorAll('[data-fps]'))
      b.setAttribute('aria-pressed', String(Number(b.dataset.fps) === q.fps));
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

  $('prev').onclick = () => stepPackage(-1);
  $('next').onclick = () => stepPackage(1);
  $('pkg').onclick = () => openPicker(picker.hidden);
  $('quality').onclick = () => openQuality(qualityPanel.hidden);
  for (const b of qualityPanel.querySelectorAll('[data-res]'))
    b.onclick = () => setQuality({ resolution: b.dataset.res === 'auto' ? 'auto' : Number(b.dataset.res) });
  for (const b of qualityPanel.querySelectorAll('[data-fps]'))
    b.onclick = () => setQuality({ fps: Number(b.dataset.fps) });
  for (const b of document.querySelectorAll('[data-interval]'))
    b.onclick = () => setSlideshow({ interval: Number(b.dataset.interval) });
  for (const b of document.querySelectorAll('[data-order]'))
    b.onclick = () => setSlideshow({ order: b.dataset.order });
  $('pick-all').onclick = () => {
    prefs.excluded = [];
    savePrefs();
    refreshPicker();
  };
  $('pick-none').onclick = () => {
    // Everything but the eye showing, since one has to stay checked.
    prefs.excluded = packages.filter((p, i) => i !== current).map((p) => p.key);
    savePrefs();
    refreshPicker();
  };
  // Close on a press anywhere outside the picker and its button.
  document.addEventListener('pointerdown', (ev) => {
    if (!picker.hidden && !picker.contains(ev.target) && !$('pkg').contains(ev.target)) openPicker(false);
    if (!qualityPanel.hidden && !qualityPanel.contains(ev.target) && !$('quality').contains(ev.target)) openQuality(false);
  }, true);
  // Keys inside the list: ↑ ↓ move, Space checks or unchecks, Enter shows,
  // Esc closes. They stay in the list rather than reaching the page.
  picker.addEventListener('keydown', (ev) => {
    const names = [...picker.querySelectorAll('.pick-name')];
    const at = names.indexOf(document.activeElement);
    const k = ev.key;
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      const next = names[Math.max(0, Math.min(names.length - 1, at + (k === 'ArrowDown' ? 1 : -1)))];
      if (next) {
        next.focus();
        next.scrollIntoView({ block: 'nearest' });
      }
    } else if (k === ' ' && at >= 0) {
      const row = names[at].closest('.pick-row');
      setIncluded(Number(row.dataset.index), !isIncluded(packages[Number(row.dataset.index)]));
    } else if (k === 'Escape') {
      openPicker(false);
      $('pkg').focus();
    } else if (k !== 'Enter' && k !== 'Tab') {
      return;
    }
    if (k !== 'Enter' && k !== 'Tab') ev.preventDefault();
    ev.stopPropagation();
    wake();
  });
  $('count-auto').onclick = () => setEyes('auto');
  $('count-1').onclick = () => setEyes(1);
  $('count-2').onclick = () => setEyes(2);
  $('smaller').onclick = () => scaleBy(1 / 1.1);
  $('bigger').onclick = () => scaleBy(1.1);
  $('fit').onclick = fitLayout;
  $('center').onclick = centerLayout;
  $('separate').onclick = toggleSeparate;
  $('follow').onclick = toggleFollow;
  $('blink').onclick = toggleAutoBlink;
  $('fullscreen').onclick = toggleFullscreen;
  $('fps-toggle').onclick = toggleFps;
  if (CAN_IMPORT) {
    $('add').onclick = () => $('folder').click();
    $('empty-add').onclick = () => $('folder').click();
  } else {
    // The simple build only shows what it was built with.
    for (const id of ['add', 'folder', 'drop', 'empty-add']) $(id).remove();
  }
  $('version').textContent = 'Monster Eyes ' + VERSION;
  $('bar').addEventListener('pointerdown', () => { wake(); keepAwake(); });
  $('bar').addEventListener('pointermove', wake);

  document.addEventListener('keydown', (ev) => {
    wake();
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (picker.contains(ev.target)) return;
    const k = ev.key;
    let handled = true;
    if (k === 'Escape' && !qualityPanel.hidden) {
      openQuality(false);
      $('quality').focus();
    }
    else if (k === 'ArrowRight' || k === 'PageDown') stepPackage(1, true);
    else if (k === 'ArrowLeft' || k === 'PageUp') stepPackage(-1, true);
    else if (k === ' ') blinkNow();
    else if (k === 'b' || k === 'B') toggleAutoBlink();
    else if (k === 'a' || k === 'A') setEyes('auto');
    else if (k === '1') setEyes(1);
    else if (k === '2') setEyes(2);
    else if (k === 'f' || k === 'F') toggleFullscreen();
    else if (k === 'm' || k === 'M') toggleFollow();
    else if (k === 's' || k === 'S') toggleSeparate();
    else if (k === '+' || k === '=') scaleBy(1.1);
    else if (k === '-' || k === '_') scaleBy(1 / 1.1);
    else if (k === '0') fitLayout();
    else if (k === 'c' || k === 'C') centerLayout();
    else if (k === 'h' || k === 'H') { clearTimeout(idleTimer); goIdle(); }
    else if (k === 'i' || k === 'I') toggleFps();
    else if (k === 'q' || k === 'Q') openQuality(qualityPanel.hidden);
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
      const entry = { key, id, label: id, source: 'added', state: 'ready', files };
      const existing = packages.findIndex((p) => p.key === key);
      if (existing >= 0) packages[existing] = entry;
      else packages.push(entry);
      storeAdded(entry);
      added++;
      if (firstIndex < 0) firstIndex = packages.findIndex((p) => p.key === key);
    }
    refreshPicker();
    updateEmpty();
    if (firstIndex >= 0) selectPackage(firstIndex);
    let msg = added ? 'Added ' + added + ' eye package' + (added === 1 ? '' : 's') : 'Nothing added';
    if (!db && added) msg += ' (for this session only: this browser will not keep them)';
    if (skipped.length) msg += '. Skipped: ' + skipped.join(', ');
    if (unresolved.length)
      msg += '. Missing files: ' + unresolved.join(', ') +
        '. If they are in a folder beside the eyes, pick the folder that holds both.';
    toast(msg, unresolved.length ? 10000 : 6000);
  }

  if (CAN_IMPORT) $('folder').addEventListener('change', (ev) => {
    const items = [...ev.target.files].map((f) => ({ path: f.webkitRelativePath || f.name, file: f }));
    ev.target.value = '';
    addFiles(items);
  });

  // Folders dropped onto the page.
  let dragDepth = 0;
  if (CAN_IMPORT) window.addEventListener('dragenter', (ev) => {
    ev.preventDefault();
    dragDepth++;
    document.body.classList.add('dropping');
  });
  if (CAN_IMPORT) window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) document.body.classList.remove('dropping');
  });
  if (CAN_IMPORT) window.addEventListener('dragover', (ev) => ev.preventDefault());
  if (CAN_IMPORT) window.addEventListener('drop', async (ev) => {
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
  function deleteAdded(key) {
    if (!db) return;
    try {
      db.transaction('packages', 'readwrite').objectStore('packages').delete(key);
    } catch (e) { /* Gone with the session anyway */ }
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
  syncSlideshow();

  async function start() {
    if (CAN_IMPORT) {
      db = await Promise.race([openDb(), new Promise((r) => setTimeout(() => r(null), 1500))]);
      for (const rec of await loadAdded()) {
        if (!rec || !rec.files || !rec.files['config.eye']) continue;
        packages.push({ key: rec.key, id: rec.id, label: rec.id, source: 'added', state: 'ready', files: rec.files });
      }
    }
    refreshPicker();
    updateEmpty();
    if (!packages.length) return;
    // The remembered eye, or the first checked one, comes first.
    let order = packages.map((p, i) => i);
    const remembered = packages.findIndex((p) => p.key === prefs.pkg);
    const firstChecked = packages.findIndex(isIncluded);
    const lead = remembered >= 0 ? remembered : Math.max(0, firstChecked);
    order = [lead, ...order.filter((i) => i !== lead)];
    $('loading').hidden = isReady(packages[lead]);
    for (const i of order) {
      try {
        await loadEntry(packages[i]);
      } catch (e) {
        continue; // Try the next one
      }
      selectPackage(i);
      break;
    }
    $('loading').hidden = true;
    toast('Move the mouse to show the controls', 2500);
    preloadRest();
  }


  start();
  wake();
  keepAwake();
  requestAnimationFrame(frame);

  // For the tests: a read-only look at the running state.
  window.monsterEyesApp = {
    get renderer() { return renderer; },
    get frameCount() { return frameCount; },
    get paintCount() { return paintCount; },
    get blinkCount() { return blinkCount; },
    get packageKey() { return packages[current] ? packages[current].key : null; },
    get packageCount() { return packages.length; },
    get readyCount() { return packages.filter(isReady).length; },
    get variant() { return VARIANT; },
    get version() { return VERSION; },
    get background() { return background.css; },
    get prefs() { return JSON.parse(JSON.stringify(prefs)); },
    get wakeLocked() { return !!wakeLock || !!(wakeVideo && !wakeVideo.paused); },
    layout() { return renderer ? layoutFor(renderer.numEyes).map((r) => ({ ...r, radius: onScreen(r).radius })) : []; },
    select(i) { selectPackage(i); },
    // Index of an eye by its id ("big_blue") or its shown name ("Big Blue").
    indexOf(name) {
      const want = String(name).toLowerCase().replace(/ \*$/, '');
      return packages.findIndex((p) => p.id.toLowerCase() === want ||
        prettyName(p).toLowerCase().replace(/ \*$/, '') === want);
    },
    get transitioning() { return !!transition; },
    // Pretend the current eye has been showing ms longer than it has.
    slideshowSkip(ms) { slideClock -= ms; },
    nextSlide(from) { return nextSlide(from); },
    names() { return packages.map((p) => ({ key: p.key, name: prettyName(p), included: isIncluded(p), state: p.state })); },
  };
})();
