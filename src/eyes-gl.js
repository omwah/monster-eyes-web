/**
 * eyes-gl.js -- draws a Renderer's eyes with WebGL2.
 *
 * The CPU still runs the animators and works out everything that is the same
 * across a frame (Renderer.eyeParams) or a column (Renderer.lidSpans). The
 * GPU does only the per-pixel part of Renderer.renderEye, from the same
 * tables, with integer maths that matches the JavaScript bit for bit, so the
 * two renderers draw identical pixels.
 */
(function (root) {
  'use strict';

  const ME = (root.MonsterEyes = root.MonsterEyes || {});

  const VERTEX = `#version 300 es
void main() {
  // One triangle that covers the whole canvas.
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

  // A port of the loop body of Renderer.renderEye. Row y counts up from the
  // bottom there, as gl_FragCoord.y does here.
  const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
precision highp isampler2D;
precision highp usampler2D;

uniform isampler2D uDisplace, uPolarDist, uFlowSin, uSpans;
uniform usampler2D uPolarAngle, uIris, uSclera, uFlowPhase;
uniform int uPad, uHalf, uMapRadius;
uniform int uXPos, uYPos, uIPupil, uIrisAngle, uScleraAngle, uIrisMirror, uScleraMirror;
uniform int uDiscCut, uDiscScale, uRollSin, uRollCos;
uniform bool uRolled, uIrisDilation, uTexturedPupil;
uniform int uFlowAmp, uFlowWaveQ, uFlowTime;
uniform uvec4 uPupilColor, uBackColor, uEyelidColor;
out vec4 outColor;

const int OUTSIDE = -32768;

vec4 word(uvec4 c) { return vec4(c) / 255.0; }

vec4 sclera(int row, int a) {
  ivec2 sz = textureSize(uSclera, 0);
  return word(texelFetch(uSclera, ivec2((a * sz.x) >> 10, row), 0));
}

void main() {
  int x = int(gl_FragCoord.x) - uPad, y = int(gl_FragCoord.y) - uPad;
  ivec2 span = texelFetch(uSpans, ivec2(x + uPad, 0), 0).rg;
  if (span.x >= span.y || y < span.x || y > span.y) {
    outColor = word(uEyelidColor);
    return;
  }

  int dxBase, xmul;
  if (x < uHalf) {
    dxBase = uHalf - 1 - x;
    xmul = -1;
  } else {
    dxBase = x - uHalf;
    xmul = 1;
  }
  int doff, dy;
  if (y < uHalf) {
    doff = uHalf - 1 - y;
    dy = -texelFetch(uDisplace, ivec2(doff, dxBase), 0).r;
  } else {
    doff = y - uHalf;
    dy = texelFetch(uDisplace, ivec2(doff, dxBase), 0).r;
  }
  int dx = texelFetch(uDisplace, ivec2(dxBase, doff), 0).r;
  if (dx == OUTSIDE) {
    outColor = word(uEyelidColor); // Outside the eyeball
    return;
  }
  dx *= xmul;
  int mR = uMapRadius;
  int mx = uXPos + x + dx;
  int my = uYPos + y + dy;
  if (uRolled) {
    // >> on a signed int extends the sign, as JavaScript's does.
    int cx = mx - mR, cy = my - mR;
    mx = mR + ((cx * uRollCos - cy * uRollSin) >> 15);
    my = mR + ((cx * uRollSin + cy * uRollCos) >> 15);
  }
  if (mx < 0 || mx >= 2 * mR || my < 0 || my >= 2 * mR) {
    outColor = word(uBackColor); // Off the map
    return;
  }

  int angle, dist;
  if (my >= mR) {
    if (mx >= mR) {
      mx -= mR;
      my -= mR;
      angle = int(texelFetch(uPolarAngle, ivec2(mx, my), 0).r);
      dist = texelFetch(uPolarDist, ivec2(mx, my), 0).r;
    } else {
      mx = mR - 1 - mx;
      my -= mR;
      angle = int(texelFetch(uPolarAngle, ivec2(my, mx), 0).r) + 768;
      dist = texelFetch(uPolarDist, ivec2(mx, my), 0).r;
    }
  } else if (mx < mR) {
    mx = mR - 1 - mx;
    my = mR - 1 - my;
    angle = int(texelFetch(uPolarAngle, ivec2(mx, my), 0).r) + 512;
    dist = texelFetch(uPolarDist, ivec2(mx, my), 0).r;
  } else {
    mx -= mR;
    my = mR - 1 - my;
    angle = int(texelFetch(uPolarAngle, ivec2(my, mx), 0).r) + 256;
    dist = texelFetch(uPolarDist, ivec2(mx, my), 0).r;
  }

  ivec2 irisSize = textureSize(uIris, 0);
  int irisW = irisSize.x, irisH = irisSize.y;
  if (dist >= 0) {
    int a = ((angle + uScleraAngle) & 1023) ^ uScleraMirror;
    outColor = sclera((dist * textureSize(uSclera, 0).y) >> 7, a);
  } else if (dist > -128 && uIrisDilation) {
    int depth = -dist - 1;
    if (depth < uDiscCut) {
      int sa = ((angle + uScleraAngle) & 1023) ^ uScleraMirror;
      outColor = sclera(textureSize(uSclera, 0).y - 1, sa);
    } else {
      int a = ((angle + uIrisAngle) & 1023) ^ uIrisMirror;
      // JavaScript's >>> works on the product wrapped to 32 bits; so does uint.
      int row = int((uint(depth - uDiscCut) * uint(uDiscScale)) >> 15u);
      if (row >= irisH) row = irisH - 1;
      outColor = word(texelFetch(uIris, ivec2((a * irisW) >> 10, row), 0));
    }
  } else if (dist > -128) {
    // floor(-dist * iPupil / 32768), split so the product cannot overflow.
    int n = -dist;
    int ty = n * (uIPupil >> 15) + ((n * (uIPupil & 32767)) >> 15);
    if (ty >= irisH && !uTexturedPupil) {
      outColor = word(uPupilColor);
    } else {
      if (ty >= irisH) ty = irisH - 1;
      int a = ((angle + uIrisAngle) & 1023) ^ uIrisMirror;
      int tx = (a * irisW) >> 10;
      int row = ty;
      if (uFlowAmp != 0) {
        int phase = int(texelFetch(uFlowPhase, ivec2((angle >> 4) & 63, 0), 0).r);
        int at = (((ty * uFlowWaveQ) >> 8) + phase + uFlowTime) & 255;
        int fade = irisH - ty;
        int num = texelFetch(uFlowSin, ivec2(at, 0), 0).r * uFlowAmp * fade;
        int q = abs(num) / (irisH * 127); // Truncating, whatever the sign
        row += num < 0 ? -q : q;
        if (row < 0) row = 0;
        else if (row >= irisH) row = irisH - 1;
      }
      outColor = word(texelFetch(uIris, ivec2(tx, row), 0));
    }
  } else {
    outColor = word(uBackColor); // Back of eye
  }
}`;

  // A packed RGBA word, as the renderer's buffers hold, as four bytes.
  const bytes = (w) => [w & 255, (w >>> 8) & 255, (w >>> 16) & 255, w >>> 24];

  // Software WebGL (SwiftShader, llvmpipe and the like) is often slower than
  // drawing in JavaScript, so Auto only picks the GPU when it is a real one.
  let probed = null;
  function probe() {
    if (probed) return probed;
    probed = { available: false, accelerated: false, name: '' };
    try {
      const c = document.createElement('canvas');
      let gl = c.getContext('webgl2', { failIfMajorPerformanceCaveat: true });
      probed.accelerated = !!gl;
      if (!gl) gl = c.getContext('webgl2');
      if (gl) {
        probed.available = true;
        const info = gl.getExtension('WEBGL_debug_renderer_info');
        probed.name = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
        if (/swiftshader|llvmpipe|softpipe|software|basic render/i.test(probed.name)) probed.accelerated = false;
        probed.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        const lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      }
    } catch (e) { /* No WebGL2 */ }
    return probed;
  }

  class GLEye {
    /** { available, accelerated, name } for this browser's WebGL2. */
    static probe() {
      return probe();
    }

    /** Whether this renderer's tables fit the GPU's textures. */
    static fits(r) {
      const p = probe();
      const D = r.half + r.pad;
      return p.available && Math.max(D, r.mapRadius, r.canvasSize, r.iris.width, r.iris.height,
        r.sclera.width, r.sclera.height) <= p.maxTexture;
    }

    /**
     * Draw eye e of renderer r into canvas, which is r.canvasSize square.
     * Throws if WebGL2 is not there.
     */
    constructor(canvas, r, e) {
      this.canvas = canvas;
      this.r = r;
      this.e = e;
      this.lost = false;
      this.destroyed = false;
      const gl = (this.gl = canvas.getContext('webgl2', {
        alpha: r.clearLids, premultipliedAlpha: false, antialias: false, depth: false, stencil: false,
      }));
      if (!gl) throw new Error('no WebGL2');
      canvas.addEventListener('webglcontextlost', () => { if (!this.destroyed) this.lost = true; });

      const shader = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      const prog = (this.prog = gl.createProgram());
      gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERTEX));
      gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAGMENT));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      gl.useProgram(prog);
      this.u = {};
      const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) {
        const name = gl.getActiveUniform(prog, i).name;
        this.u[name] = gl.getUniformLocation(prog, name);
      }

      // Integer textures, read with texelFetch: no filtering, no conversion.
      let unit = 0;
      const texture = (name, w, h, internal, format, type, data) => {
        const t = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
        gl.uniform1i(this.u[name], unit++);
        return t;
      };
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      const D = r.half + r.pad, M = r.mapRadius;
      const rgba = (tex) => new Uint8Array(tex.data.buffer, tex.data.byteOffset, tex.width * tex.height * 4);
      texture('uDisplace', D, D, gl.R16I, gl.RED_INTEGER, gl.SHORT, r.displace);
      texture('uPolarAngle', M, M, gl.R8UI, gl.RED_INTEGER, gl.UNSIGNED_BYTE, r.polarAngle);
      texture('uPolarDist', M, M, gl.R8I, gl.RED_INTEGER, gl.BYTE, r.polarDist);
      texture('uIris', r.iris.width, r.iris.height, gl.RGBA8UI, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, rgba(r.iris));
      texture('uSclera', r.sclera.width, r.sclera.height, gl.RGBA8UI, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, rgba(r.sclera));
      texture('uFlowSin', 256, 1, gl.R8I, gl.RED_INTEGER, gl.BYTE, r.flowSin);
      texture('uFlowPhase', 64, 1, gl.R8UI, gl.RED_INTEGER, gl.UNSIGNED_BYTE, r.flowPhase);
      this.spans = new Int32Array(r.canvasSize * 2);
      this.spanUnit = unit;
      this.spanTex = texture('uSpans', r.canvasSize, 1, gl.RG32I, gl.RG_INTEGER, gl.INT, this.spans);

      // What does not change from frame to frame.
      gl.uniform1i(this.u.uPad, r.pad);
      gl.uniform1i(this.u.uHalf, r.half);
      gl.uniform1i(this.u.uMapRadius, M);
      gl.viewport(0, 0, r.canvasSize, r.canvasSize);
    }

    /** Draw the eye as it is now; Renderer.updateEye has already run. */
    draw() {
      if (this.lost || this.destroyed) return;
      const gl = this.gl, u = this.u, r = this.r;
      const P = r.eyeParams(this.e);
      r.lidSpans(this.e, this.spans);
      gl.activeTexture(gl.TEXTURE0 + this.spanUnit);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, r.canvasSize, 1, gl.RG_INTEGER, gl.INT, this.spans);
      gl.uniform1i(u.uXPos, P.xPositionOverMap);
      gl.uniform1i(u.uYPos, P.yPositionOverMap);
      gl.uniform1i(u.uIPupil, P.iPupilFactor);
      gl.uniform1i(u.uIrisAngle, P.irisAngle);
      gl.uniform1i(u.uScleraAngle, P.scleraAngle);
      gl.uniform1i(u.uIrisMirror, P.irisMirror);
      gl.uniform1i(u.uScleraMirror, P.scleraMirror);
      gl.uniform1i(u.uDiscCut, P.discCut);
      gl.uniform1i(u.uDiscScale, P.discScale);
      gl.uniform1i(u.uRolled, P.rolled ? 1 : 0);
      gl.uniform1i(u.uRollSin, P.rollSin);
      gl.uniform1i(u.uRollCos, P.rollCos);
      gl.uniform1i(u.uIrisDilation, P.irisDilation ? 1 : 0);
      gl.uniform1i(u.uTexturedPupil, P.texturedPupil ? 1 : 0);
      gl.uniform1i(u.uFlowAmp, r.flowAmp);
      gl.uniform1i(u.uFlowWaveQ, r.flowWaveQ);
      gl.uniform1i(u.uFlowTime, r.flowTime);
      gl.uniform4uiv(u.uPupilColor, bytes(P.pupilColor));
      gl.uniform4uiv(u.uBackColor, bytes(P.backColor));
      gl.uniform4uiv(u.uEyelidColor, bytes(P.eyelidColor));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    /**
     * What draw() just drew, as RGBA rows top first, like the renderer's
     * buffers. Call it in the same task as draw(): the canvas is not kept.
     */
    read() {
      const gl = this.gl, W = this.r.canvasSize;
      const px = new Uint8Array(W * W * 4), out = new Uint8Array(W * W * 4);
      gl.readPixels(0, 0, W, W, gl.RGBA, gl.UNSIGNED_BYTE, px);
      for (let y = 0; y < W; y++) out.set(px.subarray(y * W * 4, (y + 1) * W * 4), (W - 1 - y) * W * 4);
      return out;
    }

    /** Give the context back now, rather than whenever it is collected. */
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      const lose = this.gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    }
  }

  ME.GLEye = GLEye;
})(typeof window !== 'undefined' ? window : globalThis);
