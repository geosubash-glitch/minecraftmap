/* Minecraft Progression Map — application
 *
 * Structure
 *   1. boot / prefs          library + data checks, persisted user preferences
 *   2. indexes               id lookups and the cross-network search index
 *   3. constellation layout  deterministic hand-drawn-feeling main-map layout
 *   4. MapView               one factory for BOTH the main map and every network
 *                            view: zoom-reactive sizing, flat-dot/icon switching,
 *                            idle "floating item" drift
 *   5. highlight state       a single source of truth (selection / trace / tier /
 *                            search) that is re-applied after every change, so
 *                            hovering never wipes a search or tier filter
 *   6. panels                details pane, path panel, legend, search, menu
 *   7. networks              full-screen sub-maps opened from the dashed roots
 *   8. routing               #item/<id>, #network/<key>[/<id>] deep links
 *   9. keyboard              / search, Esc back out, + − zoom, F fit
 */
(function () {
  'use strict';

  // ======================================================================
  // 1. boot / prefs
  // ======================================================================
  var statusEl = document.getElementById('map-status');
  var DATA = window.MCMAP_DATA;

  function fatal(message) {
    statusEl.hidden = false;
    statusEl.innerHTML = '';
    var strong = document.createElement('strong');
    strong.textContent = 'The map could not load';
    var p = document.createElement('div');
    p.textContent = message;
    var btn = document.createElement('button');
    btn.className = 'btn glass';
    btn.textContent = 'Reload';
    btn.addEventListener('click', function () { location.reload(); });
    statusEl.append(strong, p, btn);
    window.MCMap = { reveal: function () {}, ready: false };
  }
  if (!window.cytoscape) {
    fatal('The graph library failed to download. Check your connection (or any content blocker) and reload.');
    return;
  }
  if (!DATA) {
    fatal('The map data file is missing.');
    return;
  }

  var tierColors = DATA.tiers.colors;
  var tierLabels = DATA.tiers.labels;
  var branches = DATA.branches;

  var reducedMotionQuery = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  var coarsePointer = window.matchMedia ? matchMedia('(pointer: coarse)').matches : false;

  var PREFS_KEY = 'mcmap.prefs';
  var prefs = { icons: false, motion: !reducedMotionQuery.matches };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')); } catch (e) {}
  function savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) {} }

  var ANIM_DUR = reducedMotionQuery.matches ? 0 : 450;
  var ANIM_EASE = 'ease-in-out-cubic';
  var FONT = 'Reddit Sans, -apple-system, system-ui, sans-serif';

  // ======================================================================
  // 2. indexes
  // ======================================================================
  var byId = {};          // main-map node id -> data
  var branchNodeKey = {}; // network node id -> network key
  var branchById = {};    // network node id -> data
  DATA.graph.nodes.forEach(function (n) { byId[n.data.id] = n.data; });
  Object.keys(branches).forEach(function (key) {
    branches[key].nodes.forEach(function (n) { branchById[n.id] = n; branchNodeKey[n.id] = key; });
  });
  function dataFor(id) { return byId[id] || branchById[id] || null; }

  var searchIndex = [];
  DATA.graph.nodes.forEach(function (n) {
    var d = n.data;
    var label = d.kind === 'root' ? branches[d.branchKey].rootLabelBase : d.label;
    searchIndex.push({ id: d.id, label: label, lower: label.toLowerCase(), data: d, branchKey: null,
      meta: d.kind === 'root' ? 'Network · ' + branches[d.branchKey].count + ' items' : (tierLabels[d.tier] || d.tier) });
  });
  Object.keys(branches).forEach(function (key) {
    branches[key].nodes.forEach(function (d) {
      searchIndex.push({ id: d.id, label: d.label, lower: d.label.toLowerCase(), data: d, branchKey: key,
        meta: 'in ' + branches[key].rootLabelBase });
    });
  });

  function hashCode(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) | 0; }
    return Math.abs(h);
  }

  // ======================================================================
  // 3. constellation layout (main map)
  // High-degree "hub" items are strung along one smooth wavy spine in rough
  // progression order (BFS from Oak Log); every other item is scattered around
  // its nearest hub on a golden-angle spiral. Deterministic: same map every load.
  // ======================================================================
  function buildConstellationPositions() {
    var core = DATA.graph.nodes.filter(function (n) { return n.data.kind !== 'root'; }).map(function (n) { return n.data; });
    var idSet = {}; core.forEach(function (n) { idSet[n.id] = true; });
    var adj = {}; core.forEach(function (n) { adj[n.id] = []; });
    DATA.graph.edges.forEach(function (e) {
      var s = e.data.source, t = e.data.target;
      if (idSet[s] && idSet[t]) { adj[s].push(t); adj[t].push(s); }
    });

    var LANDMARK_DEG = 6, HUB_DEG = 3;
    var hubs = core.filter(function (n) { return (n.degree || 0) >= HUB_DEG; }).map(function (n) { return n.id; });
    var hubSet = {}; hubs.forEach(function (id) { hubSet[id] = true; });

    var order = [];
    var visited = {};
    var startId = idSet.oak_log ? 'oak_log' : core[0].id;
    var mainQueue = [startId]; visited[startId] = true;
    while (mainQueue.length) {
      var cur = mainQueue.shift();
      if (hubSet[cur]) order.push(cur);
      adj[cur].slice().sort().forEach(function (nb) {
        if (!visited[nb]) { visited[nb] = true; mainQueue.push(nb); }
      });
    }

    var positions = {};
    var runningX = 0;
    order.forEach(function (id, i) {
      var seed = hashCode(id);
      runningX += (i === 0 ? 0 : 132 + (seed % 5) * 14);
      var y = Math.sin(i * 0.6) * 130 + Math.sin(i * 1.7 + 1.3) * 40 + ((seed % 15) - 7);
      positions[id] = { x: runningX, y: y, isLandmark: (byId[id].degree || 0) >= LANDMARK_DEG };
    });

    var nearestHub = {}, dist = {};
    var q2 = [];
    hubs.forEach(function (id) { if (visited[id]) { nearestHub[id] = id; dist[id] = 0; q2.push(id); } });
    for (var qi = 0; qi < q2.length; qi++) {
      var c = q2[qi];
      adj[c].forEach(function (nb) {
        if (visited[nb] && nearestHub[nb] === undefined) {
          nearestHub[nb] = nearestHub[c]; dist[nb] = dist[c] + 1; q2.push(nb);
        }
      });
    }

    var byHub = {};
    core.forEach(function (n) {
      if (hubSet[n.id] || !visited[n.id]) return;
      var hub = nearestHub[n.id];
      if (hub) (byHub[hub] = byHub[hub] || []).push(n.id);
    });
    var GOLDEN = 137.50776 * Math.PI / 180;
    Object.keys(byHub).forEach(function (hub) {
      var hubPos = positions[hub];
      var list = byHub[hub].slice().sort(function (a, b) { return (dist[a] || 1) - (dist[b] || 1); });
      list.forEach(function (id, idx) {
        var ring = Math.min(Math.max(1, dist[id] || 1), 4);
        var angle = idx * GOLDEN + (hashCode(hub) % 100) / 100;
        var radius = 36 + ring * 30 + Math.min(idx, 14) * 6;
        positions[id] = { x: hubPos.x + Math.cos(angle) * radius, y: hubPos.y + Math.sin(angle) * radius };
      });
    });

    // small chains not reachable from Oak Log get their own cluster below the spine
    var placed = {};
    var clusterIndex = 0;
    var floorY = Math.max.apply(null, order.map(function (id) { return positions[id].y; }).concat([0])) + 150;
    core.forEach(function (n) {
      if (visited[n.id] || placed[n.id]) return;
      var comp = [], q3 = [n.id], seen = {}; seen[n.id] = true;
      while (q3.length) {
        var cur3 = q3.shift(); comp.push(cur3);
        adj[cur3].forEach(function (nb) { if (!seen[nb]) { seen[nb] = true; q3.push(nb); } });
      }
      var ax = clusterIndex * 110, ay = floorY + (clusterIndex % 2) * 55;
      comp.forEach(function (id, j) {
        var angle = j * GOLDEN, radius = 16 + j * 20;
        positions[id] = { x: ax + Math.cos(angle) * radius, y: ay + Math.sin(angle) * radius };
        placed[id] = true;
      });
      clusterIndex++;
    });
    return positions;
  }

  // ======================================================================
  // 4. MapView — shared by the main map and every network view
  // ======================================================================
  var REF_NODE_MODEL_SIZE = 34; // converged "uniform" node size in model units
  var TEXTURE_ON_PX = 30;       // on-screen node size above which real icons are drawn
  var TEXTURE_OFF_PX = 22;      // ...and below which we drop back to flat dots (hysteresis)

  function MapView(kind) {
    this.kind = kind;       // 'main' | 'network'
    this.cy = null;
    this.baseZoom = 1;      // zoom at fit-to-screen
    this.currentZoom = 1;
    this.textureOn = false;
    this.lastTextured = null;
    this.bases = {};
    this.seeds = {};
    this.styleQueued = false;
  }

  // Nodes are importance-scaled (by degree) at the overview zoom and converge
  // to one uniform size as you zoom in, then shrink gently past 4× so close-up
  // neighbours don't overlap. Plain numbers only: style functions are first
  // evaluated inside the cytoscape() constructor, before this.cy exists.
  MapView.prototype.size = function (deg, minSize, maxSize, uniformSize) {
    var raw = minSize + Math.max(0, Math.min(deg, 12)) / 12 * (maxSize - minSize);
    var lo = this.baseZoom, hi = this.baseZoom * 4;
    var t = Math.max(0, Math.min(1, (this.currentZoom - lo) / (hi - lo || 1)));
    var s = raw + (uniformSize - raw) * t;
    if (this.currentZoom > hi) s *= Math.max(0.32, Math.pow(hi / this.currentZoom, 0.55));
    return s;
  };
  MapView.prototype.nodeSize = function (ele) {
    var s = this.size(ele.data('degree') || 0, 24, 64, REF_NODE_MODEL_SIZE);
    if (ele.hasClass('selected')) return s * 1.55;
    if (ele.hasClass('highlighted')) return s * 1.12;
    return s;
  };
  MapView.prototype.fontSize = function (ele) {
    return this.size(ele.data('degree') || 0, 11, 19, 13) * (ele.hasClass('selected') ? 1.12 : 1);
  };

  // Flat colour dots at overview zoom (the shape of the map reads clearly),
  // real item icons once they're big enough on screen to read. Measured in
  // absolute on-screen pixels so every map switches at the same visual moment.
  MapView.prototype.refreshTexture = function (force) {
    if (!this.cy) return;
    var px = this.currentZoom * REF_NODE_MODEL_SIZE;
    if (px > TEXTURE_ON_PX) this.textureOn = true;
    else if (px < TEXTURE_OFF_PX) this.textureOn = false;
    var textured = prefs.icons || this.textureOn;
    if (!force && textured === this.lastTextured) return;
    this.lastTextured = textured;
    var cy = this.cy;
    cy.batch(function () {
      cy.nodes().toggleClass('simple-node', !textured);
      // whatever is in focus always shows its real icon
      cy.nodes('.highlighted, .selected').removeClass('simple-node');
    });
  };

  MapView.prototype.captureBase = function () {
    var self = this;
    this.cy.nodes().forEach(function (n) {
      self.bases[n.id()] = { x: n.position('x'), y: n.position('y') };
      if (!self.seeds[n.id()]) self.seeds[n.id()] = hashCode(n.id()) || 1;
    });
  };
  MapView.prototype.restoreBase = function () {
    var self = this;
    if (!this.cy) return;
    this.cy.batch(function () {
      self.cy.nodes().forEach(function (n) { var b = self.bases[n.id()]; if (b) n.position(b); });
    });
  };
  // idle motion: nodes bob gently like dropped items in the game
  MapView.prototype.drift = function (t) {
    var self = this;
    this.cy.batch(function () {
      self.cy.nodes().forEach(function (n) {
        var base = self.bases[n.id()];
        if (!base) return;
        var seed = self.seeds[n.id()];
        var ampY = 3.6 + (seed % 5) * 0.9, ampX = 2.0 + (seed % 3) * 0.7;
        var speedY = 0.5 + (seed % 7) / 16, speedX = 0.32 + (seed % 5) / 18;
        var phase = (seed % 628) / 100;
        var dy = Math.sin(t * speedY + phase) * ampY + Math.sin(t * speedY * 2.3 + phase) * (ampY * 0.25);
        var dx = Math.cos(t * speedX + phase * 1.7) * ampX;
        n.position({ x: base.x + dx, y: base.y + dy });
      });
    });
  };

  MapView.prototype.onZoom = function () {
    var self = this;
    this.currentZoom = this.cy.zoom();
    this.refreshTexture(false);
    if (this.styleQueued) return;
    this.styleQueued = true;
    requestAnimationFrame(function () {
      self.styleQueued = false;
      if (self.cy) self.cy.style().update();
    });
  };
  MapView.prototype.setBaseZoom = function () {
    this.baseZoom = this.currentZoom = this.cy.zoom();
    this.refreshTexture(true);
  };

  function buildStyle(view) {
    var main = view.kind === 'main';
    var s = [
      { selector: 'node', style: {
        'shape': 'rectangle',
        'background-color': '#161616',
        'border-width': 2,
        'border-color': 'data(color)',
        'border-opacity': main ? 0.5 : 0.6,
        'background-image': 'data(image)',
        'background-fit': 'contain',
        'background-clip': 'none',
        'background-image-smoothing': 'no',
        'width': function (ele) { return view.nodeSize(ele); },
        'height': function (ele) { return view.nodeSize(ele); },
        'label': 'data(label)',
        'color': '#a3a3a3',
        'text-valign': 'bottom',
        'text-margin-y': main ? 3 : 6,
        'font-family': FONT,
        'font-weight': 600,
        'font-size': function (ele) { return view.fontSize(ele); },
        'min-zoomed-font-size': 6,
        'text-wrap': main ? 'none' : 'wrap',
        'text-max-width': 90,
        'transition-property': 'width, height, color, opacity, border-color, border-width',
        'transition-duration': '0.15s'
      } },
      { selector: 'node.simple-node', style: {
        'shape': 'ellipse', 'background-image': 'none', 'background-color': 'data(color)',
        'background-opacity': 0.85, 'border-width': 2, 'border-opacity': 0.9
      } },
      { selector: 'node[image = ""]', style: { 'background-image': 'none', 'background-color': 'data(color)', 'background-opacity': 0.55 } },
      { selector: 'node[kind = "source"]', style: { 'shape': 'diamond', 'border-style': 'dashed', 'border-width': 2.5 } },
      { selector: 'node[kind = "mob"]', style: { 'shape': 'ellipse' } },
      { selector: 'edge', style: {
        'width': 1.4, 'line-color': '#2e2e2e', 'target-arrow-color': '#2e2e2e',
        'target-arrow-shape': 'triangle', 'curve-style': 'bezier', 'arrow-scale': 0.7,
        'transition-property': 'line-color, target-arrow-color, width, opacity',
        'transition-duration': '0.15s'
      } },
      { selector: 'node.highlighted', style: { 'color': '#ffffff', 'border-width': 3, 'border-opacity': 1, 'opacity': 1, 'z-index': 600 } },
      { selector: 'node.selected', style: { 'color': '#ffffff', 'border-width': 4, 'border-opacity': 1, 'z-index': 999 } },
      { selector: 'node.flash', style: { 'overlay-color': '#ffffff', 'overlay-opacity': 0.25, 'overlay-padding': 6 } },
      { selector: 'node.dimmed', style: { 'opacity': main ? 0.34 : 0.28, 'color': '#4a4a4a' } },
      { selector: 'edge.edge-required', style: { 'width': 2.6, 'line-color': '#ff9f0a', 'target-arrow-color': '#ff9f0a', 'opacity': 1, 'z-index': 500 } },
      { selector: 'edge.edge-unlocks', style: { 'width': 2.6, 'line-color': '#32d74b', 'target-arrow-color': '#32d74b', 'opacity': 1, 'z-index': 500 } },
      { selector: 'edge.dimmed', style: { 'opacity': 0.14 } }
    ];
    if (main) {
      s.push(
        { selector: 'node.landmark', style: { 'border-width': 3, 'border-opacity': 1, 'z-index': 300 } },
        { selector: 'node[kind = "root"]', style: {
          'shape': 'ellipse', 'background-image': 'none', 'background-color': 'data(color)',
          'background-opacity': 0.28, 'border-width': 4, 'border-style': 'dashed', 'border-opacity': 1,
          'width': 92, 'height': 92, 'font-size': 16, 'min-zoomed-font-size': 3, 'color': 'data(color)',
          'text-margin-y': 5, 'text-wrap': 'wrap', 'text-max-width': 110, 'font-weight': 700, 'z-index': 500
        } },
        { selector: 'node[kind = "root"].dimmed', style: { 'opacity': 0.5 } },
        { selector: 'node[kind = "root"].selected', style: { 'width': 104, 'height': 104, 'background-opacity': 0.42 } },
        { selector: 'edge[note = "expand"]', style: {
          'line-style': 'dashed', 'width': 3.4, 'line-color': 'data(color)', 'target-arrow-color': 'data(color)', 'arrow-scale': 1.1
        } },
        { selector: '.entrance-hidden', style: { 'opacity': 0 } }
      );
    }
    return s;
  }

  function bindViewEvents(view) {
    var cy = view.cy;
    var container = cy.container();
    cy.on('zoom', function () { view.onZoom(); });
    cy.on('tap', 'node', function (e) {
      var node = e.target;
      if (node.data('kind') === 'root') { openNetwork(node.data('branchKey')); return; }
      select(node, { trace: state.pinned === node ? state.trace : false });
    });
    cy.on('dbltap', 'node', function (e) {
      if (e.target.data('kind') === 'root') return;
      select(e.target, { trace: true });
    });
    cy.on('tap', function (e) { if (e.target === cy) clearSelection(); });
    cy.on('mouseover', 'node', function (e) {
      container.style.cursor = 'pointer';
      if (state.pinned || coarsePointer) return;
      markFocus(cy, e.target);
      view.refreshTexture(true);
      renderPane(e.target, true);
    });
    cy.on('mouseout', 'node', function () {
      container.style.cursor = '';
      if (state.pinned || coarsePointer) return;
      applyHighlight();
      hidePane();
    });
  }

  // ---- main map ----
  var mainView = new MapView('main');
  var introPlaying = document.documentElement.getAttribute('data-intro') === 'play';
  var positions = buildConstellationPositions();
  // On portrait screens run the spine top-to-bottom instead of left-to-right,
  // so the map fills a phone screen instead of a thin horizontal strip.
  var portrait = window.innerHeight > window.innerWidth * 1.1;
  if (portrait) {
    Object.keys(positions).forEach(function (id) {
      var p = positions[id];
      positions[id] = { x: p.y, y: p.x, isLandmark: p.isLandmark };
    });
  }
  var spineAxis = portrait ? 'y' : 'x';

  mainView.cy = cytoscape({
    container: document.getElementById('cy'),
    elements: DATA.graph,
    boxSelectionEnabled: false,
    autoungrabify: true,
    style: buildStyle(mainView),
    layout: { name: 'preset', positions: function (n) { return positions[n.id()]; }, fit: false },
    minZoom: 0.08,
    maxZoom: 4.5,
    wheelSensitivity: 0.25
  });
  var cy = mainView.cy;
  statusEl.hidden = true;

  cy.nodes('[kind != "root"]').forEach(function (n) { if (positions[n.id()].isLandmark) n.addClass('landmark'); });
  cy.nodes().addClass('simple-node');

  // Each network root sits just outside its anchor item, pushed away from the
  // map's centre, so a network always opens next to the part it belongs to.
  (function positionNetworkRoots() {
    var box = cy.nodes('[kind != "root"]').boundingBox();
    var cx = (box.x1 + box.x2) / 2, cyy = (box.y1 + box.y2) / 2;
    Object.keys(branches).forEach(function (key) {
      var b = branches[key];
      var root = cy.getElementById(b.rootId);
      var anchor = cy.getElementById(b.anchor);
      if (root.empty()) return;
      var ax = anchor.nonempty() ? anchor.position('x') : cx;
      var ay = anchor.nonempty() ? anchor.position('y') : box.y2 + 100;
      var dx = ax - cx, dy = ay - cyy, len = Math.sqrt(dx * dx + dy * dy);
      root.position({ x: ax + (len > 1 ? dx / len : 0) * 120, y: ay + (len > 1 ? dy / len : 1) * 120 });
    });
  })();
  mainView.captureBase();
  bindViewEvents(mainView);
  // canvas labels are drawn with the web font; redraw once it has arrived
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { cy.style().update(); });

  // One-time entrance: nodes emerge left-to-right along the spine while the
  // camera settles in. Held back until the intro overlay has faded so it is
  // actually seen.
  var entrancePlayed = false;
  function playEntrance() {
    if (entrancePlayed) return;
    entrancePlayed = true;
    if (reducedMotionQuery.matches) { cy.elements().removeClass('entrance-hidden'); return; }
    var nodes = cy.nodes().sort(function (a, b) { return a.position(spineAxis) - b.position(spineAxis); });
    var order = {};
    nodes.forEach(function (n, i) { order[n.id()] = i; });
    var STEP = 7, CAP = 130, BASE = 90;
    nodes.forEach(function (n, i) { setTimeout(function () { n.removeClass('entrance-hidden'); }, BASE + Math.min(i, CAP) * STEP); });
    cy.edges().forEach(function (e) {
      var i = Math.max(order[e.source().id()] || 0, order[e.target().id()] || 0);
      setTimeout(function () { e.removeClass('entrance-hidden'); }, BASE + 60 + Math.min(i, CAP) * STEP);
    });
    var z = cy.zoom(), p = cy.pan();
    cy.viewport({ zoom: z * 0.88, pan: { x: p.x, y: p.y - 26 } }); // (settles back to the fitted view)
    cy.animate({ zoom: z, pan: p }, { duration: 1000, easing: 'ease-out-cubic' });
  }
  if (introPlaying) cy.elements().addClass('entrance-hidden');

  // ======================================================================
  // 5. highlight state
  // ======================================================================
  var state = {
    view: mainView,  // the map currently on screen
    network: null,   // open network key, or null for the main map
    pinned: null,    // selected node (details pane pinned)
    trace: false,    // showing the pinned node's full path from raw resources
    tier: null,      // tier filter from the legend
    query: ''        // current search text
  };

  var CLASSES = 'dimmed highlighted selected edge-required edge-unlocks';

  function markFocus(c, node) {
    c.batch(function () {
      c.elements().removeClass(CLASSES).addClass('dimmed');
      node.removeClass('dimmed').addClass('highlighted');
      node.incomers('edge').removeClass('dimmed').addClass('edge-required');
      node.outgoers('edge').removeClass('dimmed').addClass('edge-unlocks');
      node.incomers('node').add(node.outgoers('node')).removeClass('dimmed').addClass('highlighted');
    });
  }

  // everything upstream of `node`: the complete set of ingredients/steps
  function upstream(node) {
    var nodes = node.collection(), edges = node.cy().collection();
    var seen = {}; seen[node.id()] = true;
    var stack = [node];
    while (stack.length) {
      var n = stack.pop();
      nodes = nodes.union(n);
      n.incomers('edge').forEach(function (e) {
        edges = edges.union(e);
        var src = e.source();
        if (!seen[src.id()]) { seen[src.id()] = true; stack.push(src); }
      });
    }
    return { nodes: nodes, edges: edges };
  }

  function markTrace(c, node) {
    var up = upstream(node);
    c.batch(function () {
      c.elements().removeClass(CLASSES).addClass('dimmed');
      up.nodes.removeClass('dimmed').addClass('highlighted');
      up.edges.removeClass('dimmed').addClass('edge-required');
    });
    return up;
  }

  function queryMatches(c) {
    var q = state.query.toLowerCase();
    if (!q) return c.collection();
    return c.nodes().filter(function (n) {
      var label = n.data('kind') === 'root' ? branches[n.data('branchKey')].rootLabelBase : n.data('label');
      return label.toLowerCase().indexOf(q) !== -1;
    });
  }

  // Re-derive every highlight class from `state`. Called after any change, and
  // on mouse-out, so transient hover focus always falls back to the right view.
  function applyHighlight() {
    var view = state.view, c = view.cy;
    if (!c) return;
    c.batch(function () {
      c.elements().removeClass(CLASSES);
      if (state.pinned) {
        if (state.trace) markTrace(c, state.pinned); else markFocus(c, state.pinned);
        state.pinned.addClass('selected');
      } else if (state.tier) {
        c.elements().addClass('dimmed');
        c.nodes('[tier = "' + state.tier + '"]').removeClass('dimmed').addClass('highlighted');
      } else if (state.query) {
        var m = queryMatches(c);
        if (m.length) { c.elements().addClass('dimmed'); m.removeClass('dimmed').addClass('highlighted'); }
      }
    });
    view.refreshTexture(true);
  }

  function select(node, opts) {
    opts = opts || {};
    if (!node || node.empty()) return;
    state.pinned = node;
    state.trace = !!opts.trace;
    state.tier = null;
    updateLegendButton();
    applyHighlight();
    renderPane(node, false);
    if (state.trace) renderTimeline(node); else hideTimeline();
    if (state.trace && opts.frameTrace !== false) frame(upstream(node).nodes, { maxZoom: 1.6 });
    else if (opts.center) centerOn(node);
    writeRoute();
    announce(node.data('label') + ' selected. ' +
      node.incomers('node').length + ' requirements, ' + node.outgoers('node').length + ' unlocks.');
  }

  function clearSelection() {
    var had = !!state.pinned;
    state.pinned = null;
    state.trace = false;
    hidePane();
    hideTimeline();
    applyHighlight();
    if (had) writeRoute();
  }

  // The part of the map canvas not covered by the top bar, bottom controls or
  // an open panel — the camera frames things inside this rectangle so a
  // selection never lands underneath the panel describing it.
  function visibleRect() {
    var c = state.view.cy;
    var box = c.container().getBoundingClientRect();
    var r = { x1: 0, y1: state.network ? 0 : 64, x2: box.width, y2: box.height - 64 };
    var mobile = window.innerWidth <= 640;
    [pane, timelinePanel].forEach(function (el) {
      if (!el.classList.contains('open') || el.classList.contains('preview')) return;
      var p = el.getBoundingClientRect();
      if (mobile) {
        if (el === pane || document.body.classList.contains('tracing')) r.y2 = Math.min(r.y2, p.top - box.top - 8);
      } else if (el === pane) r.x2 = Math.min(r.x2, p.left - box.left - 12);
      else r.x1 = Math.max(r.x1, p.right - box.left + 12);
    });
    if (r.x2 - r.x1 < 120) { r.x1 = 0; r.x2 = box.width; }
    if (r.y2 - r.y1 < 120) { r.y1 = 0; r.y2 = box.height; }
    return r;
  }

  // Fit `eles` into the visible rectangle (or centre them at a fixed zoom).
  function frame(eles, opts) {
    opts = opts || {};
    var view = state.view, c = view.cy;
    if (!eles || eles.empty()) return;
    var r = visibleRect();
    var pad = opts.padding == null ? 40 : opts.padding;
    var xs = [], ys = [];
    eles.nodes().forEach(function (n) {
      var b = view.bases[n.id()] || n.position();
      xs.push(b.x); ys.push(b.y);
    });
    var bx1 = Math.min.apply(null, xs) - 30, bx2 = Math.max.apply(null, xs) + 30;
    var by1 = Math.min.apply(null, ys) - 30, by2 = Math.max.apply(null, ys) + 30;
    var z = opts.zoom || Math.min(
      (r.x2 - r.x1 - pad * 2) / (bx2 - bx1),
      (r.y2 - r.y1 - pad * 2) / (by2 - by1),
      opts.maxZoom || 2.4);
    z = Math.max(c.minZoom(), Math.min(c.maxZoom(), z));
    var pan = {
      x: (r.x1 + r.x2) / 2 - (bx1 + bx2) / 2 * z,
      y: (r.y1 + r.y2) / 2 - (by1 + by2) / 2 * z
    };
    if (opts.instant) { c.viewport({ zoom: z, pan: pan }); return; }
    c.animate({ zoom: z, pan: pan }, {
      duration: ANIM_DUR, easing: ANIM_EASE,
      complete: function () { if (opts.rebase) view.setBaseZoom(); }
    });
  }

  function centerOn(node) {
    var c = state.view.cy;
    frame(node, { zoom: Math.min(Math.max(c.zoom(), state.view.baseZoom * 2.2), 2.4) });
  }

  function flash(node) {
    node.addClass('flash');
    setTimeout(function () { node.removeClass('flash'); }, 700);
  }

  function fitView(eles, padding) {
    frame(eles || state.view.cy.nodes(), { padding: padding == null ? 20 : padding, maxZoom: 2 });
  }
  function zoomBy(factor) {
    var c = state.view.cy;
    var z = Math.max(c.minZoom(), Math.min(c.maxZoom(), c.zoom() * factor));
    c.animate({ zoom: { level: z, renderedPosition: { x: c.width() / 2, y: c.height() / 2 } } },
      { duration: ANIM_DUR ? 220 : 0, easing: ANIM_EASE });
  }

  // ======================================================================
  // 6. panels
  // ======================================================================
  var $ = function (id) { return document.getElementById(id); };
  var pane = $('details-pane');
  var timelinePanel = $('timeline-panel');

  function iconEl(d, cls) {
    if (d.image) {
      var img = document.createElement('img');
      img.src = d.image; img.alt = ''; img.loading = 'lazy'; img.width = 24; img.height = 24;
      if (cls) img.className = cls;
      return img;
    }
    var dot = document.createElement('span');
    dot.className = 'sr-dot' + (cls ? ' ' + cls : '');
    dot.style.background = d.color || tierColors[d.tier] || '#666';
    return dot;
  }

  function relationButton(node, note) {
    var d = node.data();
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'rel-item';
    b.appendChild(iconEl(d));
    var label = document.createElement('span');
    label.textContent = d.kind === 'root' ? branches[d.branchKey].rootLabelBase + ' network' : d.label;
    b.appendChild(label);
    if (note && note !== 'expand') {
      var n = document.createElement('span'); n.className = 'note'; n.textContent = note; b.appendChild(n);
    }
    b.addEventListener('click', function () {
      if (d.kind === 'root') openNetwork(d.branchKey);
      else select(node, { center: true });
    });
    return b;
  }

  function fillRelations(listEl, edges, endKey, emptyText) {
    listEl.textContent = '';
    if (!edges.length) {
      var e = document.createElement('div'); e.className = 'rel-empty'; e.textContent = emptyText;
      listEl.appendChild(e);
      return;
    }
    edges.forEach(function (edge) { listEl.appendChild(relationButton(edge[endKey](), edge.data('note'))); });
  }

  function renderPane(node, preview) {
    var d = node.data();
    var isRoot = d.kind === 'root';
    var paneImg = $('pane-img');
    if (d.image) { paneImg.src = d.image; paneImg.classList.remove('no-img'); paneImg.style.background = ''; }
    else { paneImg.removeAttribute('src'); paneImg.classList.add('no-img'); paneImg.style.background = d.color || '#555'; }
    $('pane-title').textContent = isRoot ? branches[d.branchKey].rootLabelBase : d.label;
    var tag = $('pane-tier');
    tag.textContent = isRoot ? 'Network · ' + branches[d.branchKey].count + ' items' : (tierLabels[d.tier] || d.tier);
    tag.style.background = tierColors[d.tier] || '#888';
    $('pane-desc').textContent = d.desc || '';

    $('pane-open-network').hidden = !isRoot;
    $('pane-trace').hidden = isRoot || node.incomers('edge').length === 0;
    $('pane-trace').setAttribute('aria-pressed', String(!!(state.trace && state.pinned === node)));
    $('pane-trace').textContent = state.trace && state.pinned === node ? 'Hide path' : 'Trace path';
    $('pane-actions').hidden = !!preview;

    $('pane-in-section').hidden = isRoot;
    $('pane-out-section').hidden = isRoot;
    if (!isRoot) {
      fillRelations($('pane-incoming'), node.incomers('edge'), 'source', 'Base resource — nothing required');
      fillRelations($('pane-outgoing'), node.outgoers('edge'), 'target', 'End of this path');
    }
    var hint = $('pane-hint');
    hint.hidden = !preview;
    hint.textContent = isRoot ? 'Click to open this network' : 'Click to pin · double-click to trace its full path';

    pane.classList.add('open');
    pane.classList.toggle('preview', !!preview);
    pane.setAttribute('aria-hidden', 'false');
    document.body.classList.toggle('sheet-open', !preview);
    pane.querySelector('.scroll').scrollTop = 0;
  }
  function hidePane() {
    pane.classList.remove('open', 'preview');
    pane.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('sheet-open');
  }

  // Kahn topological sort: raw resources first, target last
  function topoOrder(nodes, edges) {
    var ids = nodes.map(function (n) { return n.id(); });
    var inDeg = {}, adj = {};
    ids.forEach(function (id) { inDeg[id] = 0; adj[id] = []; });
    edges.forEach(function (e) {
      var s = e.data('source'), t = e.data('target');
      if (adj[s] && inDeg[t] !== undefined) { adj[s].push(t); inDeg[t]++; }
    });
    var queue = ids.filter(function (id) { return inDeg[id] === 0; }).sort();
    var out = [], seen = {};
    while (queue.length) {
      var id = queue.shift();
      if (seen[id]) continue;
      seen[id] = true; out.push(id);
      adj[id].forEach(function (t) { if (--inDeg[t] === 0) { queue.push(t); queue.sort(); } });
    }
    ids.forEach(function (id) { if (!seen[id]) out.push(id); }); // cycles (e.g. village ⇄ emerald)
    return out;
  }

  function renderTimeline(node) {
    var c = state.view.cy;
    var up = upstream(node);
    var order = topoOrder(up.nodes, up.edges);
    $('timeline-title').textContent = 'Path to ' + node.data('label');
    $('timeline-sub').textContent = order.length > 1
      ? order.length + ' steps, starting from raw resources'
      : 'This is a base resource.';
    var list = $('timeline-list');
    list.textContent = '';
    order.forEach(function (id, i) {
      var d = c.getElementById(id).data();
      var li = document.createElement('li');
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'tl-step' + (id === node.id() ? ' tl-target' : '');
      var num = document.createElement('span'); num.className = 'tl-num'; num.textContent = i + 1;
      var label = document.createElement('span'); label.className = 'tl-label'; label.textContent = d.label;
      b.append(num, iconEl(d), label);
      b.addEventListener('click', function () {
        var n = c.getElementById(id);
        centerOn(n);
        flash(n);
      });
      li.appendChild(b);
      list.appendChild(li);
    });
    timelinePanel.classList.add('open');
    timelinePanel.setAttribute('aria-hidden', 'false');
    document.body.classList.add('tracing');
    timelinePanel.querySelector('.scroll').scrollTop = 0;
  }
  function hideTimeline() {
    timelinePanel.classList.remove('open');
    timelinePanel.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('tracing');
  }

  $('pane-close').addEventListener('click', clearSelection);
  $('timeline-close').addEventListener('click', function () {
    if (state.pinned && state.trace) select(state.pinned, {}); else hideTimeline();
  });
  $('pane-trace').addEventListener('click', function () {
    if (state.pinned) select(state.pinned, { trace: !state.trace });
  });
  $('pane-open-network').addEventListener('click', function () {
    if (state.pinned && state.pinned.data('kind') === 'root') openNetwork(state.pinned.data('branchKey'));
  });
  $('pane-share').addEventListener('click', function () {
    var url = location.href;
    var done = function () { toast('Link copied'); };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(url).then(done, function () { prompt('Copy this link:', url); });
    else prompt('Copy this link:', url);
  });

  // ---- toast + screen-reader announcements ----
  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 1800);
  }
  function announce(msg) { $('sr-announcer').textContent = msg; }

  // ---- bottom controls ----
  $('fit-btn').addEventListener('click', function () { fitView(); });
  $('zoom-in').addEventListener('click', function () { zoomBy(1.4); });
  $('zoom-out').addEventListener('click', function () { zoomBy(1 / 1.4); });

  // ---- legend / tier filter ----
  var legendBtn = $('legend-btn');
  var legendPanel = $('legend-panel');
  function setLegendOpen(open) {
    legendPanel.classList.toggle('open', open);
    legendBtn.setAttribute('aria-expanded', String(open));
    if (open) setMenuOpen(false);
  }
  legendBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    setLegendOpen(!legendPanel.classList.contains('open'));
  });
  $('legend-clear').addEventListener('click', function () { setTier(null); });

  function buildLegend() {
    var grid = $('legend-grid');
    grid.textContent = '';
    var counts = {};
    state.view.cy.nodes().forEach(function (n) { var t = n.data('tier'); counts[t] = (counts[t] || 0) + 1; });
    Object.keys(tierColors).filter(function (t) { return counts[t]; }).forEach(function (tier) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'legend-item';
      b.dataset.tier = tier;
      b.setAttribute('aria-pressed', String(state.tier === tier));
      var sw = document.createElement('span'); sw.className = 'swatch'; sw.style.background = tierColors[tier];
      var label = document.createElement('span'); label.textContent = tierLabels[tier] || tier;
      var count = document.createElement('span'); count.className = 'count'; count.textContent = counts[tier];
      b.append(sw, label, count);
      b.addEventListener('click', function () { setTier(state.tier === tier ? null : tier); });
      grid.appendChild(b);
    });
  }
  function updateLegendButton() {
    var sw = $('legend-btn-swatch');
    $('legend-btn-label').textContent = state.tier ? (tierLabels[state.tier] || state.tier) : 'Tiers';
    sw.hidden = !state.tier;
    if (state.tier) sw.style.background = tierColors[state.tier];
    legendBtn.setAttribute('aria-pressed', String(!!state.tier));
    $('legend-clear').hidden = !state.tier;
    Array.prototype.forEach.call(document.querySelectorAll('.legend-item'), function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.tier === state.tier));
    });
  }
  function setTier(tier) {
    state.tier = tier;
    state.pinned = null;
    state.trace = false;
    hidePane();
    hideTimeline();
    applyHighlight();
    updateLegendButton();
    writeRoute();
    if (tier) {
      var nodes = state.view.cy.nodes('[tier = "' + tier + '"]');
      if (nodes.length) fitView(nodes, 80);
      announce(nodes.length + ' ' + (tierLabels[tier] || tier) + ' items highlighted');
    }
  }

  // ---- menu ----
  var menuButton = $('menu-button');
  var menu = $('menu-dropdown');
  function setMenuOpen(open) {
    menu.classList.toggle('open', open);
    menuButton.setAttribute('aria-expanded', String(open));
    if (open) {
      setLegendOpen(false);
      var first = menu.querySelector('.menu-item');
      if (first) first.focus();
    }
  }
  menuButton.addEventListener('click', function (e) {
    e.stopPropagation();
    setMenuOpen(!menu.classList.contains('open'));
  });
  menu.addEventListener('keydown', function (e) {
    var items = Array.prototype.slice.call(menu.querySelectorAll('.menu-item'));
    var i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    if (e.key === 'Tab') setMenuOpen(false);
  });
  document.addEventListener('click', function (e) {
    if (menu.classList.contains('open') && !menu.contains(e.target) && !menuButton.contains(e.target)) setMenuOpen(false);
    if (legendPanel.classList.contains('open') && !$('legend').contains(e.target)) setLegendOpen(false);
    if (!$('search').contains(e.target)) closeResults();
  });
  function syncMenuChecks() {
    menu.querySelector('[data-action="icons"]').setAttribute('aria-checked', String(!!prefs.icons));
    menu.querySelector('[data-action="motion"]').setAttribute('aria-checked', String(!!prefs.motion));
  }
  menu.addEventListener('click', function (e) {
    var item = e.target.closest('.menu-item');
    if (!item) return;
    var action = item.dataset.action;
    if (action === 'reset') { resetView(); setMenuOpen(false); menuButton.focus(); }
    if (action === 'icons') {
      prefs.icons = !prefs.icons; savePrefs(); syncMenuChecks();
      mainView.refreshTexture(true);
      if (networkView.cy) networkView.refreshTexture(true);
      applyHighlight();
    }
    if (action === 'motion') { prefs.motion = !prefs.motion; savePrefs(); syncMenuChecks(); setMotion(); }
    if (action === 'intro') {
      try { localStorage.removeItem('mcmap.introSeen'); } catch (err) {}
      location.href = location.pathname + '?intro=1';
    }
  });
  syncMenuChecks();

  function resetView() {
    if (state.network) { closeNetwork(); }
    state.tier = null;
    setQuery('');
    clearSelection();
    updateLegendButton();
    fitView(null, 40);
    writeRoute();
  }

  // ---- search (combobox over the main map AND every network) ----
  var searchInput = $('search-input');
  var resultsEl = $('search-results');
  var results = [];
  var activeResult = -1;
  var MAX_RESULTS = 40;

  function rank(entry, q) {
    var i = entry.lower.indexOf(q);
    if (i === -1) return -1;
    var score = i === 0 ? 0 : (entry.lower.charAt(i - 1) === ' ' ? 1 : 2);
    if (entry.branchKey && entry.branchKey !== state.network) score += 3; // things on screen first
    if (!entry.branchKey && state.network) score += 3;
    return score;
  }

  function runSearch(q) {
    q = q.trim().toLowerCase();
    if (!q) return [];
    var scored = [];
    searchIndex.forEach(function (entry) {
      var r = rank(entry, q);
      if (r >= 0) scored.push({ entry: entry, score: r });
    });
    scored.sort(function (a, b) {
      return a.score - b.score || a.entry.label.length - b.entry.label.length || a.entry.label.localeCompare(b.entry.label);
    });
    return scored.map(function (s) { return s.entry; });
  }

  function highlightLabel(label, q) {
    var frag = document.createDocumentFragment();
    var i = label.toLowerCase().indexOf(q);
    if (i === -1 || !q) { frag.append(label); return frag; }
    var mark = document.createElement('mark');
    mark.textContent = label.substr(i, q.length);
    frag.append(label.slice(0, i), mark, label.slice(i + q.length));
    return frag;
  }

  function renderResults() {
    var q = state.query.toLowerCase();
    resultsEl.textContent = '';
    if (!q) { closeResults(); return; }
    var shown = results.slice(0, MAX_RESULTS);
    if (!shown.length) {
      var empty = document.createElement('li');
      empty.className = 'sr-empty';
      empty.textContent = 'No items match “' + state.query + '”';
      resultsEl.appendChild(empty);
    }
    shown.forEach(function (entry, i) {
      var li = document.createElement('li');
      li.className = 'sr-item';
      li.id = 'sr-' + i;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === activeResult));
      var text = document.createElement('div'); text.className = 'sr-text';
      var label = document.createElement('div'); label.className = 'sr-label';
      label.appendChild(highlightLabel(entry.label, q));
      var meta = document.createElement('div'); meta.className = 'sr-meta'; meta.textContent = entry.meta;
      text.append(label, meta);
      li.append(iconEl(entry.data), text);
      li.addEventListener('mousedown', function (e) { e.preventDefault(); }); // keep input focus
      li.addEventListener('click', function () { chooseResult(entry); });
      resultsEl.appendChild(li);
    });
    if (results.length > MAX_RESULTS) {
      var more = document.createElement('li');
      more.className = 'sr-more';
      more.textContent = '+' + (results.length - MAX_RESULTS) + ' more — keep typing to narrow down';
      resultsEl.appendChild(more);
    }
    resultsEl.hidden = false;
    searchInput.setAttribute('aria-expanded', 'true');
    if (activeResult >= 0) {
      searchInput.setAttribute('aria-activedescendant', 'sr-' + activeResult);
      var el = $('sr-' + activeResult);
      if (el) el.scrollIntoView({ block: 'nearest' });
    } else {
      searchInput.removeAttribute('aria-activedescendant');
    }
  }
  function closeResults() {
    resultsEl.hidden = true;
    searchInput.setAttribute('aria-expanded', 'false');
    searchInput.removeAttribute('aria-activedescendant');
  }

  function setQuery(q) {
    searchInput.value = q;
    state.query = q.trim();
    $('search-clear').hidden = !q;
    $('search-kbd').hidden = !!q;
    results = runSearch(state.query);
    activeResult = results.length ? 0 : -1;
  }

  searchInput.addEventListener('input', function () {
    setQuery(this.value);
    if (state.pinned) { state.pinned = null; state.trace = false; hidePane(); hideTimeline(); }
    if (state.tier) { state.tier = null; updateLegendButton(); }
    applyHighlight();
    renderResults();
    if (state.query) announce(results.length + ' results');
  });
  searchInput.addEventListener('focus', function () { if (state.query) renderResults(); });
  searchInput.addEventListener('keydown', function (e) {
    var n = Math.min(results.length, MAX_RESULTS);
    if (e.key === 'ArrowDown' && n) { e.preventDefault(); activeResult = (activeResult + 1) % n; renderResults(); }
    else if (e.key === 'ArrowUp' && n) { e.preventDefault(); activeResult = (activeResult - 1 + n) % n; renderResults(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (results[activeResult]) chooseResult(results[activeResult]); }
    else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (!resultsEl.hidden) closeResults();
      else if (searchInput.value) { setQuery(''); applyHighlight(); }
      else searchInput.blur();
    }
  });
  $('search-clear').addEventListener('click', function () {
    setQuery(''); applyHighlight(); closeResults(); searchInput.focus();
  });

  function chooseResult(entry) {
    closeResults();
    searchInput.blur();
    goTo(entry.branchKey, entry.id);
  }

  // navigate to any node anywhere: main map or inside a network
  function goTo(networkKey, id) {
    var targetIsRoot = !networkKey && byId[id] && byId[id].kind === 'root';
    if (targetIsRoot) { openNetwork(byId[id].branchKey); return; }
    if (networkKey && networkKey !== state.network) { openNetwork(networkKey, id); return; }
    if (!networkKey && state.network) closeNetwork();
    var node = state.view.cy.getElementById(id);
    if (node.nonempty()) { select(node, { center: true }); flash(node); }
  }

  // ======================================================================
  // 7. networks (full-screen sub-maps)
  // ======================================================================
  var networkView = new MapView('network');
  var branchModal = $('branch-modal');
  var layoutCache = {}; // key -> {id: position}; layout once per session, reopen instantly
  var lastFocusBeforeNetwork = null;

  function networkElements(key) {
    var info = branches[key];
    var els = { nodes: [], edges: [] };
    info.nodes.forEach(function (n) { els.nodes.push({ data: Object.assign({}, n, { branchKey: key }) }); });
    info.edges.forEach(function (e) {
      // links to the root hub belong to the main map, not to this view
      if (e.source === info.rootId || e.target === info.rootId) return;
      els.edges.push({ data: Object.assign({}, e, { id: key + '__' + e.source + '__' + e.target }) });
    });
    return els;
  }

  function openNetwork(key, focusId, fromRoute) {
    var info = branches[key];
    if (!info) return;
    if (state.network === key) {
      if (focusId) goTo(key, focusId);
      return;
    }
    if (state.network) teardownNetwork();
    lastFocusBeforeNetwork = document.activeElement;

    state.network = key;
    state.pinned = null; state.trace = false; state.tier = null;
    hidePane(); hideTimeline(); setLegendOpen(false); updateLegendButton();

    $('branch-modal-title').textContent = info.rootLabelBase + ' · ' + info.count + ' items';
    $('branch-modal-desc').textContent = info.desc || '';
    branchModal.classList.add('open');
    document.body.classList.add('in-network');
    syncNetworkOffset();
    $('branch-loading').hidden = false;
    $('branch-modal-close').focus();
    if (!fromRoute) {
      // network → network replaces the entry, so one Back always returns to the map
      var entry = [{ network: key }, '', '#network/' + encodeURIComponent(key)];
      if (history.state && history.state.network) history.replaceState.apply(history, entry);
      else history.pushState.apply(history, entry);
    }

    // let the "Laying out…" message paint before the (synchronous) layout runs
    requestAnimationFrame(function () { setTimeout(function () {
      if (state.network !== key) return; // closed again meanwhile
      var cached = layoutCache[key];
      var els = networkElements(key);
      var GOLDEN = 137.50776 * Math.PI / 180;
      var layout = cached
        ? { name: 'preset', positions: function (n) { return cached[n.id()]; }, fit: false }
        : {
          name: 'cose', animate: false, randomize: false, fit: false,
          nodeRepulsion: 9000, idealEdgeLength: 75, edgeElasticity: 90, nestingFactor: 5,
          gravity: 55, numIter: 1200, initialTemp: 220, coolingFactor: 0.95, minTemp: 1.0
        };
      if (!cached) {
        // deterministic seed positions (a golden-angle spiral) instead of
        // randomize:true, so a network looks the same every time it opens
        els.nodes.forEach(function (n, i) {
          var r = 30 * Math.sqrt(i + 1);
          n.position = { x: Math.cos(i * GOLDEN) * r, y: Math.sin(i * GOLDEN) * r };
        });
      }
      try {
        networkView.cy = cytoscape({
          container: $('branch-cy'),
          elements: els,
          boxSelectionEnabled: false,
          autoungrabify: true,
          style: buildStyle(networkView),
          layout: layout,
          minZoom: 0.08,
          maxZoom: 4.5,
          wheelSensitivity: 0.25
        });
      } catch (err) {
        $('branch-loading').textContent = 'Could not build this network: ' + err.message;
        return;
      }
      var ncy = networkView.cy;
      if (!cached) {
        layoutCache[key] = {};
        ncy.nodes().forEach(function (n) { layoutCache[key][n.id()] = Object.assign({}, n.position()); });
      }
      $('branch-loading').hidden = true;
      ncy.nodes().addClass('simple-node');
      networkView.bases = {};
      networkView.lastTextured = null;
      networkView.captureBase();
      ncy.resize();
      bindViewEvents(networkView);
      state.view = networkView;
      frame(ncy.nodes(), { instant: true, padding: 20, maxZoom: 2 });
      networkView.setBaseZoom();
      buildLegend();
      if (state.query) { results = runSearch(state.query); applyHighlight(); }
      if (focusId) goTo(key, focusId);
      else writeRoute();
    }, 30); });
  }

  // panels open just below the network header, whatever height its text wraps to
  function syncNetworkOffset() {
    var h = $('branch-modal-header').getBoundingClientRect().height;
    document.body.style.setProperty('--top-offset', Math.round(h + 12) + 'px');
  }
  window.addEventListener('resize', function () { if (state.network) syncNetworkOffset(); });

  function teardownNetwork() {
    if (networkView.cy) { networkView.cy.destroy(); networkView.cy = null; }
    state.view = mainView;
  }

  function closeNetwork(fromRoute) {
    if (!state.network) return;
    teardownNetwork();
    state.network = null;
    state.pinned = null; state.trace = false; state.tier = null;
    branchModal.classList.remove('open');
    document.body.classList.remove('in-network');
    document.body.style.removeProperty('--top-offset');
    $('branch-loading').hidden = true;
    $('branch-loading').textContent = 'Laying out network…';
    hidePane(); hideTimeline(); setLegendOpen(false); updateLegendButton();
    buildLegend();
    if (state.query) results = runSearch(state.query);
    applyHighlight();
    // opening pushed a history entry; step back over it so browser Back
    // doesn't reopen the network we just closed
    if (!fromRoute && history.state && history.state.network) history.back();
    else if (!fromRoute) writeRoute();
    if (lastFocusBeforeNetwork && document.contains(lastFocusBeforeNetwork)) lastFocusBeforeNetwork.focus();
  }
  $('branch-modal-close').addEventListener('click', function () { closeNetwork(); });

  // ======================================================================
  // 8. routing — shareable deep links, browser Back closes a network
  // ======================================================================
  function currentRoute() {
    var parts = [];
    if (state.network) parts.push('network', state.network);
    else if (state.pinned) parts.push('item');
    if (state.pinned) parts.push(state.pinned.id());
    return parts.length ? '#' + parts.map(encodeURIComponent).join('/') : '';
  }
  function writeRoute() {
    var r = currentRoute();
    if (r === location.hash || (!r && !location.hash)) return;
    history.replaceState(history.state, '', r || location.pathname + location.search);
  }
  function applyRoute() {
    var parts = location.hash.replace(/^#/, '').split('/').map(decodeURIComponent);
    if (parts[0] === 'network' && branches[parts[1]]) {
      if (state.network !== parts[1]) openNetwork(parts[1], parts[2], true);
      else if (parts[2]) goTo(parts[1], parts[2]);
      return;
    }
    if (state.network) closeNetwork(true);
    if (parts[0] === 'item' && byId[parts[1]]) {
      var node = cy.getElementById(parts[1]);
      select(node, { center: true });
    }
  }
  window.addEventListener('popstate', applyRoute);

  // ======================================================================
  // 9. keyboard
  // ======================================================================
  document.addEventListener('keydown', function (e) {
    if (e.defaultPrevented || e.ctrlKey && e.key !== 'k' || e.altKey) return;
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    var introOpen = document.documentElement.getAttribute('data-intro') === 'play';
    if (introOpen) return;
    if ((e.key === '/' && !typing) || (e.key === 'k' && (e.metaKey || e.ctrlKey))) {
      e.preventDefault(); searchInput.focus(); searchInput.select(); return;
    }
    if (e.key === 'Escape') {
      if (menu.classList.contains('open')) { setMenuOpen(false); menuButton.focus(); }
      else if (legendPanel.classList.contains('open')) { setLegendOpen(false); legendBtn.focus(); }
      else if (state.trace) select(state.pinned, {});
      else if (state.pinned) clearSelection();
      else if (state.tier) setTier(null);
      else if (state.network) closeNetwork();
      return;
    }
    if (typing || e.metaKey) return;
    if (e.key === '+' || e.key === '=') zoomBy(1.4);
    else if (e.key === '-' || e.key === '_') zoomBy(1 / 1.4);
    else if (e.key === 'f' || e.key === 'F' || e.key === '0') fitView();
  });

  // ======================================================================
  // idle motion loop — only the visible map moves, and only when wanted
  // ======================================================================
  // repositioning every node every frame is cheap for the ~100-node main map
  // but drags big networks (Construction Blocks has 510) well below 60fps
  var MAX_DRIFT_NODES = 250;
  var motionRunning = false;
  var motionStart = performance.now();
  function motionTick(now) {
    if (!motionRunning) return;
    var v = state.view;
    if (v.cy && !document.hidden && v.cy.nodes().length <= MAX_DRIFT_NODES) v.drift((now - motionStart) / 1000);
    requestAnimationFrame(motionTick);
  }
  function setMotion() {
    var want = prefs.motion && !reducedMotionQuery.matches;
    if (want && !motionRunning) { motionRunning = true; requestAnimationFrame(motionTick); }
    if (!want && motionRunning) {
      motionRunning = false;
      mainView.restoreBase();
      networkView.restoreBase();
    }
  }
  if (reducedMotionQuery.addEventListener) reducedMotionQuery.addEventListener('change', setMotion);

  // ======================================================================
  // start
  // ======================================================================
  frame(cy.nodes(), { instant: true, padding: 20, maxZoom: 2 });
  mainView.setBaseZoom();
  buildLegend();
  updateLegendButton();

  var revealed = false;
  function reveal() {
    if (revealed) return;
    revealed = true;
    playEntrance();
    setMotion();
  }
  if (!introPlaying) reveal();
  if (location.hash.length > 1) applyRoute();

  // public hooks for intro.js (and handy from the console)
  window.MCMap = { ready: true, reveal: reveal, goTo: goTo, state: state };
})();
