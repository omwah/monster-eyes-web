/**
 * eyes-renderer.js -- the Monster Eyes renderer and animator.
 *
 * A port of Adafruit_Monster_Eyes.cpp, plus the config half of
 * Eyes_Assets.cpp, from a C++ fork of Adafruit's Monster Eyes.
 * Method names follow the C++. The maths is the same; what differs is listed
 * here and nowhere else:
 *
 *  - The eye size is a parameter rather than capped at 240, so tables that
 *    were uint8 on the device are wider here, and the displacement table's
 *    "outside the eye" marker is -1 instead of 255.
 *  - There is no heap: no texture budget and no stepping the eye size down,
 *    except in parity mode, which reproduces the device's sclera cap.
 *  - Pixels are 32-bit RGBA words for an ImageData. Parity mode quantises
 *    textures to RGB565 first so frames can be compared with the simulator.
 *  - The fractal pupil animator steps once per frame on the device. A browser
 *    draws twice as often as the panel did, so outside parity mode it steps on
 *    a 30 Hz clock and is interpolated between steps.
 *  - A pair of eyes may each be given a small extra gaze offset, so they can
 *    converge on a pointer rather than look in parallel.
 *  - The eyeball is not cut off at the edge of its square. Stock geometry has
 *    an eye radius a little larger than half the square (125 against 120), so
 *    the device shows a flat edge at each side; here the buffer is padded out
 *    to hold the whole ball, and the lids carry on into the pad. Parity mode
 *    has no pad.
 */
