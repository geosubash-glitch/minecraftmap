/* Minecraft Progression Map — intro
 *
 * A short 3D "progression" teaser: one block that transforms Oak Planks →
 * Stone → Iron Ore → Diamond → Obsidian → Grass, then fades into the map.
 *
 * Guard rails (the map must never be stuck behind this overlay):
 *   - skipped entirely for returning visitors, deep links and reduced motion
 *     (decided in <head> before first paint)
 *   - three.js is only downloaded when the intro actually plays
 *   - no WebGL / library download failure / timeout  → straight to the map
 *   - always-visible Skip button, Esc to skip, and it auto-advances on its own
 *   - wheel, swipe, arrow keys, Space and Enter all step it forward
 */
(function () {
  'use strict';

  var root = document.documentElement;
  var overlay = document.getElementById('intro-overlay');
  if (root.getAttribute('data-intro') !== 'play') { overlay.hidden = true; return; }

  var THREE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
  var LOAD_TIMEOUT = 6000;
  var AUTO_START_DELAY = 2600; // idle time before it starts stepping on its own
  var AUTO_STEP_DELAY = 1300;
  var BLOCK_NAMES = ['Oak Planks', 'Stone', 'Iron Ore', 'Diamond Block', 'Obsidian', 'Grass Block'];

  var tagEl = document.getElementById('intro-tag');
  var hintEl = document.getElementById('intro-hint');
  var dotsEl = document.getElementById('intro-dots');
  var skipBtn = document.getElementById('intro-skip');
  var titleCard = document.getElementById('intro-title-card');

  BLOCK_NAMES.forEach(function () { dotsEl.appendChild(document.createElement('i')); });
  function setDots(i) {
    Array.prototype.forEach.call(dotsEl.children, function (d, j) { d.classList.toggle('on', j === i); });
  }
  setDots(0);

  var finished = false;
  var cleanupFns = [];
  function on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    cleanupFns.push(function () { target.removeEventListener(type, fn, opts); });
  }

  // Hand over to the map. `fast` = user skipped / something failed.
  function end(fast) {
    if (finished) return;
    finished = true;
    try { localStorage.setItem('mcmap.introSeen', '1'); } catch (e) {}
    if (/[?&]intro=1\b/.test(location.search)) history.replaceState(history.state, '', location.pathname + location.hash);
    cleanupFns.forEach(function (f) { f(); });
    if (window.MCMap) window.MCMap.reveal();
    overlay.style.transitionDuration = fast ? '0.45s' : '';
    overlay.classList.add('fading');
    setTimeout(function () {
      overlay.hidden = true;
      root.setAttribute('data-intro', 'skip');
      if (disposeScene) disposeScene();
    }, fast ? 500 : 1250);
  }

  on(skipBtn, 'click', function () { end(true); });
  skipBtn.focus({ preventScroll: true });

  function webglAvailable() {
    try {
      var c = document.createElement('canvas');
      return !!(window.WebGLRenderingContext && (c.getContext('webgl') || c.getContext('experimental-webgl')));
    } catch (e) { return false; }
  }
  if (!webglAvailable()) { end(true); return; }

  var disposeScene = null;
  var timeout = setTimeout(function () { end(true); }, LOAD_TIMEOUT);
  var s = document.createElement('script');
  s.src = THREE_URL;
  s.async = true;
  s.onload = function () {
    clearTimeout(timeout);
    if (finished) return;
    try { start(window.THREE); } catch (e) { end(true); }
  };
  s.onerror = function () { clearTimeout(timeout); end(true); };
  document.head.appendChild(s);

  function start(THREE) {
    // ---- procedural 16×16 pixel-art textures (no image downloads) ----
    function mkCanvas(painter) {
      var c = document.createElement('canvas'); c.width = 16; c.height = 16;
      painter(c.getContext('2d')); return c;
    }
    function seeded(x, y, salt) { var v = Math.sin(x * 127.1 + y * 311.7 + salt * 74.3) * 43758.5453; return v - Math.floor(v); }
    function noisyFill(ctx, base, variants, salt) {
      for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
        var r = seeded(x, y, salt);
        ctx.fillStyle = r < 0.15 ? variants[0] : r < 0.3 ? variants[1] : base;
        ctx.fillRect(x, y, 1, 1);
      }
    }
    function speckle(ctx, n, colors, sx, sy, size) {
      for (var i = 0; i < n; i++) {
        var x = Math.floor(seeded(i, 0, sx) * (16 - size)), y = Math.floor(seeded(0, i, sy) * (16 - size));
        ctx.fillStyle = colors[0]; ctx.fillRect(x, y, size, size);
        if (colors[1]) { ctx.fillStyle = colors[1]; ctx.fillRect(x, y, 1, 1); }
      }
    }
    var painters = [
      function (ctx) { // oak planks
        noisyFill(ctx, '#a9762f', ['#8f5f24', '#bd8a42'], 1);
        ctx.fillStyle = '#7a5220';
        for (var y = 0; y < 16; y += 4) ctx.fillRect(0, y, 16, 1);
        for (var x = 0; x < 16; x += 8) ctx.fillRect(x, 0, 1, 16);
      },
      function (ctx) { noisyFill(ctx, '#8a8a8a', ['#787878', '#9c9c9c'], 2); },
      function (ctx) { noisyFill(ctx, '#8a8a8a', ['#787878', '#969696'], 3); speckle(ctx, 7, ['#d8b285', '#f0d3ae'], 7, 9, 2); },
      function (ctx) {
        noisyFill(ctx, '#63d9cf', ['#4bc4ba', '#8ce8e0'], 4);
        ctx.strokeStyle = '#3aa8a0'; ctx.lineWidth = 1; ctx.strokeRect(0.5, 0.5, 15, 15);
        speckle(ctx, 5, ['#e8fffb'], 11, 13, 1);
      },
      function (ctx) { noisyFill(ctx, '#160f23', ['#0d0916', '#2b1f42'], 5); speckle(ctx, 6, ['#4a3a72'], 17, 19, 1); }
    ];
    function grassSide(ctx) {
      noisyFill(ctx, '#6a4a2c', ['#5a3d24', '#7a5636'], 8);
      for (var x = 0; x < 16; x++) for (var y = 0; y < 4; y++) { ctx.fillStyle = seeded(x, y, 6) < 0.2 ? '#4c8535' : '#5a9c3f'; ctx.fillRect(x, y, 1, 1); }
      for (var x2 = 0; x2 < 16; x2++) { ctx.fillStyle = seeded(x2, 4, 20) < 0.5 ? '#4c8535' : '#6a4a2c'; ctx.fillRect(x2, 4, 1, 1); }
    }

    var disposables = [];
    function mat(painter) {
      var t = new THREE.CanvasTexture(mkCanvas(painter));
      t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter;
      var m = new THREE.MeshStandardMaterial({ map: t, roughness: 0.95, metalness: 0.05 });
      disposables.push(t, m);
      return m;
    }
    function uniform(painter) { var m = mat(painter); return [m, m, m, m, m, m]; }
    var accents = [0xd9a35a, 0xbfbfbf, 0xf0d3ae, 0x63e8e0, 0x8a5cf6, 0x6bd94f];
    var blocks = painters.map(uniform);
    blocks.push((function () {
      var side = mat(grassSide);
      var top = mat(function (ctx) { noisyFill(ctx, '#5a9c3f', ['#4c8535', '#6bb04a'], 6); });
      var bottom = mat(function (ctx) { noisyFill(ctx, '#6a4a2c', ['#5a3d24', '#7a5636'], 8); });
      return [side, side, top, bottom, side, side];
    })());

    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 100);
    var Z_FAR = 9.5, Z_NEAR = 3.3;
    camera.position.set(0, 0, Z_FAR);

    var renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.setAttribute('aria-hidden', 'true');
    overlay.insertBefore(renderer.domElement, overlay.firstChild);

    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    var dir1 = new THREE.DirectionalLight(0xffffff, 0.95); dir1.position.set(3, 4, 5); scene.add(dir1);
    var dir2 = new THREE.DirectionalLight(0x6688ff, 0.35); dir2.position.set(-4, -2, -3); scene.add(dir2);
    var accentLight = new THREE.PointLight(0xffffff, 0, 12); accentLight.position.set(0, 0, 3); scene.add(accentLight);

    var geo = new THREE.BoxGeometry(2, 2, 2);
    var cube = new THREE.Mesh(geo, blocks[0]);
    var REST = { x: 0.42, y: 0.6, z: 0 };
    cube.rotation.set(REST.x, REST.y, REST.z);
    scene.add(cube);

    // particle burst on each transformation
    var PCOUNT = 46;
    var pGeo = new THREE.BufferGeometry();
    var pPos = new Float32Array(PCOUNT * 3);
    pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
    var pMat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.09, transparent: true, opacity: 0 });
    scene.add(new THREE.Points(pGeo, pMat));
    disposables.push(geo, pGeo, pMat);
    var pVel = [];
    function burst(color) {
      pMat.color.set(color);
      for (var i = 0; i < PCOUNT; i++) {
        pPos[i * 3] = pPos[i * 3 + 1] = pPos[i * 3 + 2] = 0;
        var th = Math.random() * Math.PI * 2, ph = Math.random() * Math.PI, spd = 0.6 + Math.random() * 0.8;
        pVel[i] = { x: Math.sin(ph) * Math.cos(th) * spd, y: Math.sin(ph) * Math.sin(th) * spd, z: Math.cos(ph) * spd };
      }
      pGeo.attributes.position.needsUpdate = true;
      pMat.opacity = 1;
    }

    // camera creeps closer with each tier, eases back out on the last two steps
    var zAt = [];
    for (var zi = 0; zi < 5; zi++) zAt.push(Z_FAR - (Z_FAR - Z_NEAR) * (zi / 4));
    zAt.push(Z_NEAR + (Z_FAR - Z_NEAR) * 0.3);

    var current = 0, busy = false, stepping = false, exitStep = false, swapped = false;
    var STEP_MS = 700, stepStart = 0, fromZ = Z_FAR, toZ = Z_FAR, pending = -1;
    var fromRot = REST, toRot = REST;

    function startStep(next, dir, exit) {
      busy = stepping = true; swapped = false; exitStep = exit; pending = next;
      fromZ = zAt[current]; toZ = exit ? Z_FAR : zAt[next];
      stepStart = performance.now();
      fromRot = { x: cube.rotation.x, y: cube.rotation.y, z: cube.rotation.z };
      function land(rest, sign) { return rest + (1 + Math.floor(Math.random() * 2)) * Math.PI * 2 * sign; }
      toRot = { x: land(REST.x, Math.random() < 0.5 ? 1 : -1), y: land(REST.y, dir), z: land(REST.z, Math.random() < 0.5 ? 1 : -1) };
      var accent = accents[exit ? current : next];
      burst(accent);
      accentLight.color.set(accent);
      accentLight.intensity = 2.6;
      if (exit) { tagEl.style.opacity = '0'; hintEl.style.opacity = '0'; }
    }

    function nudge() {
      var x0 = camera.position.x, t0 = performance.now();
      (function shake() {
        var t = (performance.now() - t0) / 220;
        if (t >= 1) { camera.position.x = x0; return; }
        camera.position.x = x0 + Math.sin(t * Math.PI * 4) * 0.12 * (1 - t);
        requestAnimationFrame(shake);
      })();
    }

    function step(dir) {
      if (busy || finished) return;
      var next = current + dir;
      if (next >= blocks.length) { startStep(-1, dir, true); return; }
      if (next < 0) { nudge(); return; }
      startStep(next, dir, false);
    }

    // auto-advance: waits for the visitor first, then plays itself through
    var autoTimer = null;
    function scheduleAuto(delay) {
      clearTimeout(autoTimer);
      autoTimer = setTimeout(function autoStep() {
        if (finished) return;
        if (!busy) step(1);
        autoTimer = setTimeout(autoStep, AUTO_STEP_DELAY);
      }, delay);
    }
    function userStep(dir) { step(dir); scheduleAuto(AUTO_START_DELAY); }
    scheduleAuto(AUTO_START_DELAY);
    cleanupFns.push(function () { clearTimeout(autoTimer); });

    var wheelAccum = 0;
    on(window, 'wheel', function (e) {
      e.preventDefault();
      wheelAccum += e.deltaY;
      if (Math.abs(wheelAccum) >= 55) { userStep(wheelAccum > 0 ? 1 : -1); wheelAccum = 0; }
    }, { passive: false });
    var touchY = null;
    on(window, 'touchstart', function (e) { touchY = e.touches[0].clientY; }, { passive: true });
    on(window, 'touchmove', function (e) {
      e.preventDefault();
      if (touchY === null) return;
      var dy = touchY - e.touches[0].clientY;
      if (Math.abs(dy) > 32) { userStep(dy > 0 ? 1 : -1); touchY = e.touches[0].clientY; }
    }, { passive: false });
    on(window, 'keydown', function (e) {
      var k = e.key;
      if (k === 'Escape') { e.preventDefault(); end(true); }
      else if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'PageDown' || k === ' ' || (k === 'Enter' && document.activeElement !== skipBtn)) { e.preventDefault(); userStep(1); }
      else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp') { e.preventDefault(); userStep(-1); }
    });
    on(overlay, 'click', function (e) { if (e.target !== skipBtn) userStep(1); });
    on(window, 'resize', function () {
      camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
      renderer.setSize(innerWidth, innerHeight);
    });

    function showTitleThenEnd() {
      titleCard.classList.add('show');
      setTimeout(function () { end(false); }, 1400);
    }

    var running = true;
    disposeScene = function () {
      running = false;
      disposables.forEach(function (d) { d.dispose(); });
      renderer.dispose();
      if (renderer.forceContextLoss) renderer.forceContextLoss();
      renderer.domElement.remove();
    };

    function frame() {
      if (!running) return;
      requestAnimationFrame(frame);
      if (pMat.opacity > 0) {
        for (var i = 0; i < PCOUNT; i++) {
          pPos[i * 3] += pVel[i].x * 0.045; pPos[i * 3 + 1] += pVel[i].y * 0.045; pPos[i * 3 + 2] += pVel[i].z * 0.045;
        }
        pGeo.attributes.position.needsUpdate = true;
        pMat.opacity = Math.max(0, pMat.opacity - 0.03);
      }
      if (accentLight.intensity > 0) accentLight.intensity = Math.max(0, accentLight.intensity - 0.09);

      if (stepping) {
        var t = Math.min((performance.now() - stepStart) / STEP_MS, 1);
        var ease = 1 - Math.pow(1 - t, 3);
        cube.rotation.set(fromRot.x + (toRot.x - fromRot.x) * ease, fromRot.y + (toRot.y - fromRot.y) * ease, fromRot.z + (toRot.z - fromRot.z) * ease);
        cube.scale.setScalar(1 + Math.sin(t * Math.PI) * 0.42);
        camera.position.z = fromZ + (toZ - fromZ) * ease;
        if (!exitStep && t > 0.5 && !swapped) {
          cube.material = blocks[pending]; swapped = true; current = pending;
          tagEl.textContent = BLOCK_NAMES[current];
          setDots(current);
        }
        if (t >= 1) {
          stepping = false;
          cube.scale.setScalar(1);
          cube.rotation.set(REST.x, REST.y, REST.z);
          if (exitStep) showTitleThenEnd(); else busy = false;
        }
      } else {
        cube.rotation.y = REST.y + Math.sin(Date.now() * 0.00035) * 0.05;
      }
      renderer.render(scene, camera);
    }
    frame();
  }
})();
