(function () {
  'use strict';

  const LANE_WIDTH = 3.2;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const laneX = lane => (clamp(lane, 0, 2) - 1) * LANE_WIDTH;
  const charge = (value, seconds, boosting) => clamp(value + seconds * (boosting ? -0.34 : 0.085), 0, 1);
  const scoreFor = (distance, shards) => clamp(Math.floor(distance * 0.45) + shards * 125, 0, 999999);
  const blendBoost = (value, seconds, boosting) => value + ((boosting ? 1 : 0) - value) * (1 - Math.exp(-seconds * 8));

  function sceneryAt(distance, slot, side = 0) {
    const spacing = side === 0 ? 7.5 : 34;
    // A surviving object moves down one slot at each wrap, so its world ID adds the offset.
    const id = slot + Math.floor(distance / spacing);
    const z = 18 + distance % spacing - slot * spacing;
    if (side === 0) return { id, z, isLime: id % 4 === 0 };
    return {
      id, z,
      h: 5 + ((id * 7 + (side + 1) * 3) % 11),
      x: side * (10 + (id % 3) * 4.3),
      width: 2.3 + (id % 2),
      roofWidth: 2.65 + (id % 2),
      isCyan: id % 3 !== 0
    };
  }

  function makeRow(distance, random = Math.random) {
    const safeLane = Math.floor(random() * 3);
    const others = [0, 1, 2].filter(lane => lane !== safeLane);
    if (random() < 0.5) others.splice(Math.floor(random() * 2), 1);
    return {
      distance,
      barriers: others,
      shards: [10, 17, 24].map(offset => ({ lane: safeLane, offset, collected: false }))
    };
  }

  // Intersect the entire motion segment, not just the frame's final position.
  function sweptHit(x0, x1, z0, z1, targetX, halfX, halfZ) {
    let enter = 0;
    let exit = 1;
    for (const [start, end, half] of [[x0 - targetX, x1 - targetX, halfX], [z0, z1, halfZ]]) {
      const change = end - start;
      if (Math.abs(change) < 0.000001) {
        if (Math.abs(start) > half) return false;
      } else {
        const a = (-half - start) / change;
        const b = (half - start) / change;
        enter = Math.max(enter, Math.min(a, b));
        exit = Math.min(exit, Math.max(a, b));
        if (enter > exit) return false;
      }
    }
    return true;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { clamp, laneX, charge, scoreFor, makeRow, sweptHit, sceneryAt, blendBoost };
    return;
  }

  function boot() {
    const $ = id => document.getElementById(id);
    const canvas = $('game-canvas');
    const frame = $('game-frame');
    if (!canvas || !frame) return;
    const ui = {
      score: $('score-value'), best: $('best-value'), speed: $('speed-value'),
      boost: $('boost-fill'), status: $('game-status'), overlay: $('game-overlay'),
      eyebrow: $('overlay-eyebrow'), title: $('overlay-title'), description: $('overlay-description'),
      play: $('play-button'), pause: $('pause-button'), restart: $('restart-button'),
      sound: $('sound-button'), left: $('steer-left'), right: $('steer-right'), boostButton: $('boost-button')
    };
    const idleCopy = [ui.eyebrow, ui.title, ui.description, ui.play].map(element => element ? element.textContent : '');
    let state = 'idle';
    let best = 0;
    try { best = clamp(Math.floor(Number(localStorage.getItem('neon-drift-best')) || 0), 0, 999999); } catch (_) { /* Storage is optional on file URLs. */ }
    let lane = 1;
    let shipX = 0;
    let distance = 0;
    let sceneDistance = 0;
    let elapsed = 0;
    let score = 0;
    let shardCount = 0;
    let energy = 1;
    let speed = 38;
    let boosting = false;
    let boostBlend = 0;
    let exhausted = false;
    let rows = Array.from({ length: 7 }, (_, i) => makeRow(110 + i * 54));
    let impact = 0;
    let collectionFlash = 0;
    let clock = 0;
    let lastTime = 0;
    let animation = 0;
    let renderer = null;
    let contextLost = false;
    let audio = null;
    let soundOn = false;
    const keys = new Set();
    const boostPointers = new Set();

    function text(element, value) {
      if (element && element.textContent !== value) element.textContent = value;
    }

    function clearInput() {
      keys.clear();
      boostPointers.clear();
      boosting = false;
      exhausted = false;
      if (ui.boostButton) ui.boostButton.setAttribute('aria-pressed', 'false');
    }

    function saveBest() {
      if (score <= best) return;
      best = score;
      try { localStorage.setItem('neon-drift-best', String(best)); } catch (_) { /* The run still works without storage. */ }
    }

    function setState(next) {
      state = next;
      clearInput();
      if (ui.overlay) {
        ui.overlay.classList.toggle('hidden', next === 'running');
        ui.overlay.hidden = next === 'running';
      }
      const copy = {
        idle: [...idleCopy, 'READY TO DRIFT'],
        running: ['', '', '', '', 'DRIFT IN PROGRESS'],
        paused: ['HOLDING POSITION', 'DRIFT PAUSED', 'Your run is safe. Take a breath, then chase the horizon.', 'RESUME RUN', 'RUN PAUSED'],
        over: ['SIGNAL LOST', 'END OF THE ROAD', 'Score ' + String(score).padStart(6, '0') + '. Find the open lane and go again.', 'TRY AGAIN', 'RUN ENDED'],
        unsupported: ['RENDERER OFFLINE', 'WEBGL UNAVAILABLE', 'This browser could not start 3D graphics. Try a current browser with hardware acceleration enabled. No download or internet connection is needed.', '3D UNAVAILABLE', '3D GRAPHICS UNAVAILABLE']
      }[next];
      if (next !== 'running') {
        text(ui.eyebrow, copy[0]);
        text(ui.title, copy[1]);
        text(ui.description, copy[2]);
        text(ui.play, copy[3]);
      }
      text(ui.status, copy[4]);
      if (ui.play) ui.play.disabled = next === 'unsupported';
      if (ui.pause) {
        const label = next === 'paused' ? 'Resume run' : 'Pause run';
        ui.pause.setAttribute('aria-pressed', String(next === 'paused'));
        ui.pause.setAttribute('aria-label', label);
        ui.pause.title = label;
        ui.pause.disabled = next !== 'running' && next !== 'paused';
      }
      if (ui.restart) ui.restart.disabled = next === 'unsupported';
      for (const button of [ui.left, ui.right, ui.boostButton]) {
        if (button) button.disabled = next !== 'running';
      }
    }

    function hud() {
      text(ui.score, String(score).padStart(6, '0'));
      text(ui.best, String(Math.max(best, score)).padStart(6, '0'));
      text(ui.speed, String(state === 'idle' ? 0 : Math.round(speed * 5)).padStart(3, '0'));
      if (ui.boost) ui.boost.style.width = (energy * 100).toFixed(1) + '%';
      if (ui.boostButton) ui.boostButton.setAttribute('aria-pressed', String(boosting));
    }

    function tone(frequency, duration, volume, endFrequency) {
      if (!soundOn || !audio || audio.state !== 'running') return;
      try {
        const oscillator = audio.createOscillator();
        const gain = audio.createGain();
        const now = audio.currentTime;
        oscillator.type = 'triangle';
        oscillator.frequency.setValueAtTime(frequency, now);
        oscillator.frequency.exponentialRampToValueAtTime(endFrequency || frequency, now + duration);
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(volume, now + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
        oscillator.connect(gain);
        gain.connect(audio.destination);
        oscillator.start(now);
        oscillator.stop(now + duration + 0.02);
        oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
      } catch (_) { /* Audio must never interrupt a run. */ }
    }

    function soundLabel() {
      if (!ui.sound) return;
      const label = soundOn ? 'Mute sound' : 'Enable sound';
      ui.sound.setAttribute('aria-pressed', String(soundOn));
      ui.sound.setAttribute('aria-label', label);
      ui.sound.title = label;
    }

    function audioUnavailable() {
      soundOn = false;
      if (!ui.sound) return;
      ui.sound.disabled = true;
      ui.sound.setAttribute('aria-pressed', 'false');
      ui.sound.setAttribute('aria-label', 'Sound unavailable in this browser');
      ui.sound.title = 'Sound unavailable in this browser';
    }

    if (ui.sound) ui.sound.addEventListener('click', async () => {
      if (soundOn) {
        soundOn = false;
        soundLabel();
        return;
      }
      try {
        const Audio = window.AudioContext || window.webkitAudioContext;
        if (!Audio) { audioUnavailable(); return; }
        if (!audio) audio = new Audio();
        await audio.resume();
        soundOn = true;
        soundLabel();
        tone(440, 0.12, 0.045, 660);
      } catch (_) { audioUnavailable(); }
    });
    soundLabel();

    function start() {
      if (!renderer || contextLost || state === 'unsupported') return;
      saveBest();
      lane = 1;
      shipX = 0;
      distance = 0;
      sceneDistance = 0;
      elapsed = 0;
      score = 0;
      shardCount = 0;
      energy = 1;
      speed = 38;
      boostBlend = 0;
      impact = 0;
      collectionFlash = 0;
      rows = Array.from({ length: 7 }, (_, i) => makeRow(110 + i * 54));
      setState('running');
      lastTime = performance.now();
      if (audio && soundOn) audio.resume().catch(() => {});
      tone(220, 0.22, 0.055, 660);
      canvas.focus({ preventScroll: true });
      hud();
    }

    function resume() {
      if (state !== 'paused' || contextLost || !renderer || document.hidden) return;
      setState('running');
      lastTime = performance.now();
      canvas.focus({ preventScroll: true });
    }

    function pause() {
      if (state === 'running') setState('paused');
    }

    function steer(direction) {
      if (state !== 'running') return;
      lane = clamp(lane + direction, 0, 2);
      tone(160 + lane * 45, 0.06, 0.018, 120 + lane * 45);
    }

    if (!canvas.hasAttribute('tabindex')) canvas.tabIndex = 0;
    if (ui.play) ui.play.addEventListener('click', () => state === 'paused' ? resume() : start());
    if (ui.restart) ui.restart.addEventListener('click', start);
    if (ui.pause) ui.pause.addEventListener('click', () => state === 'running' ? pause() : resume());

    function editable(target) {
      return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable="true"]');
    }

    window.addEventListener('keydown', event => {
      if (editable(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
      const focused = document.activeElement;
      const inGame = frame.contains(focused) || [ui.play, ui.pause, ui.restart, ui.sound, ui.left, ui.right, ui.boostButton].includes(focused);
      if (!inGame) return;
      const code = event.code;
      if (code === 'Escape' || code === 'KeyP') {
        if (state !== 'running' && state !== 'paused') return;
        event.preventDefault();
        if (!event.repeat) state === 'running' ? pause() : resume();
        return;
      }
      if (state !== 'running') return;
      if (!['ArrowLeft', 'ArrowRight', 'KeyA', 'KeyD', 'ShiftLeft', 'ShiftRight'].includes(code)) return;
      event.preventDefault();
      if (event.repeat || keys.has(code)) return;
      keys.add(code);
      if (code === 'ArrowLeft' || code === 'KeyA') steer(-1);
      if (code === 'ArrowRight' || code === 'KeyD') steer(1);
    });
    window.addEventListener('keyup', event => keys.delete(event.code));

    for (const [button, direction] of [[ui.left, -1], [ui.right, 1]]) {
      if (!button) continue;
      button.addEventListener('pointerdown', event => {
        if (state !== 'running' || event.button !== 0) return;
        event.preventDefault();
        steer(direction);
      });
      button.addEventListener('click', event => {
        if (event.detail === 0) steer(direction);
      });
    }
    if (ui.boostButton) {
      ui.boostButton.addEventListener('pointerdown', event => {
        if (state !== 'running' || event.button !== 0) return;
        event.preventDefault();
        boostPointers.add(event.pointerId);
        try { ui.boostButton.setPointerCapture(event.pointerId); } catch (_) { /* Global release is also handled. */ }
      });
      ui.boostButton.addEventListener('lostpointercapture', event => boostPointers.delete(event.pointerId));
      ui.boostButton.addEventListener('keydown', event => {
        if (state === 'running' && (event.code === 'Space' || event.code === 'Enter')) keys.add('ButtonBoost');
      });
      ui.boostButton.addEventListener('keyup', event => {
        if (event.code === 'Space' || event.code === 'Enter') keys.delete('ButtonBoost');
      });
      ui.boostButton.addEventListener('blur', () => keys.delete('ButtonBoost'));
    }
    window.addEventListener('pointerup', event => boostPointers.delete(event.pointerId));
    window.addEventListener('pointercancel', event => boostPointers.delete(event.pointerId));
    window.addEventListener('blur', () => { clearInput(); pause(); });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { clearInput(); pause(); saveBest(); }
      lastTime = performance.now();
    });
    window.addEventListener('pagehide', saveBest);

    function update(seconds) {
      if (state === 'idle') {
        sceneDistance += seconds * 18;
        shipX = Math.sin(clock * 0.5) * 0.45;
        for (const row of rows) row.distance -= seconds * 18;
      } else if (state === 'running') {
        elapsed += seconds;
        const held = keys.has('ShiftLeft') || keys.has('ShiftRight') || keys.has('ButtonBoost') || boostPointers.size > 0;
        if (!held) exhausted = false;
        boosting = held && !exhausted && energy > 0;
        energy = charge(energy, seconds, boosting);
        if (energy === 0) exhausted = true;
        boostBlend = blendBoost(boostBlend, seconds, boosting);
        speed = Math.min(72, 38 + elapsed * 0.38) + boostBlend * 25;
        const travel = speed * seconds;
        const oldX = shipX;
        shipX += (laneX(lane) - shipX) * (1 - Math.exp(-seconds * 13));
        distance += travel;
        sceneDistance += travel;
        for (const row of rows) {
          const previous = row.distance;
          row.distance -= travel;
          for (const barrier of row.barriers) {
            if (sweptHit(oldX, shipX, previous, row.distance, laneX(barrier), 1.6, 1.75)) {
              score = scoreFor(distance, shardCount);
              saveBest();
              impact = 1;
              setState('over');
              tone(150, 0.38, 0.065, 35);
              return;
            }
          }
          for (const shard of row.shards) {
            if (!shard.collected && sweptHit(oldX, shipX, previous - shard.offset, row.distance - shard.offset, laneX(shard.lane), 0.93, 1.5)) {
              shard.collected = true;
              shardCount += 1;
              energy = clamp(energy + 0.13, 0, 1);
              collectionFlash = 1;
              tone(660 + (shardCount % 3) * 165, 0.11, 0.045, 1200);
            }
          }
        }
        score = scoreFor(distance, shardCount);
      }
      if (state === 'idle' || state === 'running') {
        while (rows[0].distance < -16) {
          rows.shift();
          rows.push(makeRow(rows[rows.length - 1].distance + 54));
        }
      }
    }

    function createRenderer(gl) {
      function program(vertexSource, fragmentSource) {
        const shaders = [];
        const result = gl.createProgram();
        try {
          for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]]) {
            const shader = gl.createShader(type);
            shaders.push(shader);
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
            gl.attachShader(result, shader);
          }
          gl.linkProgram(result);
          if (!gl.getProgramParameter(result, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(result));
          return result;
        } catch (error) {
          gl.deleteProgram(result);
          throw error;
        } finally {
          shaders.forEach(shader => gl.deleteShader(shader));
        }
      }

      const skyProgram = program(`
        attribute vec2 aPoint;
        varying vec2 vUV;
        void main() { vUV = aPoint * 0.5 + 0.5; gl_Position = vec4(aPoint, 0.999, 1.0); }
      `, `
        precision mediump float;
        varying vec2 vUV;
        uniform float uAspect;
        uniform float uTime;
        void main() {
          vec3 horizon = vec3(0.60, 0.47, 0.65);
          vec3 sky = mix(horizon, vec3(0.16, 0.19, 0.36), smoothstep(0.46, 1.0, vUV.y));
          sky = mix(vec3(0.27, 0.27, 0.43), sky, smoothstep(0.0, 0.5, vUV.y));
          vec2 moon = (vUV - vec2(0.75, 0.77)) * vec2(uAspect, 1.0);
          float radius = length(moon);
          sky += vec3(0.18, 0.10, 0.13) * exp(-radius * 10.0);
          vec3 disk = mix(vec3(1.0, 0.77, 0.73), vec3(1.0, 0.94, 0.83), smoothstep(-0.12, 0.12, moon.y));
          sky = mix(sky, disk, 1.0 - smoothstep(0.118, 0.120, radius));
          vec2 grid = vUV * vec2(260.0 * uAspect, 260.0);
          float star = fract(sin(dot(floor(grid), vec2(127.1, 311.7))) * 4375.5);
          float point = 1.0 - smoothstep(0.05, 0.22, length(fract(grid) - 0.5));
          sky += vec3(0.55, 0.72, 0.85) * point * step(0.997, star) * smoothstep(0.68, 0.9, vUV.y) * (0.65 + 0.2 * sin(uTime + star * 130.0));
          gl_FragColor = vec4(sky, 1.0);
        }
      `);
      const worldProgram = program(`
        attribute vec3 aPosition;
        attribute vec3 aNormal;
        attribute vec3 aColor;
        attribute float aGlow;
        uniform mat4 uMatrix;
        varying vec3 vColor;
        varying float vDepth;
        void main() {
          float light = 0.48 + 0.52 * max(0.0, dot(aNormal, normalize(vec3(-0.4, 0.85, 0.3))));
          vColor = aColor * mix(light, 1.2, aGlow);
          vDepth = max(0.0, -aPosition.z);
          gl_Position = uMatrix * vec4(aPosition, 1.0);
        }
      `, `
        precision mediump float;
        varying vec3 vColor;
        varying float vDepth;
        uniform float uImpact;
        void main() {
          float fog = 1.0 - exp(-vDepth * vDepth * 0.000028);
          vec3 color = mix(vColor, vec3(0.60, 0.47, 0.65), min(0.97, fog));
          color = mix(color, vec3(1.0, 0.22, 0.38), uImpact * 0.25);
          gl_FragColor = vec4(color, 1.0);
        }
      `);

      const skyBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, skyBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const skyPoint = gl.getAttribLocation(skyProgram, 'aPoint');
      const skyAspect = gl.getUniformLocation(skyProgram, 'uAspect');
      const skyTime = gl.getUniformLocation(skyProgram, 'uTime');
      const worldBuffer = gl.createBuffer();
      const vertices = new Float32Array(600000);
      gl.bindBuffer(gl.ARRAY_BUFFER, worldBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, vertices.byteLength, gl.DYNAMIC_DRAW);
      const attributes = ['aPosition', 'aNormal', 'aColor', 'aGlow'].map(name => gl.getAttribLocation(worldProgram, name));
      const matrixLocation = gl.getUniformLocation(worldProgram, 'uMatrix');
      const impactLocation = gl.getUniformLocation(worldProgram, 'uImpact');
      const matrix = new Float32Array(16);
      let cursor = 0;
      const navy = [0.045, 0.062, 0.13];
      const metal = [0.11, 0.15, 0.23];
      const cyan = [0.19, 0.9, 0.96];
      const lime = [0.78, 1, 0.38];
      const pink = [1, 0.21, 0.46];
      const pale = [0.75, 0.80, 0.91];

      function triangle(a, b, c, color, glow = 0) {
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
        const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const length = Math.hypot(nx, ny, nz) || 1;
        nx /= length; ny /= length; nz /= length;
        for (const point of [a, b, c]) {
          vertices[cursor++] = point[0]; vertices[cursor++] = point[1]; vertices[cursor++] = point[2];
          vertices[cursor++] = nx; vertices[cursor++] = ny; vertices[cursor++] = nz;
          vertices[cursor++] = color[0]; vertices[cursor++] = color[1]; vertices[cursor++] = color[2];
          vertices[cursor++] = glow;
        }
      }

      function quad(a, b, c, d, color, glow = 0) {
        triangle(a, b, c, color, glow);
        triangle(a, c, d, color, glow);
      }

      function box(x, y, z, width, height, depth, color, glow = 0) {
        const l = x - width / 2, r = x + width / 2, b = y - height / 2, t = y + height / 2;
        const f = z + depth / 2, k = z - depth / 2;
        const a = [l, b, f], c = [r, b, f], d = [r, t, f], e = [l, t, f];
        const h = [l, b, k], i = [r, b, k], j = [r, t, k], m = [l, t, k];
        quad(a, c, d, e, color, glow);
        quad(i, h, m, j, color, glow);
        quad(e, d, j, m, color, glow);
        quad(h, i, c, a, color, glow);
        quad(c, i, j, d, color, glow);
        quad(h, a, e, m, color, glow);
      }

      function mountain(x, z, width, height, color) {
        const peak = [x + width * 0.12, height - 12, z];
        const a = [x - width, -14, z + width * 0.45];
        const b = [x + width, -14, z + width * 0.45];
        const c = [x + width * 0.7, -14, z - width * 0.4];
        const d = [x - width * 0.6, -14, z - width * 0.4];
        triangle(a, b, peak, color);
        triangle(b, c, peak, color);
        triangle(c, d, peak, color);
        triangle(d, a, peak, color);
      }

      function crystal(x, z, phase) {
        const y = 1.14 + Math.sin(clock * 3 + phase) * 0.1;
        const angle = clock * 1.5 + phase;
        const points = [];
        for (let i = 0; i < 4; i++) {
          const a = angle + i * Math.PI / 2;
          points.push([x + Math.cos(a) * 0.36, y, z + Math.sin(a) * 0.36]);
        }
        for (let i = 0; i < 4; i++) {
          triangle(points[i], points[(i + 1) % 4], [x, y + 0.62, z], i % 2 ? cyan : lime, 0.9);
          triangle(points[(i + 1) % 4], points[i], [x, y - 0.62, z], i % 2 ? lime : cyan, 0.65);
        }
        box(x, 0.018, z, 0.52, 0.016, 0.75, [0.12, 0.32, 0.29], 0.45);
      }

      function craft() {
        const roll = state === 'running' ? clamp((laneX(lane) - shipX) * -0.13, -0.25, 0.25) : Math.sin(clock * 1.4) * 0.025;
        const bob = Math.sin(clock * 4) * 0.055;
        const cos = Math.cos(roll), sin = Math.sin(roll);
        const p = (x, y, z) => [shipX + x * cos - (y - 0.7) * sin, 0.7 + x * sin + (y - 0.7) * cos + bob, z];
        const nose = p(0, 0.60, -1.75);
        const lf = p(-0.53, 0.73, -0.68), rf = p(0.53, 0.73, -0.68);
        const lb = p(-0.66, 0.63, 1.15), rb = p(0.66, 0.63, 1.15);
        const bottom = p(0, 0.29, 0.65), back = p(0, 0.69, 1.25);
        triangle(nose, rf, lf, pale);
        quad(lf, rf, rb, lb, [0.46, 0.53, 0.68]);
        triangle(nose, bottom, rf, metal);
        triangle(nose, lf, bottom, metal);
        triangle(lf, lb, bottom, [0.18, 0.24, 0.4]);
        triangle(rf, bottom, rb, [0.23, 0.29, 0.44]);
        triangle(lb, rb, bottom, navy);
        triangle(lb, back, rb, pink, 0.7);
        for (const side of [-1, 1]) {
          const tip = p(side * 1.12, 0.44, 0.88);
          triangle(p(side * 0.43, 0.61, -0.46), p(side * 0.60, 0.58, 1.14), tip, [0.63, 0.69, 0.8]);
          triangle(p(side * 0.43, 0.60, -0.46), tip, p(side * 0.89, 0.49, 0.0), side < 0 ? pink : cyan, 0.8);
          const length = 1.15 + boostBlend * 1.75 + Math.sin(clock * 39) * 0.16;
          const a = p(side * 0.47 - 0.19, 0.52, 1.17);
          const b = p(side * 0.47 + 0.19, 0.52, 1.17);
          const c = p(side * 0.47, 0.53, 1.17 + length);
          triangle(a, b, c, pink, 1);
          triangle(p(side * 0.47, 0.34, 1.17), p(side * 0.47, 0.72, 1.17), c, cyan, 1);
          triangle(p(side * 0.47 - 0.075, 0.53, 1.2), p(side * 0.47 + 0.075, 0.53, 1.2), p(side * 0.47, 0.54, 1.17 + length * 0.75), pale, 1);
        }
        const ca = p(0, 0.78, -0.83), cb = p(-0.33, 0.76, 0.53), cc = p(0.33, 0.76, 0.53), ct = p(0, 1.13, 0.25);
        triangle(ca, ct, cb, [0.08, 0.37, 0.51], 0.35);
        triangle(ca, cc, ct, [0.18, 0.66, 0.75], 0.5);
        triangle(cb, ct, cc, [0.05, 0.15, 0.25]);
        triangle(p(-0.035, 0.75, -0.70), p(0.035, 0.75, -0.70), p(0, 0.635, -1.56), cyan, 1);
        box(shipX, 0.028, 0.15, 1.65, 0.02, 2.45, [0.02, 0.11 + collectionFlash * 0.15, 0.18], 0.55);
      }

      function camera(aspect) {
        const eye = [shipX * 0.15, 4.2 - boostBlend * 0.15, 9];
        const target = [shipX * 0.24, 0.7, -24];
        let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
        let length = Math.hypot(zx, zy, zz);
        zx /= length; zy /= length; zz /= length;
        length = Math.hypot(zz, zx);
        const xx = zz / length, xz = -zx / length;
        const yx = zy * xz, yy = zz * xx - zx * xz, yz = -zy * xx;
        const view = [xx, yx, zx, 0, 0, yy, zy, 0, xz, yz, zz, 0,
          -(xx * eye[0] + xz * eye[2]), -(yx * eye[0] + yy * eye[1] + yz * eye[2]), -(zx * eye[0] + zy * eye[1] + zz * eye[2]), 1];
        const f = Math.min(1, aspect / 0.9) / Math.tan((58 + boostBlend * 5) * Math.PI / 360);
        const near = 1, far = 600;
        const projection = [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, 2 * far * near / (near - far), 0];
        for (let col = 0; col < 4; col++) {
          for (let row = 0; row < 4; row++) {
            let value = 0;
            for (let k = 0; k < 4; k++) value += projection[k * 4 + row] * view[col * 4 + k];
            matrix[col * 4 + row] = value;
          }
        }
      }

      return function render() {
        if (!canvas.width || !canvas.height) return;
        const aspect = canvas.width / canvas.height;
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        gl.disable(gl.DEPTH_TEST);
        gl.useProgram(skyProgram);
        for (const attribute of attributes) gl.disableVertexAttribArray(attribute);
        gl.bindBuffer(gl.ARRAY_BUFFER, skyBuffer);
        gl.enableVertexAttribArray(skyPoint);
        gl.vertexAttribPointer(skyPoint, 2, gl.FLOAT, false, 0, 0);
        gl.uniform1f(skyAspect, aspect);
        gl.uniform1f(skyTime, clock);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.disableVertexAttribArray(skyPoint);
        gl.enable(gl.DEPTH_TEST);
        gl.useProgram(worldProgram);
        cursor = 0;

        box(0, -16, -180, 900, 1, 900, [0.17, 0.18, 0.3]);
        for (let i = 0; i < 17; i++) {
          mountain(-272 + i * 34, -240 - (i % 3) * 25, 29 + (i % 4) * 8, 31 + ((i * 19) % 51), [0.31, 0.30, 0.45]);
        }
        for (const side of [-1, 1]) {
          for (let i = 0; i < 5; i++) mountain(side * (53 + i * 35), -132 - i * 24, 20 + i * 3, 24 + ((i * 11) % 35), [0.28, 0.26, 0.41]);
        }
        box(0, -0.38, -157, 11.8, 0.7, 350, navy);
        box(0, 0.002, -157, 3.18, 0.025, 350, [0.052, 0.073, 0.15]);
        for (const side of [-1, 1]) {
          box(side * 5.67, 0.08, -157, 0.45, 0.20, 350, metal);
          box(side * 5.37, 0.12, -157, 0.065, 0.08, 350, cyan, 0.85);
          box(side * 5.92, -0.14, -157, 0.055, 0.07, 350, pink, 0.6);
        }
        for (let i = 0; i < 46; i++) {
          const { z, isLime } = sceneryAt(sceneDistance, i);
          for (const side of [-1, 1]) {
            box(side * 1.6, 0.026, z, 0.045, 0.015, 3.4, [0.38, 0.5, 0.66], 0.35);
            box(side * 5.70, 0.19, z, 0.21, 0.025, 4.8, isLime ? lime : cyan, 0.9);
          }
        }
        for (let i = 0; i < 22; i++) {
          const z = 18 + sceneDistance % 16 - i * 16;
          box(0, 0.023, z, 10.6, 0.01, 0.035, [0.1, 0.15, 0.24]);
        }

        for (let i = 0; i < 6; i++) {
          const z = 24 + sceneDistance % 65 - i * 65;
          for (const side of [-1, 1]) {
            box(side * 6.4, 0.45, z, 0.38, 12.4, 0.5, metal);
            box(side * 6.16, 3.2, z + 0.27, 0.055, 6.4, 0.06, cyan, 0.8);
            box(side * 6.4, 0.17, z, 1.15, 0.34, 1.45, metal);
            triangle([side * 6.4, 6.7, z + 0.28], [side * 4.7, 6.7, z + 0.28], [side * 6.4, 5.25, z + 0.28], [0.13, 0.22, 0.31]);
          }
          box(0, 6.72, z, 13.15, 0.25, 0.45, metal);
          box(0, 6.55, z + 0.24, 11.9, 0.055, 0.05, cyan, 0.9);
          box(0, 6.73, z + 0.25, 1.7, 0.14, 0.04, lime, 1);
        }

        for (let i = 0; i < 11; i++) {
          for (const side of [-1, 1]) {
            const { z, h, x, width, roofWidth, isCyan } = sceneryAt(sceneDistance, i, side);
            box(x, h / 2 - 5, z, width, h, 3.2, [0.105, 0.14, 0.23]);
            box(x + side * 0.88, h / 2 - 4.5, z + 1.64, 0.09, h * 0.68, 0.05, isCyan ? cyan : pink, 0.7);
            box(x, h - 4.9, z, roofWidth, 0.25, 3.45, metal);
            box(x, h - 3.9, z, 0.07, 1.7, 0.08, [0.3, 0.39, 0.54]);
            box(x, h - 3.0, z, 0.17, 0.15, 0.17, lime, 1);
            for (let j = 0; j < 3; j++) box(x - 0.4, h - 6.1 - j * 0.8, z + 1.64, 0.65, 0.08, 0.04, [0.38, 0.47, 0.68], 0.6);
          }
        }

        for (const row of rows) {
          if (row.distance > 330) continue;
          for (const barrier of row.barriers) {
            const x = laneX(barrier), z = -row.distance;
            box(x, 0.18, z, 2.25, 0.32, 1.5, metal);
            box(x, 0.78, z, 2.05, 1.0, 1.0, [0.74, 0.16, 0.29]);
            box(x, 1.30, z, 2.08, 0.065, 1.04, pink, 1);
            box(x, 0.39, z + 0.52, 1.84, 0.04, 0.04, pink, 1);
            for (const side of [-1, 1]) {
              quad([x + side * 0.1, 0.93, z + 0.51], [x + side * 0.27, 0.93, z + 0.51], [x + side * 0.62, 0.58, z + 0.51], [x + side * 0.45, 0.58, z + 0.51], [1, 0.61, 0.58], 0.8);
            }
          }
          for (const shard of row.shards) {
            if (!shard.collected && row.distance - shard.offset > -9) crystal(laneX(shard.lane), -row.distance + shard.offset, shard.offset);
          }
        }
        craft();
        camera(aspect);
        gl.bindBuffer(gl.ARRAY_BUFFER, worldBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertices.subarray(0, cursor));
        for (let i = 0; i < attributes.length; i++) {
          gl.enableVertexAttribArray(attributes[i]);
          gl.vertexAttribPointer(attributes[i], i === 3 ? 1 : 3, gl.FLOAT, false, 40, i * 12);
        }
        gl.uniformMatrix4fv(matrixLocation, false, matrix);
        gl.uniform1f(impactLocation, impact);
        gl.drawArrays(gl.TRIANGLES, 0, cursor / 10);
      };
    }

    function resize() {
      const rect = frame.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
      const width = Math.max(1, Math.round(rect.width * dpr));
      const height = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
    }

    function setupRenderer() {
      try {
        const gl = canvas.getContext('webgl', { alpha: false, antialias: true, depth: true, powerPreference: 'high-performance' });
        if (!gl) throw new Error('WebGL is not available');
        renderer = createRenderer(gl);
        resize();
        return true;
      } catch (error) {
        renderer = null;
        setState('unsupported');
        console.warn('NEON DRIFT: 3D graphics could not start.', error);
        return false;
      }
    }

    function animate(time) {
      animation = requestAnimationFrame(animate);
      const seconds = Math.min(Math.max((time - lastTime) / 1000, 0), 0.05);
      lastTime = time;
      if (document.hidden || contextLost || !renderer) return;
      clock += seconds;
      impact = Math.max(0, impact - seconds * 1.6);
      collectionFlash = Math.max(0, collectionFlash - seconds * 3);
      // Small simulation steps keep steering and simultaneous collection/collision fair.
      let remaining = seconds;
      while (remaining > 0) {
        const step = Math.min(remaining, 1 / 120);
        update(step);
        remaining -= step;
      }
      renderer();
      hud();
    }

    canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      contextLost = true;
      pause();
      clearInput();
      cancelAnimationFrame(animation);
      if (ui.overlay) { ui.overlay.hidden = false; ui.overlay.classList.remove('hidden'); }
      text(ui.eyebrow, 'GRAPHICS INTERRUPTED');
      text(ui.title, 'HOLD TIGHT');
      text(ui.description, 'The graphics connection was interrupted. Your run is paused while the browser restores it.');
      text(ui.status, 'RESTORING 3D GRAPHICS');
      if (ui.play) ui.play.disabled = true;
      if (ui.pause) ui.pause.disabled = true;
      if (ui.restart) ui.restart.disabled = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      contextLost = false;
      if (setupRenderer()) {
        setState(state);
        lastTime = performance.now();
        animation = requestAnimationFrame(animate);
      }
    });
    if ('ResizeObserver' in window) new ResizeObserver(resize).observe(frame);
    window.addEventListener('resize', resize);
    setState('idle');
    hud();
    if (setupRenderer()) {
      renderer();
      lastTime = performance.now();
      animation = requestAnimationFrame(animate);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
}());