(function (root) {
  'use strict';

  const ME = (root.MonsterEyes = root.MonsterEyes || {});
  const {
    parseJsonc, isNull, isInt, isFloat, isBool, isStr, isFlag, asFloat, asInt,
    asBool, dwim, pack565, bmpLoadEyelid, bmpLoadTexture, configPathFor,
    copyAssetPath, findFile, decodeText,
  } = ME;

  const f32 = Math.fround;
  const NOBLINK = 0, ENBLINK = 1, DEBLINK = 2;
  const IRIS_LEVELS = 7;
  const M_PI = Math.PI, M_PI_2 = Math.PI / 2;
  const HEAP = 8 * 1024 * 1024; // What the simulator's shim reports
  const HEAP_RESERVE = 10000;
  const IRIS_STEP_US = 1000000 / 30;
  const OUTSIDE = -32768; // Displacement table: no eyeball here

  // ---------------------------------------------------------------------------
  //  The simulator's random(): a 32-bit xorshift, so a seeded run here walks
  //  the same sequence a seeded eye-sim capture does.
  // ---------------------------------------------------------------------------
  class XorShift {
    constructor(seed) {
      this.seed(seed);
    }
    seed(s) {
      this.state = s >>> 0 || 1;
    }
    next() {
      let x = this.state;
      x ^= x << 13;
      x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5;
      x >>>= 0;
      this.state = x;
      return x;
    }
    // random(limit) and random(lower, upper), with Arduino's long arguments:
    // a float handed to either is truncated first.
    random(a, b) {
      if (b === undefined) {
        const limit = Math.trunc(a);
        if (limit <= 0) return 0;
        return this.next() % limit;
      }
      const lower = Math.trunc(a), upper = Math.trunc(b);
      if (upper <= lower) return lower;
      return lower + this.random(upper - lower);
    }
  }

  function defaultSettings() {
    return {
      displaySize: 0,
      eyeRadius: 0,
      irisRadius: 0,
      slitPupilRadius: 0,
      slitPupilHorizontal: false,
      slitPupilRounded: false,
      texturedPupil: false,
      irisDilation: false,
      gazeRange: 1.0,
      coverage: f32(0.6),
      coverageRequested: f32(0.6),
      pupilColor: 0x0000,
      backColor: 0x5000,
      eyelidColor: 0x0000,
      irisColor: 0x001f,
      scleraColor: 0xffff,
      pupilMin: f32(0.05),
      pupilMax: 0.25,
      tracking: true,
      trackFactor: 0.5,
      gazeMax: 3000000,
      irisSpin: 0.0,
      scleraSpin: 0.0,
      roll: 0.0,
      cyclovergence: 0.0,
      irisFlow: 0.0,
      irisFlowSpeed: 1.0,
      irisFlowWaves: 2.0,
      irisStartAngle: 512,
      scleraStartAngle: 512,
      irisMirror: 0,
      scleraMirror: 0,
      eyelidMirror: true,
      fixate: 7,
      irisFile: '',
      scleraFile: '',
      upperFile: '',
      lowerFile: '',
    };
  }

  function newEyeState() {
    return {
      eyeX: 0, eyeY: 0,
      blinkState: NOBLINK, blinkStartTime: 0, blinkDuration: 0, blinkFactor: 0,
      pupilFactor: 0.5, upperLidFactor: 1, lowerLidFactor: 1,
      irisSpin: 0, irisStartAngle: 0, irisAngle: 0,
      scleraSpin: 0, scleraStartAngle: 0, scleraAngle: 0,
    };
  }

  class Renderer {
    /**
     * @param {object} opts
     *   parity   reproduce the simulator exactly: 128 px pair, 240 px single,
     *            RGB565 textures, the device's sclera budget, frame-stepped
     *            pupil
     *   seed     random seed (the simulator's default is 1)
     */
    constructor(opts = {}) {
      this.parity = !!opts.parity;
      this.rng = new XorShift(opts.seed === undefined ? 1 : opts.seed);
      this.ready = false;
      this.error = null;
      this.warnings = [];
    }

    // =========================================================================
    //  STARTUP
    // =========================================================================

    /**
     * Build the eye from a package. The port of begin().
     *
     * @param pkg   { id, files: { "config.eye": bytes, "iris.bmp": bytes ... } }
     * @param opts  eyes: 'auto' | 1 | 2 -- 'auto' lets the package decide
     *              size: pixels per eye side (ignored in parity mode)
     *              configText: use this instead of the package's config.eye
     */
    load(pkg, opts = {}) {
      this.applyDefaults();
      this.pkg = pkg;
      this.configFile = configPathFor(pkg.id);
      this.warnings = [];
      const forced = opts.eyes === 1 || opts.eyes === 2 ? opts.eyes : 0;
      this.forcedEyes = forced;
      this.numEyes = forced || 2;
      this.seedVariants();

      const text = opts.configText !== undefined ? opts.configText
        : pkg.files['config.eye'] ? decodeText(pkg.files['config.eye']) : null;
      if (text !== null) {
        try {
          this.applyParsedConfig(parseJsonc(text));
        } catch (e) {
          this.warnings.push('config.eye: ' + e.message + '; using built-in defaults');
        }
      } else {
        this.warnings.push('no config.eye; using built-in defaults');
      }
      const s = this.settings;
      this.finalizeSettings();

      // How big an eye the "display" gives. The device's panel gives a pair
      // 128 px each and a single eye 240; a browser can afford more, so outside
      // parity mode the config is read in the device's single-eye space (240)
      // and then scaled to whatever size was asked for.
      const deviceMax = this.parity && this.numEyes === 2 ? 128 : 240;
      const target = this.parity ? deviceMax : Math.max(64, Math.round(opts.size || 240) & ~1);
      const sourceSize = s.displaySize > 0 ? s.displaySize
        : s.eyeRadius > (deviceMax * 3) / 4 ? 240 : deviceMax;
      const finalSize = this.parity ? Math.min(sourceSize, deviceMax) : target;
      if (sourceSize !== finalSize && (!this.parity || sourceSize > deviceMax)) {
        const scale = (v) => (v <= 0 ? v
          : Math.max(1, Math.trunc((v * finalSize + Math.trunc(sourceSize / 2)) / sourceSize)));
        s.eyeRadius = scale(s.eyeRadius);
        s.irisRadius = scale(s.irisRadius);
        s.slitPupilRadius = scale(s.slitPupilRadius);
        s.fixate = scale(s.fixate);
      }
      s.displaySize = finalSize;
      this.finalizeSettings();

      this.irisMin = f32(1 - s.pupilMax);
      this.irisRange = f32(s.pupilMax - s.pupilMin);

      if (!this.tablesInit()) {
        this.error = 'eye too small to draw';
        return false;
      }
      this.size = s.displaySize;
      this.half = this.size >> 1;
      this.gazeRadiusInit();
      this.mediaLoad(this.size);
      this.flowInit();

      for (let e = 0; e < this.numEyes; e++) {
        const E = (this.eye[e] = newEyeState());
        const v = this.variant[e];
        E.irisSpin = -1024 * v.irisSpin;
        E.irisStartAngle = v.irisStartAngle;
        E.irisAngle = E.irisStartAngle;
        E.scleraSpin = -1024 * v.scleraSpin;
        E.scleraStartAngle = v.scleraStartAngle;
        E.scleraAngle = E.scleraStartAngle;
        E.eyeX = E.eyeY = this.mapRadius;
      }
      this.eyeOldX = this.eyeNewX = this.eyeOldY = this.eyeNewY = this.mapRadius;
      this.frameEyeX = this.frameEyeY = this.mapRadius;
      // The buffer holds the square plus the pad on every side.
      this.canvasSize = this.size + 2 * this.pad;
      this.circleRadius = this.settings.eyeRadius + 1;
      this.hasLids = false;
      for (let x = 0; x < this.size; x++)
        if (this.upperOpen[x] !== this.upperClosed[x] || this.lowerOpen[x] !== this.lowerClosed[x]) {
          this.hasLids = true;
          break;
        }
      this.buffers = [];
      for (let e = 0; e < this.numEyes; e++)
        this.buffers.push(new Uint32Array(this.canvasSize * this.canvasSize));
      this.ready = true;
      return true;
    }

    applyDefaults() {
      this.settings = defaultSettings();
      this.ready = false;
      this.error = null;
      this.size = this.half = 0;
      this.gazeRadius = 1;
      this.eye = [newEyeState(), newEyeState()];
      this.variant = [{}, {}];
      this.eyeInMotion = false;
      this.eyeOldX = this.eyeOldY = this.eyeNewX = this.eyeNewY = 0;
      this.eyeMoveStartTime = 0;
      this.eyeMoveDuration = 0;
      this.lastSaccadeStop = 0;
      this.saccadeInterval = 0;
      this.timeOfLastBlink = this.timeToNextBlink = 0;
      this.frameEyeX = this.frameEyeY = 0;
      this.irisPrev = new Float32Array(IRIS_LEVELS);
      this.irisNext = new Float32Array(IRIS_LEVELS);
      this.irisFrame = 0;
      this.irisValue = 0.5;
      this.irisFrom = this.irisTo = 0.5;
      this.irisClock = -1;
      this.irisMin = 0;
      this.irisRange = 1;
      this.gazeExternal = this.pupilExternal = this.blinkExternal = false;
      this.autoBlink = this.autoGaze = true;
      this.singleEye = false;
      this.eyeGap = 0;
      this.eyeGapSet = false;
      this.blinkForced = 0;
      this.sideRight = false;
      this.sideSet = false;
      this.convergeX = [0, 0]; // Extra per-eye gaze, map pixels
      this.convergeY = [0, 0];
      this.flowAmp = 0;
      this.flowTime = 0;
      this.flowWaveQ = 0;
      this.flowSin = new Int8Array(256);
      this.flowPhase = new Uint8Array(64);
      this.now = 0;
    }

    // =========================================================================
    //  SETTINGS
    // =========================================================================

    static applyRightEyeOrientation(v) {
      v.irisSpin = -v.irisSpin;
      v.scleraSpin = -v.scleraSpin;
      v.roll = -v.roll;
      v.cyclovergence = -v.cyclovergence;
      v.irisStartAngle = (v.irisStartAngle + 512) & 1023;
      v.eyelidMirror = !v.eyelidMirror;
    }

    // With two eyes, eye 0 (the character's right, on the viewer's left) is
    // the mirror of eye 1.
    seedVariants() {
      const s = this.settings;
      for (let e = 0; e < 2; e++) {
        const v = (this.variant[e] = {
          irisSpin: s.irisSpin,
          scleraSpin: s.scleraSpin,
          roll: s.roll,
          cyclovergence: s.cyclovergence,
          irisStartAngle: s.irisStartAngle,
          scleraStartAngle: s.scleraStartAngle,
          irisMirror: s.irisMirror,
          scleraMirror: s.scleraMirror,
          eyelidMirror: s.eyelidMirror,
        });
        if (this.numEyes > 1) {
          if (e === 0) Renderer.applyRightEyeOrientation(v);
        } else if (this.sideRight) {
          Renderer.applyRightEyeOrientation(v);
        }
      }
    }

    finalizeSettings() {
      const s = this.settings;
      const maxDisplay = this.parity ? 240 : 1024;
      if (s.displaySize !== 0) {
        if (s.displaySize < 64) s.displaySize = 64;
        if (s.displaySize > maxDisplay) s.displaySize = maxDisplay;
        s.displaySize &= ~1;
      }
      if (s.eyeRadius <= 0) {
        if (s.displaySize > 0) s.eyeRadius = (s.displaySize >> 1) + 5;
      } else {
        s.eyeRadius = Math.abs(s.eyeRadius);
      }
      if (s.irisRadius <= 0) {
        if (s.displaySize > 0) s.irisRadius = Math.trunc(f32(f32(f32(0.4583) * s.displaySize) + 0.5));
      } else {
        s.irisRadius = Math.abs(s.irisRadius);
      }
      if (s.eyeRadius > 0 && s.irisRadius >= s.eyeRadius) s.irisRadius = s.eyeRadius - 1;
      if (s.slitPupilRadius < 0 && s.displaySize > 0)
        s.slitPupilRadius = Math.trunc(f32(f32(f32(0.4167) * s.displaySize) + 0.5));
      if (s.irisRadius > 0 && s.slitPupilRadius > s.irisRadius) s.slitPupilRadius = s.irisRadius;

      s.coverage = s.coverageRequested;
      if (s.displaySize === 0) return;
      const wantMapRadius = f32(f32(0.9818) * s.displaySize);
      const needCoverage = f32(wantMapRadius / f32(s.eyeRadius * f32(M_PI)));
      if (s.coverage < f32(needCoverage * f32(0.98))) s.coverage = needCoverage;
      if (s.coverage < 0.05) s.coverage = 0.05;
      else if (s.coverage > 1.0) s.coverage = 1.0;

      if (s.pupilMin < 0) s.pupilMin = 0;
      if (s.pupilMax > 1) s.pupilMax = 1;
      if (s.pupilMin > s.pupilMax) {
        const t = s.pupilMin;
        s.pupilMin = s.pupilMax;
        s.pupilMax = t;
      }
      if (s.trackFactor < 0) s.trackFactor = 0;
      else if (s.trackFactor > 1) s.trackFactor = 1;
    }

    // =========================================================================
    //  CONFIG
    // =========================================================================

    applyParsedConfig(doc) {
      if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) doc = {};
      this.applyConfigExtensions(doc);
      this.applyConfigRoot(doc);
      if (this.numEyes === 1) this.applyConfigRoot(doc[this.sideRight ? 'right' : 'left']);
      this.seedVariants();
      if (this.numEyes > 1) {
        this.applyConfigVariant(doc.right, this.variant[0]);
        this.applyConfigVariant(doc.left, this.variant[1]);
      }
    }

    applyConfigExtensions(o) {
      if (isNull(o) || typeof o !== 'object') return;
      const ext = o.extensions && typeof o.extensions === 'object' ? o.extensions : {};
      const display = ext.display && typeof ext.display === 'object' ? ext.display : null;
      const animation = ext.animation && typeof ext.animation === 'object' ? ext.animation : null;
      if (display) {
        const gap = display.eyeGap;
        if (isFloat(gap)) {
          this.eyeGap = asInt(gap);
          this.eyeGapSet = true;
        }
        let v = display.singleEye;
        if (isFlag(v)) this.singleEye = asBool(v);
        v = display.side;
        if (isStr(v)) {
          if (v[0] === 'l' || v[0] === 'L') {
            this.sideRight = false;
            this.sideSet = true;
          } else if (v[0] === 'r' || v[0] === 'R') {
            this.sideRight = true;
            this.sideSet = true;
          }
        }
      }
      // The display decides how many eyes there are; here that is the
      // package, unless the viewer has said otherwise.
      this.numEyes = this.forcedEyes || (this.singleEye ? 1 : 2);
      if (!animation) return;
      let v = animation.autoGaze;
      if (isFlag(v)) this.autoGaze = asBool(v);
      v = animation.autoBlink;
      if (isFlag(v)) this.autoBlink = asBool(v);
      v = animation.gazeRange;
      if (isFloat(v)) this.settings.gazeRange = asFloat(v);
      v = animation.cyclovergence;
      if (isFloat(v)) this.settings.cyclovergence = asFloat(v);
    }

    applyConfigRoot(o) {
      if (isNull(o) || typeof o !== 'object' || Array.isArray(o)) return;
      const s = this.settings;
      const num = (key, cur) => (isNull(o[key]) ? cur : dwim(o[key], cur));
      const flt = (key, cur) => (isFloat(o[key]) ? f32(asFloat(o[key])) : cur);
      const flag = (key, cur) => (isFlag(o[key]) ? asBool(o[key]) : cur);
      const angle = (v, cur) => (isInt(v) ? 1023 - (v & 1023)
        : isFloat(v) ? 1023 - (Math.trunc(f32(asFloat(v) * 1024)) & 1023) : cur);
      const mirror = (v, cur) => (isFlag(v) ? (asBool(v) ? 1023 : 0) : cur);

      s.displaySize = num('displaySize', s.displaySize);
      s.eyeRadius = num('eyeRadius', s.eyeRadius);
      s.irisRadius = num('irisRadius', s.irisRadius);
      s.slitPupilRadius = num('slitPupilRadius', s.slitPupilRadius);
      s.slitPupilHorizontal = flag('slitPupilHorizontal', s.slitPupilHorizontal);
      s.texturedPupil = flag('texturedPupil', s.texturedPupil);
      s.irisDilation = flag('irisDilation', s.irisDilation);
      s.slitPupilRounded = flag('slitPupilRounded', s.slitPupilRounded);
      s.gazeMax = num('gazeMax', s.gazeMax) >>> 0;
      s.fixate = num('fixate', s.fixate);
      if (isFloat(o.coverage)) {
        s.coverage = f32(asFloat(o.coverage));
        s.coverageRequested = s.coverage;
      }
      s.pupilColor = num('pupilColor', s.pupilColor) & 0xffff;
      s.backColor = num('backColor', s.backColor) & 0xffff;
      s.irisColor = num('irisColor', s.irisColor) & 0xffff;
      s.scleraColor = num('scleraColor', s.scleraColor) & 0xffff;
      if (!isNull(o.eyelidIndex)) s.eyelidColor = ((dwim(o.eyelidIndex) & 0xff) * 0x0101) & 0xffff;
      if (!isNull(o.eyelidColor)) s.eyelidColor = dwim(o.eyelidColor, s.eyelidColor) & 0xffff;
      s.pupilMin = flt('pupilMin', s.pupilMin);
      s.pupilMax = flt('pupilMax', s.pupilMax);
      if (isBool(o.tracking)) s.tracking = o.tracking;
      if (isFloat(o.squint)) s.trackFactor = f32(1 - asFloat(o.squint));
      s.irisSpin = flt('irisSpin', s.irisSpin);
      s.scleraSpin = flt('scleraSpin', s.scleraSpin);
      s.roll = flt('roll', s.roll);
      s.irisFlow = flt('irisFlow', s.irisFlow);
      s.irisFlowSpeed = flt('irisFlowSpeed', s.irisFlowSpeed);
      s.irisFlowWaves = flt('irisFlowWaves', s.irisFlowWaves);
      s.irisStartAngle = angle(o.irisAngle, s.irisStartAngle);
      s.scleraStartAngle = angle(o.scleraAngle, s.scleraStartAngle);
      s.irisMirror = mirror(o.irisMirror, s.irisMirror);
      s.scleraMirror = mirror(o.scleraMirror, s.scleraMirror);
      s.eyelidMirror = flag('eyelidMirror', s.eyelidMirror);
      // An absent key leaves what is there; anything else replaces it.
      const asset = (key, cur) => (isNull(o[key]) ? cur : copyAssetPath(o[key], this.configFile));
      s.irisFile = asset('irisTexture', s.irisFile);
      s.scleraFile = asset('scleraTexture', s.scleraFile);
      s.upperFile = asset('upperEyelid', s.upperFile);
      s.lowerFile = asset('lowerEyelid', s.lowerFile);
    }

    applyConfigVariant(o, v) {
      if (isNull(o) || typeof o !== 'object' || Array.isArray(o)) return;
      if (isFloat(o.irisSpin)) v.irisSpin = f32(asFloat(o.irisSpin));
      if (isFloat(o.scleraSpin)) v.scleraSpin = f32(asFloat(o.scleraSpin));
      if (isFloat(o.roll)) v.roll = f32(asFloat(o.roll));
      const angle = (x, cur) => (isInt(x) ? 1023 - (x & 1023)
        : isFloat(x) ? 1023 - (Math.trunc(f32(asFloat(x) * 1024)) & 1023) : cur);
      v.irisStartAngle = angle(o.irisAngle, v.irisStartAngle);
      v.scleraStartAngle = angle(o.scleraAngle, v.scleraStartAngle);
      if (isFlag(o.irisMirror)) v.irisMirror = asBool(o.irisMirror) ? 1023 : 0;
      if (isFlag(o.scleraMirror)) v.scleraMirror = asBool(o.scleraMirror) ? 1023 : 0;
      if (isFlag(o.eyelidMirror)) v.eyelidMirror = asBool(o.eyelidMirror);
    }

    // =========================================================================
    //  MEDIA
    // =========================================================================

    mediaLoad(size) {
      const s = this.settings;
      const lids = (this.lidBlock = new Int32Array(size * 4));
      this.upperOpen = lids.subarray(0, size);
      this.upperClosed = lids.subarray(size, size * 2);
      this.lowerOpen = lids.subarray(size * 2, size * 3);
      this.lowerClosed = lids.subarray(size * 3, size * 4);
      const loadLid = (path, open, closed, isUpper, label) => {
        if (path) {
          const bytes = findFile(this.pkg, path);
          if (bytes && bmpLoadEyelid(bytes, open, closed, size, isUpper)) return;
          this.warnings.push(label + ' eyelid ' + path + ' unusable -- no eyelid');
        }
        open.fill(isUpper ? size - 1 : 0);
        closed.fill(isUpper ? size - 1 : 0);
      };
      loadLid(s.upperFile, this.upperOpen, this.upperClosed, true, 'upper');
      loadLid(s.lowerFile, this.lowerOpen, this.lowerClosed, false, 'lower');

      // The device caps the sclera at a small share of its heap. Only parity
      // mode keeps that; otherwise both textures load at full resolution.
      let irisBudget = Infinity, scleraBudget = Infinity;
      if (this.parity) {
        const texBudget = HEAP - HEAP_RESERVE;
        scleraBudget = Math.min(Math.floor(texBudget / 8), 32768);
        irisBudget = texBudget - scleraBudget;
      }
      const load = (path, budget, color, label) => {
        if (path && budget > 512) {
          const bytes = findFile(this.pkg, path);
          const tex = bytes && bmpLoadTexture(bytes, budget, this.parity);
          if (tex) return tex;
          this.warnings.push(label + ' ' + path + ' unusable -- solid colour');
        }
        return { data: new Uint32Array([pack565(color)]), width: 1, height: 1 };
      };
      this.iris = load(s.irisFile, irisBudget, s.irisColor, 'iris');
      this.sclera = load(s.scleraFile, scleraBudget, s.scleraColor, 'sclera');
    }

    // =========================================================================
    //  TABLES
    // =========================================================================
    //
    // The round eyeball is faked with a 2D displacement map rather than real
    // 3D rotation. Both tables cover ONE QUADRANT and are mirrored at render
    // time. Float32 throughout, as on the device, so the tables come out the
    // same.

    screen2map(v) {
      const r = this.settings.eyeRadius;
      return f32(f32(f32(Math.atan2(v, f32(Math.sqrt(r * r - v * v)))) / f32(M_PI_2)) * this.mapRadius);
    }

    map2screen(v) {
      return f32(f32(f32(Math.sin(f32(v / this.mapRadius))) * f32(M_PI_2)) * this.settings.eyeRadius);
    }

    calcDisplacement() {
      const half = (this.settings.displaySize >> 1) + this.pad;
      const d = (this.displace = new Int16Array(half * half));
      const eyeRadius2 = f32(this.settings.eyeRadius * this.settings.eyeRadius);
      const mapRadius = this.mapRadius;
      const halfPi = f32(M_PI_2);
      let p = 0;
      for (let y = 0; y < half; y++) {
        const dy = f32(f32(y + 0.5) * f32(y + 0.5));
        for (let x = 0; x < half; x++) {
          let dx = f32(x + 0.5);
          const d2 = f32(f32(dx * dx) + dy);
          if (d2 <= eyeRadius2) {
            const dd = f32(Math.sqrt(d2));
            const h = f32(Math.sqrt(f32(eyeRadius2 - d2)));
            const a = f32(Math.atan2(dd, h));
            const pa = f32(f32(a / halfPi) * mapRadius);
            dx = f32(dx / dd);
            d[p++] = Math.trunc(f32(dx * pa)) - x;
          } else {
            d[p++] = OUTSIDE;
          }
        }
      }
    }

    calcMap() {
      const s = this.settings;
      const mapRadius = this.mapRadius;
      const pixels = mapRadius * mapRadius;
      const polarAngle = (this.polarAngle = new Uint8Array(pixels));
      const polarDist = (this.polarDist = new Int8Array(pixels));
      const mapRadius2 = f32(mapRadius * mapRadius);
      const iRad = this.screen2map(s.irisRadius);
      const irisRadius2 = f32(iRad * iRad);
      const halfPi = f32(M_PI_2);
      const angleScale = f32(512 / f32(M_PI));
      let p = 0;
      for (let y = 0; y < mapRadius; y++) {
        const dy = f32(y + 0.5), dy2 = f32(dy * dy);
        for (let x = 0; x < mapRadius; x++, p++) {
          const dx = f32(x + 0.5);
          const d2 = f32(f32(dx * dx) + dy2);
          if (d2 > mapRadius2) {
            polarAngle[p] = 0;
            polarDist[p] = -128;
          } else {
            let angle = f32(halfPi - f32(Math.atan2(dy, dx)));
            angle = f32(angle * angleScale);
            polarAngle[p] = Math.trunc(angle);
            let d = f32(Math.sqrt(d2));
            if (d2 > irisRadius2) {
              d = f32(f32(mapRadius - d) / f32(mapRadius - iRad));
              polarDist[p] = Math.trunc(f32(d * 127));
            } else {
              d = f32(f32(iRad - d) / iRad);
              polarDist[p] = Math.trunc(f32(d * -127)) - 1;
            }
          }
        }
      }

      if (s.slitPupilRadius > 0) {
        const horizontal = s.slitPupilHorizontal;
        const rounded = s.slitPupilRounded;
        const narrowest = f32(iRad * f32(0.03));
        const slit = s.slitPupilRadius;
        for (let y = 0; y < mapRadius; y++) {
          const dy = f32(y + 0.5);
          for (let x = 0; x < mapRadius; x++) {
            const dx = f32(x + 0.5);
            if (f32(f32(dx * dx) + f32(dy * dy)) > irisRadius2) continue;
            const across = horizontal ? dy : dx;
            const along = horizontal ? dx : dy;
            const along2 = f32(along * along);
            const across2 = f32(across * across);
            for (let i = 126; i >= 0; i--) {
              const ratio = f32(i / 128);
              let inside;
              if (rounded) {
                const len = f32(ratio * slit);
                const rad = f32(f32(iRad * f32(1 - ratio)) + f32(narrowest * ratio));
                const past = along > len ? f32(along - len) : 0;
                inside = f32(f32(past * past) + across2) <= f32(rad * rad);
              } else {
                const y1 = f32(iRad - f32(f32(iRad - slit) * ratio));
                const x2 = f32(iRad * f32(1 - ratio));
                const xc = f32(f32(f32(x2 * x2) - f32(y1 * y1)) / f32(2 * x2));
                const rx = f32(x2 - xc);
                const px = f32(across - xc);
                inside = f32(f32(px * px) + along2) <= f32(rx * rx);
              }
              if (inside) {
                polarDist[y * mapRadius + x] = -1 - i;
                break;
              }
            }
          }
        }
      }
    }

    tablesInit() {
      const s = this.settings;
      this.mapRadius = Math.trunc(f32(f32(f32(s.eyeRadius * f32(M_PI)) * s.coverage) + 0.5));
      this.mapDiameter = this.mapRadius * 2;
      if (this.mapRadius < 8) return false;
      // Room outside the square for the rest of the eyeball, plus a margin
      // so the clip circle has something to cut against.
      const half = s.displaySize >> 1;
      this.pad = this.parity ? 0 : Math.max(0, Math.ceil(s.eyeRadius - half)) + 2;
      this.calcMap();
      this.calcDisplacement();
      return true;
    }

    gazeRadiusInit() {
      const s = this.settings;
      let r = f32(f32(this.mapDiameter - f32(this.size * f32(M_PI_2))) * 0.75);
      const travel = f32(f32(0.2433) * this.size);
      let k = f32(travel / f32(f32(M_PI_2) * s.eyeRadius));
      if (k > f32(0.999)) k = f32(0.999);
      const rScreen = f32(this.mapRadius * f32(Math.asin(k)));
      if (r > f32(rScreen * f32(1.1))) r = rScreen;
      if (s.gazeRange >= 0 && s.gazeRange < 1) r = f32(r * s.gazeRange);
      if (r < 1) r = 1;
      this.gazeRadius = r;
    }

    // Tables for the radial flow: a skewed sine for the wave, and 64 sectors
    // each with its own phase, interpolated from sixteen random anchors.
    flowInit() {
      const s = this.settings;
      this.flowTime = 0;
      this.flowAmp = Math.trunc(f32(f32(s.irisFlow * this.iris.height) + 0.5));
      if (this.flowAmp < 0) this.flowAmp = 0;
      this.flowWaveQ = Math.trunc(f32(f32(s.irisFlowWaves * 256) + 0.5)) & 0xffff;
      if (!this.flowAmp) return;
      const twoPi = f32(2 * M_PI);
      for (let i = 0; i < 256; i++) {
        const x = f32(i / 256);
        const warped = f32(x + f32(f32(0.22) * f32(Math.sin(f32(x * twoPi)))));
        this.flowSin[i] = Math.trunc(f32(f32(Math.sin(f32(warped * twoPi))) * 127));
      }
      const anchors = new Uint8Array(16);
      for (let i = 0; i < 16; i++) anchors[i] = this.rng.random(256);
      for (let i = 0; i < 64; i++) {
        const a = i >> 2, f = i & 3;
        const lo = anchors[a], hi = anchors[(a + 1) & 15];
        this.flowPhase[i] = (lo + (((hi - lo) * f) >> 2)) & 0xff;
      }
    }

    // =========================================================================
    //  ONCE-PER-FRAME ANIMATION
    // =========================================================================

    updateGaze(t) {
      const rng = this.rng;
      const s = this.settings;
      const dt = t - this.eyeMoveStartTime;
      if (this.eyeInMotion) {
        if (dt >= this.eyeMoveDuration) {
          this.eyeInMotion = false;
          const limit = Math.min(1000000, s.gazeMax);
          this.eyeMoveDuration = rng.random(35000, limit);
          if (!this.saccadeInterval) {
            this.lastSaccadeStop = t;
            this.saccadeInterval = rng.random(this.eyeMoveDuration, s.gazeMax);
          }
          this.eyeMoveStartTime = t;
          this.frameEyeX = this.eyeOldX = this.eyeNewX;
          this.frameEyeY = this.eyeOldY = this.eyeNewY;
        } else {
          let e = f32(dt / this.eyeMoveDuration);
          e = f32(f32(3 * f32(e * e)) - f32(2 * f32(f32(e * e) * e)));
          this.frameEyeX = f32(this.eyeOldX + f32(f32(this.eyeNewX - this.eyeOldX) * e));
          this.frameEyeY = f32(this.eyeOldY + f32(f32(this.eyeNewY - this.eyeOldY) * e));
        }
      } else {
        this.frameEyeX = this.eyeOldX;
        this.frameEyeY = this.eyeOldY;
        if (dt > this.eyeMoveDuration) {
          const rFull = this.gazeRadius;
          if (t - this.lastSaccadeStop > this.saccadeInterval) {
            this.eyeNewX = rng.random(-rFull, rFull);
            const h2 = f32(f32(rFull * rFull) - f32(this.eyeNewX * this.eyeNewX));
            const h = h2 > 0 ? f32(Math.sqrt(h2)) : 0;
            this.eyeNewY = rng.random(-h, h);
            this.eyeMoveDuration = rng.random(83000, 166000);
            this.saccadeInterval = 0;
          } else {
            let rMicro = f32(rFull * f32(f32(0.07) / 0.75));
            if (rMicro < 1) rMicro = 1;
            const dx = rng.random(-rMicro, rMicro);
            const h2 = f32(f32(rMicro * rMicro) - dx * dx);
            const h = h2 > 0 ? f32(Math.sqrt(h2)) : 0;
            this.eyeNewX = f32(f32(this.frameEyeX - this.mapRadius) + dx);
            this.eyeNewY = f32(f32(this.frameEyeY - this.mapRadius) + rng.random(-h, h));
            this.eyeMoveDuration = rng.random(7000, 25000);
          }
          const d2 = f32(f32(this.eyeNewX * this.eyeNewX) + f32(this.eyeNewY * this.eyeNewY));
          if (d2 > f32(rFull * rFull)) {
            const k = f32(rFull / f32(Math.sqrt(d2)));
            this.eyeNewX = f32(this.eyeNewX * k);
            this.eyeNewY = f32(this.eyeNewY * k);
          }
          this.eyeNewX = f32(this.eyeNewX + this.mapRadius);
          this.eyeNewY = f32(this.eyeNewY + this.mapRadius);
          this.eyeMoveStartTime = t;
          this.eyeInMotion = true;
        }
      }
    }

    // Fractal noise for the pupil: seven octaves, each interpolating between
    // random values over a power-of-two number of steps.
    stepIris() {
      let sum = f32(0.5);
      for (let i = 0; i < IRIS_LEVELS; i++) {
        let iexp = 1 << (i + 1);
        const ibits = this.irisFrame & (iexp - 1);
        let n;
        if (ibits) {
          const weight = f32(ibits / iexp);
          n = f32(f32(this.irisPrev[i] * f32(1 - weight)) + f32(this.irisNext[i] * weight));
        } else {
          n = this.irisNext[i];
          this.irisPrev[i] = this.irisNext[i];
          this.irisNext[i] = f32(-0.5 + f32(this.rng.random(1000) / 999));
        }
        iexp = 1 << (IRIS_LEVELS - i);
        sum = f32(sum + f32(n / iexp));
      }
      if (++this.irisFrame >= 1 << IRIS_LEVELS) this.irisFrame = 0;
      return f32(this.irisMin + f32(sum * this.irisRange));
    }

    updateIris(t) {
      if (this.parity) {
        this.irisValue = this.stepIris();
        return;
      }
      // One step per 30 Hz tick, as the panel ran, interpolated between.
      if (this.irisClock < 0) {
        this.irisClock = t;
        this.irisFrom = this.irisTo = this.stepIris();
      }
      let steps = 0;
      while (t - this.irisClock >= IRIS_STEP_US && steps++ < 30) {
        this.irisClock += IRIS_STEP_US;
        this.irisFrom = this.irisTo;
        this.irisTo = this.stepIris();
      }
      if (t - this.irisClock >= IRIS_STEP_US) this.irisClock = t; // After a stall
      const k = (t - this.irisClock) / IRIS_STEP_US;
      this.irisValue = this.irisFrom + (this.irisTo - this.irisFrom) * k;
    }

    updateBlinks(t) {
      if (t - this.timeOfLastBlink >= this.timeToNextBlink) {
        this.timeOfLastBlink = t;
        const d = this.rng.random(36000, 72000);
        for (let e = 0; e < this.numEyes; e++) {
          const E = this.eye[e];
          if (E.blinkState === NOBLINK) {
            E.blinkState = ENBLINK;
            E.blinkStartTime = t;
            E.blinkDuration = d;
          }
        }
        this.timeToNextBlink = d * 3 + this.rng.random(4000000);
      }
    }

    updateEye(e, t) {
      const E = this.eye[e];
      const s = this.settings;
      if (this.numEyes > 1) {
        E.eyeX = f32(this.frameEyeX + (e & 1 ? s.fixate : -s.fixate));
      } else if (this.sideSet) {
        E.eyeX = f32(this.frameEyeX + (this.sideRight ? -s.fixate : s.fixate));
      } else {
        E.eyeX = this.frameEyeX;
      }
      E.eyeY = this.frameEyeY;
      // Convergence on a pointer: zero unless the app asks for it.
      if (this.convergeX[e] || this.convergeY[e]) {
        E.eyeX += this.convergeX[e];
        E.eyeY += this.convergeY[e];
        const cx = E.eyeX - this.mapRadius, cy = E.eyeY - this.mapRadius;
        const d = Math.hypot(cx, cy), lim = this.gazeRadius * 1.1;
        if (d > lim) {
          E.eyeX = this.mapRadius + (cx * lim) / d;
          E.eyeY = this.mapRadius + (cy * lim) / d;
        }
      }
      E.pupilFactor = this.irisValue;

      let uq, lq;
      if (s.tracking) {
        const size = this.size;
        let ix = Math.trunc(this.map2screen(Math.trunc(this.mapRadius - E.eyeX))) + this.half;
        let iy = Math.trunc(this.map2screen(Math.trunc(this.mapRadius - E.eyeY))) + this.half;
        iy += Math.trunc(f32(s.irisRadius * s.trackFactor));
        if (this.variant[e].eyelidMirror) ix = size - 1 - ix;
        if (ix < 0) ix = 0;
        else if (ix > size - 1) ix = size - 1;
        if (iy > this.upperOpen[ix]) uq = 1;
        else if (iy < this.upperClosed[ix]) uq = 0;
        else uq = f32((iy - this.upperClosed[ix]) / (this.upperOpen[ix] - this.upperClosed[ix]));
        lq = f32(1 - uq);
      } else {
        uq = lq = 1;
      }
      E.upperLidFactor = f32(f32(E.upperLidFactor * f32(0.6)) + f32(uq * f32(0.4)));
      E.lowerLidFactor = f32(f32(E.lowerLidFactor * f32(0.6)) + f32(lq * f32(0.4)));

      if (this.blinkExternal) E.blinkFactor = this.blinkForced;
      if (E.blinkState) {
        if (t - E.blinkStartTime >= E.blinkDuration) {
          if (++E.blinkState > DEBLINK) {
            E.blinkState = NOBLINK;
            if (!this.blinkExternal) E.blinkFactor = 0;
          } else {
            E.blinkDuration *= 2; // Opening is half the speed of closing
            E.blinkStartTime = t;
            if (!this.blinkExternal) E.blinkFactor = 1;
          }
        } else if (!this.blinkExternal) {
          E.blinkFactor = f32((t - E.blinkStartTime) / E.blinkDuration);
          if (E.blinkState === DEBLINK) E.blinkFactor = f32(1 - E.blinkFactor);
        }
      }

      const mins = f32(Math.floor(t / 1000) / 60000);
      E.irisAngle = Math.trunc(f32(f32(E.irisStartAngle + f32(E.irisSpin * mins)) + 0.5)) & 0xffff;
      E.scleraAngle = Math.trunc(f32(f32(E.scleraStartAngle + f32(E.scleraSpin * mins)) + 0.5)) & 0xffff;
    }

    // =========================================================================
    //  LIVE CONTROL
    // =========================================================================

    // Screen space: +x right, +y up as the viewer sees it, each -1..1. The
    // library's own setGaze() is the other way round on both axes; this is
    // the simulator's setScreenGaze().
    setScreenGaze(x, y) {
      x = -x;
      y = -y;
      const d2 = x * x + y * y;
      if (d2 > 1) {
        const k = 1 / Math.sqrt(d2);
        x *= k;
        y *= k;
      }
      this.frameEyeX = f32(this.mapRadius + f32(x * this.gazeRadius));
      this.frameEyeY = f32(this.mapRadius + f32(y * this.gazeRadius));
      this.gazeExternal = true;
    }

    // Where the gaze is now, in the same screen space.
    screenGaze() {
      if (this.gazeRadius <= 0) return { x: 0, y: 0 };
      return {
        x: -(this.frameEyeX - this.mapRadius) / this.gazeRadius,
        y: -(this.frameEyeY - this.mapRadius) / this.gazeRadius,
      };
    }

    // Per-eye convergence, in the same screen units as setScreenGaze().
    setConvergence(e, x, y) {
      this.convergeX[e] = -x * this.gazeRadius;
      this.convergeY[e] = -y * this.gazeRadius;
    }

    // Hand the gaze back to the animator, starting from wherever it is now so
    // the eye does not snap back to its last saccade.
    releaseGaze() {
      if (!this.gazeExternal) return;
      this.gazeExternal = false;
      this.eyeOldX = this.eyeNewX = this.frameEyeX;
      this.eyeOldY = this.eyeNewY = this.frameEyeY;
      this.eyeInMotion = false;
      this.eyeMoveStartTime = this.now;
      this.eyeMoveDuration = this.rng.random(150000, 600000);
      this.convergeX[0] = this.convergeX[1] = 0;
      this.convergeY[0] = this.convergeY[1] = 0;
    }

    setPupil(dilation) {
      dilation = Math.min(Math.max(dilation, 0), 1);
      this.irisValue = f32(this.irisMin + f32(f32(1 - dilation) * this.irisRange));
      this.pupilExternal = true;
    }

    blink(t = this.now) {
      const d = this.rng.random(36000, 72000);
      for (let e = 0; e < this.numEyes; e++) {
        const E = this.eye[e];
        if (E.blinkState === NOBLINK) {
          E.blinkState = ENBLINK;
          E.blinkStartTime = t;
          E.blinkDuration = d;
        }
      }
      this.timeOfLastBlink = t;
    }

    gazeY() {
      return this.gazeRadius <= 0 ? 0 : (this.frameEyeY - this.mapRadius) / this.gazeRadius;
    }

    // =========================================================================
    //  RENDER
    // =========================================================================
    //
    // Into a size x size buffer, top row first. The device renderer walks each
    // column from the BOTTOM of the eye upward (+Y is up in its maths), so row
    // y here is buffer row size - 1 - y.

    renderEye(e) {
      const E = this.eye[e];
      const s = this.settings;
      const half = this.half, size = this.size;
      const out = this.buffers[e];
      const xPositionOverMap = Math.trunc(E.eyeX - half);
      const yPositionOverMap = Math.trunc(E.eyeY - half);
      const upperLidFactor = f32(f32(1 - E.blinkFactor) * E.upperLidFactor);
      const lowerLidFactor = f32(f32(1 - E.blinkFactor) * E.lowerLidFactor);
      const iris = this.iris.data, irisW = this.iris.width, irisH = this.iris.height;
      const sclera = this.sclera.data, scleraW = this.sclera.width, scleraH = this.sclera.height;
      const pupilFactor = E.pupilFactor > f32(0.004) ? E.pupilFactor : f32(0.004);
      const iPupilFactor = Math.trunc(f32(f32(irisH * 256) * f32(1 / pupilFactor)));
      const irisAngle = E.irisAngle;
      const flowAmp = this.flowAmp, flowWaveQ = this.flowWaveQ, flowTime = this.flowTime;
      const flowSin = this.flowSin, flowPhase = this.flowPhase;
      const pupilColor = pack565(s.pupilColor);
      const texturedPupil = s.texturedPupil;
      const irisDilation = s.irisDilation && irisH > 0;
      const discSpan = f32(1 - E.pupilFactor);
      let discCut = Math.trunc(f32(f32(f32(1 - discSpan) * 127) + 0.5));
      if (discCut < 0) discCut = 0;
      else if (discCut > 126) discCut = 126;
      const discScale = Math.floor((irisH << 15) / (127 - discCut));
      const backColor = pack565(s.backColor);
      const eyelidColor = pack565(s.eyelidColor);
      const v = this.variant[e];
      const irisMirror = v.irisMirror, scleraMirror = v.scleraMirror;
      const scleraAngle = E.scleraAngle;
      const mirrorLids = v.eyelidMirror;
      const displace = this.displace, polarAngle = this.polarAngle, polarDist = this.polarDist;
      const mapRadius = this.mapRadius, mapDiameter = this.mapDiameter;
      const upperOpen = this.upperOpen, upperClosed = this.upperClosed;
      const lowerOpen = this.lowerOpen, lowerClosed = this.lowerClosed;
      const scleraLastRow = (scleraH - 1) * scleraW;

      let rollDeg = v.roll;
      if (v.cyclovergence !== 0) {
        const down = this.gazeY();
        if (down > 0) rollDeg += v.cyclovergence * (down > 1 ? 1 : down);
      }
      const rolled = rollDeg !== 0;
      const rollRad = (-rollDeg * M_PI) / 180;
      const rollSin = rolled ? Math.trunc(Math.sin(rollRad) * 32768) : 0;
      const rollCos = rolled ? Math.trunc(Math.cos(rollRad) * 32768) : 32768;
      const last = size - 1;
      const pad = this.pad, W = size + 2 * pad, D = half + pad;

      // x and y are in the square's own coordinates; outside it, in the pad,
      // they run negative or past the last column and row.
      // Lid edges in one column of the lid tables, before any clamping.
      const lowerAt = (c) => lowerClosed[c] +
        Math.trunc(f32(0.5 + f32(lowerLidFactor * (lowerOpen[c] - lowerClosed[c]))));
      const upperAt = (c) => upperClosed[c] +
        Math.trunc(f32(0.5 + f32(upperLidFactor * (upperOpen[c] - upperClosed[c]))));
      const SLOPE_SPAN = 4; // Columns over which the edge slope is measured

      for (let x = -pad; x < size + pad; x++) {
        let lidColumn = mirrorLids ? last - x : x;
        let y1, y2;
        if (lidColumn >= 0 && lidColumn <= last) {
          y1 = lowerAt(lidColumn);
          y2 = upperAt(lidColumn);
          if (y1 > last) y1 = last;
          else if (y1 < 0) y1 = 0;
          if (y2 > last) y2 = last;
          else if (y2 < 0) y2 = 0;
        } else {
          // Past the edge of the lid bitmaps: carry each lid on along the
          // slope it has at the edge, so the opening keeps closing rather
          // than running straight on. A lid absent at the edge stays absent.
          const edge = lidColumn < 0 ? 0 : last;
          const inner = lidColumn < 0 ? Math.min(SLOPE_SPAN, last) : Math.max(last - SLOPE_SPAN, 0);
          const k = Math.abs(lidColumn - edge) / Math.max(1, Math.abs(edge - inner));
          const l0 = lowerAt(edge), u0 = upperAt(edge);
          y1 = l0 <= 0 ? 0 : Math.round(l0 + (l0 - lowerAt(inner)) * k);
          y2 = u0 >= last ? last : Math.round(u0 + (u0 - upperAt(inner)) * k);
          if (y1 < 0) y1 = 0;
          if (y2 > last) y2 = last;
        }

        // Buffer index of render row y in this column: rows are stored top
        // first, and render y counts up from the bottom.
        let o = (W - 1) * W + (x + pad);
        if (y1 >= y2) {
          for (let y = -pad; y < size + pad; y++, o -= W) out[o] = eyelidColor;
          continue;
        }
        // A lid that is out of the way at the edge of the square stays out of
        // the way in the pad.
        if (y1 === 0) y1 = -pad;
        if (y2 === last) y2 = last + pad;

        let y = -pad;
        for (; y < y1; y++, o -= W) out[o] = eyelidColor;

        let dxBase, xmul;
        if (x < half) {
          dxBase = half - 1 - x;
          xmul = -1;
        } else {
          dxBase = x - half;
          xmul = 1;
        }
        const dyBase = dxBase * D;
        const xx = xPositionOverMap + x;

        for (; y <= y2; y++, o -= W) {
          const yy = yPositionOverMap + y;
          let doff, dy;
          if (y < half) {
            doff = half - 1 - y;
            dy = -displace[dyBase + doff];
          } else {
            doff = y - half;
            dy = displace[dyBase + doff];
          }
          let dx = displace[doff * D + dxBase];
          if (dx === OUTSIDE) {
            out[o] = eyelidColor; // Outside the eyeball
            continue;
          }
          dx *= xmul;
          let mx = xx + dx;
          let my = yy + dy;
          if (rolled) {
            const cx = mx - mapRadius, cy = my - mapRadius;
            mx = mapRadius + ((cx * rollCos - cy * rollSin) >> 15);
            my = mapRadius + ((cx * rollSin + cy * rollCos) >> 15);
          }
          if (mx < 0 || mx >= mapDiameter || my < 0 || my >= mapDiameter) {
            out[o] = backColor; // Off the map
            continue;
          }

          let angle, dist;
          if (my >= mapRadius) {
            if (mx >= mapRadius) {
              mx -= mapRadius;
              my -= mapRadius;
              const moff = my * mapRadius + mx;
              angle = polarAngle[moff];
              dist = polarDist[moff];
            } else {
              mx = mapRadius - 1 - mx;
              my -= mapRadius;
              angle = polarAngle[mx * mapRadius + my] + 768;
              dist = polarDist[my * mapRadius + mx];
            }
          } else if (mx < mapRadius) {
            mx = mapRadius - 1 - mx;
            my = mapRadius - 1 - my;
            const moff = my * mapRadius + mx;
            angle = polarAngle[moff] + 512;
            dist = polarDist[moff];
          } else {
            mx -= mapRadius;
            my = mapRadius - 1 - my;
            angle = polarAngle[mx * mapRadius + my] + 256;
            dist = polarDist[my * mapRadius + mx];
          }

          if (dist >= 0) {
            const a = ((angle + scleraAngle) & 1023) ^ scleraMirror;
            out[o] = sclera[((dist * scleraH) >> 7) * scleraW + ((a * scleraW) >> 10)];
          } else if (dist > -128 && irisDilation) {
            const depth = -dist - 1;
            if (depth < discCut) {
              const sa = ((angle + scleraAngle) & 1023) ^ scleraMirror;
              out[o] = sclera[scleraLastRow + ((sa * scleraW) >> 10)];
            } else {
              const a = ((angle + irisAngle) & 1023) ^ irisMirror;
              let row = ((depth - discCut) * discScale) >>> 15;
              if (row >= irisH) row = irisH - 1;
              out[o] = iris[row * irisW + ((a * irisW) >> 10)];
            }
          } else if (dist > -128) {
            let ty = Math.floor((-dist * iPupilFactor) / 32768);
            if (ty >= irisH && !texturedPupil) {
              out[o] = pupilColor;
            } else {
              if (ty >= irisH) ty = irisH - 1;
              const a = ((angle + irisAngle) & 1023) ^ irisMirror;
              const tx = (a * irisW) >> 10;
              let row = ty;
              if (flowAmp) {
                const at = (((ty * flowWaveQ) >> 8) + flowPhase[(angle >> 4) & 63] + flowTime) & 0xff;
                const fade = irisH - ty;
                row += Math.trunc((flowSin[at] * flowAmp * fade) / (irisH * 127));
                if (row < 0) row = 0;
                else if (row >= irisH) row = irisH - 1;
              }
              out[o] = iris[row * irisW + tx];
            }
          } else {
            out[o] = backColor; // Back of eye
          }
        }

        for (; y < size + pad; y++, o -= W) out[o] = eyelidColor;
      }
    }

    // =========================================================================
    //  FRAME
    // =========================================================================

    /** Advance the animators to time t (microseconds). */
    update(t) {
      if (!this.ready) return;
      this.now = t;
      if (this.flowAmp) {
        const ms = Math.floor(t / 1000) >>> 0;
        this.flowTime = (Math.trunc(f32(f32(ms * this.settings.irisFlowSpeed) * f32(0.256))) >>> 0) & 0xff;
      }
      if (this.autoGaze && !this.gazeExternal) this.updateGaze(t);
      if (this.autoBlink && !this.blinkExternal) this.updateBlinks(t);
      if (!this.pupilExternal) this.updateIris(t);
    }

    /** Draw every eye into this.buffers. */
    draw() {
      if (!this.ready) return;
      for (let e = 0; e < this.numEyes; e++) {
        this.updateEye(e, this.now);
        this.renderEye(e);
      }
    }

    animate(t) {
      this.update(t);
      this.draw();
    }

    /** Background the eyes sit on, as a packed RGBA word and as CSS. */
    background() {
      const c = this.settings.eyelidColor;
      const [r, g, b] = ME.rgb565to888(c);
      return { word: pack565(c), css: 'rgb(' + r + ',' + g + ',' + b + ')' };
    }
  }

  // The simulator's 320x240 panel, for parity tests: two 128 px eyes at
  // x=18 and x=174 (nudged together or apart by eyeGap), y=56, or one 240 px
  // eye centred. Cleared to the eyelid colour, eyes drawn over it in order.
  function composePanel(r, out) {
    const W = 320, H = 240;
    out = out || new Uint32Array(W * H);
    out.fill(r.background().word);
    const size = r.size;
    let nudge = 0;
    if (r.numEyes === 2 && r.eyeGapSet) {
      const DEFAULT_GAP = 174 - (18 + 128);
      let gap = r.eyeGap;
      if (gap < -(size >> 1)) gap = -(size >> 1);
      const limit = 18 * 2 + DEFAULT_GAP;
      if (gap > limit) gap = limit;
      nudge = Math.trunc((DEFAULT_GAP - gap) / 2);
    }
    for (let e = 0; e < r.numEyes; e++) {
      const x0 = r.numEyes === 1 ? (W - size) >> 1 : (e & 1 ? 174 - nudge : 18 + nudge);
      const y0 = r.numEyes === 1 ? (H - size) >> 1 : 56;
      const src = r.buffers[e];
      for (let row = 0; row < size; row++) {
        const y = y0 + row;
        if (y < 0 || y >= H) continue;
        out.set(src.subarray(row * size, row * size + size), y * W + x0);
      }
    }
    return out;
  }

  Object.assign(ME, { Renderer, XorShift, composePanel });
})(typeof window !== 'undefined' ? window : globalThis);
