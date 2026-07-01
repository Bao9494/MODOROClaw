/**
 * brain.js — Interactive force-directed graph for the Brain tab.
 *
 * Uses d3-force (live physics), d3-zoom (pan/zoom), d3-drag (node dragging),
 * Tween.js (smooth hover animations), Canvas 2D (rendering).
 *
 * Globals: d3, TWEEN (loaded via vendor/ scripts before this file)
 * Bridges: window.claw.getBrainGraph(), getBrainNodeDetail(), rebuildBrainGraph(), onBrainGraphRebuilt()
 */

/* ── Module state ─────────────────────────────────────────────── */

var _brainNodes = [];
var _brainEdges = [];
var _brainStats = null;
var _brainNodeMap = {};
var _brainAdjacency = {};

var _brainSimNodes = [];
var _brainSimLinks = [];
var _brainSimNodeMap = {};

var _brainSimulation = null;
var _brainZoomBehavior = null;
var _brainTransform = null;
var _brainTweenGroup = null;

var _brainAnimating = false;
var _brainAnimFrameId = null;

var _brainDragNode = null;
var _brainDragStartTime = 0;
var _brainDragDist = 0;

var _brainSelectedId = null;
var _brainHoveredId = null;
var _brainHoveredNeighbors = new Set();
var _brainSearchMatches = null;

var _brainFilters = { customer: true, group: true, doc: true, learning: true, skill: true };
var _brainRefreshing = false;
var _brainInitialized = false;

/* ── Constants ────────────────────────────────────────────────── */

var BRAIN_COLORS = {
  customer: '#eab308',
  group:    '#818cf8',
  doc:      '#f87171',
  learning: '#94a3b8',
  skill:    '#a78bfa'
};

var BRAIN_EDGE_COLORS = {
  membership: '#6366f1',
  reference:  '#f59e0b',
  escalation: '#ef4444',
  semantic:   '#22c55e'
};

var BRAIN_BG = '#1a1a2e';

/* ── Utility ──────────────────────────────────────────────────── */

function _nodeRadius(d) {
  return Math.max(3, Math.min(8, 2 + Math.sqrt(d.size || 4)));
}

function _stripDiacritics(str) {
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function _findNodeAt(gx, gy) {
  var hitR = 12;
  var closest = null, bestDist = Infinity;
  for (var i = 0; i < _brainSimNodes.length; i++) {
    var sn = _brainSimNodes[i];
    if (sn._hidden) continue;
    var dx = sn.x - gx, dy = sn.y - gy;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var r = _nodeRadius(sn);
    if (dist < r + hitR && dist < bestDist) {
      bestDist = dist;
      closest = sn;
    }
  }
  return closest;
}

function _hexToRgb(hex) {
  var r = parseInt(hex.slice(1, 3), 16);
  var g = parseInt(hex.slice(3, 5), 16);
  var b = parseInt(hex.slice(5, 7), 16);
  return { r: r, g: g, b: b };
}

var _rgbCache = {};
function _rgba(hex, alpha) {
  if (!_rgbCache[hex]) _rgbCache[hex] = _hexToRgb(hex);
  var c = _rgbCache[hex];
  return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + alpha + ')';
}

function _roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/* ── Load graph data ──────────────────────────────────────────── */

async function loadBrainGraph() {
  var data = null;
  try { data = await window.claw.getBrainGraph(); } catch (e) { console.error('[brain] getBrainGraph failed:', e); }

  if (!data || !data.nodes) {
    _brainNodes = []; _brainEdges = []; _brainStats = null;
  } else {
    _brainNodes = data.nodes || [];
    _brainEdges = data.edges || [];
    _brainStats = data.stats || null;
  }

  _brainNodeMap = {};
  _brainAdjacency = {};
  for (var i = 0; i < _brainNodes.length; i++) {
    var n = _brainNodes[i];
    _brainNodeMap[n.id] = n;
    _brainAdjacency[n.id] = [];
  }
  for (var j = 0; j < _brainEdges.length; j++) {
    var e = _brainEdges[j];
    if (_brainAdjacency[e.source]) _brainAdjacency[e.source].push({ node: _brainNodeMap[e.target], edge: e });
    if (_brainAdjacency[e.target]) _brainAdjacency[e.target].push({ node: _brainNodeMap[e.source], edge: e });
  }

  _brainSelectedId = null;
  _brainHoveredId = null;
  _brainSearchMatches = null;

  _updateFilterCounts();
  _updateBrainStats();

  _destroyBrainGraph();

  if (_brainNodes.length > 0) {
    _buildSimulation();
    if (!_brainInitialized) {
      _initInteractions();
      _brainInitialized = true;
    }
    _fitGraphToView();
    _startAnimLoop();
  } else {
    _renderFrame();
  }
}

/* ── Destroy / cleanup ────────────────────────────────────────── */

function _destroyBrainGraph() {
  _stopAnimLoop();
  if (_brainSimulation) { _brainSimulation.stop(); _brainSimulation = null; }
  if (_brainTweenGroup) _brainTweenGroup.removeAll();
  _brainSimNodes = [];
  _brainSimLinks = [];
  _brainSimNodeMap = {};
  _brainDragNode = null;
}

/* ── Build simulation ─────────────────────────────────────────── */

function _buildSimulation() {
  _brainSimNodes = [];
  _brainSimNodeMap = {};

  for (var i = 0; i < _brainNodes.length; i++) {
    var n = _brainNodes[i];
    var sn = {
      id: n.id, type: n.type, label: n.label, size: n.size,
      x: n.x || 0, y: n.y || 0,
      _alpha: 1, _hidden: !_brainFilters[n.type]
    };
    _brainSimNodes.push(sn);
    _brainSimNodeMap[sn.id] = sn;
  }

  // Center pre-computed positions at origin
  var cx = 0, cy = 0, vc = 0;
  for (var k = 0; k < _brainSimNodes.length; k++) {
    if (!_brainSimNodes[k]._hidden) { cx += _brainSimNodes[k].x; cy += _brainSimNodes[k].y; vc++; }
  }
  if (vc > 0) {
    cx /= vc; cy /= vc;
    for (var m = 0; m < _brainSimNodes.length; m++) {
      _brainSimNodes[m].x -= cx;
      _brainSimNodes[m].y -= cy;
    }
  }

  _brainSimLinks = [];
  for (var j = 0; j < _brainEdges.length; j++) {
    var e = _brainEdges[j];
    var src = _brainSimNodeMap[e.source];
    var tgt = _brainSimNodeMap[e.target];
    if (src && tgt) {
      _brainSimLinks.push({
        source: src, target: tgt,
        type: e.type, weight: e.weight || 1, _alpha: 0.3
      });
    }
  }

  var visibleNodes = _brainSimNodes.filter(function(s) { return !s._hidden; });
  var visibleLinks = _brainSimLinks.filter(function(sl) { return !sl.source._hidden && !sl.target._hidden; });

  _brainSimulation = d3.forceSimulation(visibleNodes)
    .force('charge', d3.forceManyBody().strength(-50))
    .force('center', d3.forceCenter(0, 0).strength(0.3))
    .force('link', d3.forceLink(visibleLinks).id(function(d) { return d.id; }).distance(30))
    .force('collide', d3.forceCollide(function(d) { return _nodeRadius(d) + 1; }).iterations(3))
    .alpha(0.3)
    .alphaDecay(0.02)
    .velocityDecay(0.4);

  if (!_brainTweenGroup) _brainTweenGroup = new TWEEN.Group();
}

/* ── Interactions (init once) ─────────────────────────────────── */

function _initInteractions() {
  var canvas = document.getElementById('brain-canvas');
  if (!canvas) return;

  _brainTransform = d3.zoomIdentity;

  // d3-drag — applied first so it intercepts before zoom when a node is hit
  var dragBehavior = d3.drag()
    .container(function() { return canvas; })
    .subject(function(event) {
      var t = _brainTransform;
      var se = event.sourceEvent;
      var gx = (se.offsetX - t.x) / t.k;
      var gy = (se.offsetY - t.y) / t.k;
      return _findNodeAt(gx, gy);
    })
    .on('start', function(event) {
      if (!event.subject) return;
      _brainDragNode = event.subject;
      _brainDragNode.__init = { x: _brainDragNode.x, y: _brainDragNode.y };
      _brainDragNode.fx = _brainDragNode.x;
      _brainDragNode.fy = _brainDragNode.y;
      _brainDragStartTime = Date.now();
      _brainDragDist = 0;
      if (_brainSimulation) _brainSimulation.alphaTarget(0.3).restart();
      if (!_brainAnimating) _startAnimLoop();
      canvas.style.cursor = 'grabbing';
    })
    .on('drag', function(event) {
      if (!_brainDragNode) return;
      var t = _brainTransform;
      var init = _brainDragNode.__init;
      _brainDragNode.fx = init.x + (event.x - init.x) / t.k;
      _brainDragNode.fy = init.y + (event.y - init.y) / t.k;
      _brainDragDist += Math.sqrt(event.dx * event.dx + event.dy * event.dy);
    })
    .on('end', function(event) {
      if (!_brainDragNode) return;
      var draggedId = _brainDragNode.id;
      _brainDragNode.fx = null;
      _brainDragNode.fy = null;
      if (_brainSimulation) _brainSimulation.alphaTarget(0);
      canvas.style.cursor = _brainHoveredId ? 'pointer' : 'default';
      if (Date.now() - _brainDragStartTime < 300 && _brainDragDist < 8) {
        _brainSelectedId = draggedId;
        openBrainPanel(draggedId);
      }
      _brainDragNode = null;
    });

  // d3-zoom — pan and zoom
  _brainZoomBehavior = d3.zoom()
    .scaleExtent([0.1, 10])
    .on('zoom', function(event) {
      _brainTransform = event.transform;
    });

  d3.select(canvas).call(dragBehavior).call(_brainZoomBehavior);

  // Hover detection
  canvas.addEventListener('mousemove', function(ev) {
    if (_brainDragNode) return;
    var t = _brainTransform || { x: 0, y: 0, k: 1 };
    var gx = (ev.offsetX - t.x) / t.k;
    var gy = (ev.offsetY - t.y) / t.k;
    var hit = _findNodeAt(gx, gy);
    var hitId = hit ? hit.id : null;
    if (hitId !== _brainHoveredId) {
      _brainHoveredId = hitId;
      _updateHoverState();
      canvas.style.cursor = hitId ? 'pointer' : 'default';
    }
  });

  canvas.addEventListener('mouseleave', function() {
    if (_brainHoveredId) {
      _brainHoveredId = null;
      _updateHoverState();
    }
  });

  // Click on empty → deselect
  canvas.addEventListener('click', function(ev) {
    if (_brainDragNode) return;
    var t = _brainTransform || { x: 0, y: 0, k: 1 };
    var gx = (ev.offsetX - t.x) / t.k;
    var gy = (ev.offsetY - t.y) / t.k;
    var hit = _findNodeAt(gx, gy);
    if (!hit && _brainSelectedId) {
      _brainSelectedId = null;
      closeBrainPanel();
    }
  });

  window.addEventListener('resize', _resizeBrainCanvas);
  _resizeBrainCanvas();

  if (window.claw.onBrainGraphRebuilt) {
    window.claw.onBrainGraphRebuilt(function() {
      _brainRefreshing = false;
      var btn = document.getElementById('brain-refresh-btn');
      if (btn) btn.classList.remove('spinning');
      loadBrainGraph();
      if (typeof showToast === 'function') showToast('Brain graph đã cập nhật xong', 'success');
    });
  }
}

/* ── Hover state + tweens ─────────────────────────────────────── */

function _updateHoverState() {
  if (!_brainTweenGroup) return;
  _brainTweenGroup.removeAll();

  _brainHoveredNeighbors = new Set();

  if (_brainHoveredId) {
    _brainHoveredNeighbors.add(_brainHoveredId);
    var adj = _brainAdjacency[_brainHoveredId] || [];
    for (var i = 0; i < adj.length; i++) {
      if (adj[i].node) _brainHoveredNeighbors.add(adj[i].node.id);
    }
  }

  for (var j = 0; j < _brainSimNodes.length; j++) {
    var sn = _brainSimNodes[j];
    var target = _brainHoveredId ? (_brainHoveredNeighbors.has(sn.id) ? 1.0 : 0.15) : 1.0;
    if (Math.abs(sn._alpha - target) > 0.01) {
      new TWEEN.Tween(sn, _brainTweenGroup).to({ _alpha: target }, 200).start();
    }
  }

  for (var k = 0; k < _brainSimLinks.length; k++) {
    var sl = _brainSimLinks[k];
    var srcId = sl.source.id || sl.source;
    var tgtId = sl.target.id || sl.target;
    var active = _brainHoveredId && (srcId === _brainHoveredId || tgtId === _brainHoveredId);
    var target2 = _brainHoveredId ? (active ? 0.8 : 0.05) : 0.3;
    if (Math.abs(sl._alpha - target2) > 0.01) {
      new TWEEN.Tween(sl, _brainTweenGroup).to({ _alpha: target2 }, 200).start();
    }
  }

  if (!_brainAnimating && _brainSimNodes.length > 0) _startAnimLoop();
}

/* ── Animation loop ───────────────────────────────────────────── */

function _startAnimLoop() {
  if (_brainAnimating) return;
  _brainAnimating = true;
  function tick() {
    if (!_brainAnimating) return;
    if (_brainTweenGroup) _brainTweenGroup.update();
    _renderFrame();
    _brainAnimFrameId = requestAnimationFrame(tick);
  }
  _brainAnimFrameId = requestAnimationFrame(tick);
}

function _stopAnimLoop() {
  _brainAnimating = false;
  if (_brainAnimFrameId) { cancelAnimationFrame(_brainAnimFrameId); _brainAnimFrameId = null; }
}

/* ── Render (Canvas 2D) ──────────────────────────────────────── */

function _renderFrame() {
  var canvas = document.getElementById('brain-canvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var dpr = window.devicePixelRatio || 1;
  var cw = canvas.width / dpr;
  var ch = canvas.height / dpr;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);

  ctx.fillStyle = BRAIN_BG;
  ctx.fillRect(0, 0, cw, ch);

  if (_brainSimNodes.length === 0) {
    ctx.fillStyle = '#64748b';
    ctx.font = '14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Chưa có dữ liệu. Bot sẽ tự động xây dựng bộ não khi có khách hàng.', cw / 2, ch / 2);
    ctx.restore();
    return;
  }

  var t = _brainTransform || { x: 0, y: 0, k: 1 };
  ctx.translate(t.x, t.y);
  ctx.scale(t.k, t.k);

  // ── Edges ──
  for (var j = 0; j < _brainSimLinks.length; j++) {
    var sl = _brainSimLinks[j];
    var src = sl.source, tgt = sl.target;
    if (!src || !tgt || src._hidden || tgt._hidden) continue;
    if (src.x == null || tgt.x == null) continue;

    var isConn = _brainSelectedId && (src.id === _brainSelectedId || tgt.id === _brainSelectedId);
    var eColor = isConn ? '#a5b4fc' : (BRAIN_EDGE_COLORS[sl.type] || '#6b7280');
    var eAlpha = isConn ? Math.max(sl._alpha, 0.8) : sl._alpha;

    ctx.beginPath();
    ctx.moveTo(src.x, src.y);
    ctx.lineTo(tgt.x, tgt.y);
    ctx.strokeStyle = _rgba(eColor, eAlpha);
    ctx.lineWidth = (isConn ? 2 : 1) / t.k;
    ctx.stroke();
  }

  // ── Nodes ──
  for (var i = 0; i < _brainSimNodes.length; i++) {
    var sn = _brainSimNodes[i];
    if (sn._hidden || sn.x == null) continue;

    var radius = _nodeRadius(sn);
    var color = BRAIN_COLORS[sn.type] || '#94a3b8';
    var alpha = sn._alpha;
    var isSearch = _brainSearchMatches && _brainSearchMatches.has(sn.id);
    var isSelected = sn.id === _brainSelectedId;
    var isHovered = sn.id === _brainHoveredId;

    // Search glow
    if (isSearch) {
      ctx.beginPath();
      ctx.arc(sn.x, sn.y, radius * 2.5, 0, Math.PI * 2);
      ctx.fillStyle = _rgba(color, 0.2 * alpha);
      ctx.fill();
    }

    // Node body
    var drawR = isSearch ? radius * 1.8 : (isHovered ? radius * 1.3 : radius);
    ctx.beginPath();
    ctx.arc(sn.x, sn.y, drawR, 0, Math.PI * 2);
    ctx.fillStyle = _rgba(color, alpha);
    ctx.fill();

    // Selected ring
    if (isSelected) {
      ctx.beginPath();
      ctx.arc(sn.x, sn.y, drawR + 3 / t.k, 0, Math.PI * 2);
      ctx.strokeStyle = _rgba('#ffffff', alpha);
      ctx.lineWidth = 1.5 / t.k;
      ctx.stroke();
    }
  }

  // ── Hovered node label ──
  if (_brainHoveredId) {
    var hn = _brainSimNodeMap[_brainHoveredId];
    if (hn && !hn._hidden && hn.x != null) {
      var fSize = Math.max(10, 12 / t.k);
      ctx.font = 'bold ' + fSize + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';

      var lbl = hn.label || hn.id;
      var met = ctx.measureText(lbl);
      var lx = hn.x + 10 / t.k;
      var ly = hn.y - 8 / t.k;
      var pH = 4 / t.k, pW = 6 / t.k, cr = 3 / t.k;

      ctx.fillStyle = 'rgba(0,0,0,0.82)';
      _roundRect(ctx, lx - pW, ly - fSize - pH, met.width + pW * 2, fSize + pH * 2, cr);
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.fillText(lbl, lx, ly);
    }
  }

  // ── Labels at high zoom ──
  if (t.k > 1.5) {
    var lAlpha = Math.min(1, (t.k - 1.5) / 2);
    var lFs = 9 / t.k;
    ctx.font = lFs + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (var n = 0; n < _brainSimNodes.length; n++) {
      var sn2 = _brainSimNodes[n];
      if (sn2._hidden || sn2.id === _brainHoveredId || sn2.x == null) continue;
      ctx.fillStyle = _rgba('#e2e8f0', lAlpha * sn2._alpha);
      ctx.fillText(sn2.label || sn2.id, sn2.x, sn2.y + _nodeRadius(sn2) + 2 / t.k);
    }
  }

  ctx.restore();
}

/* ── Canvas resize ────────────────────────────────────────────── */

function _resizeBrainCanvas() {
  var canvas = document.getElementById('brain-canvas');
  if (!canvas) return;
  var parent = canvas.parentElement;
  if (!parent) return;
  var dpr = window.devicePixelRatio || 1;
  var w = parent.clientWidth;
  var h = parent.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
}

/* ── Zoom helpers ─────────────────────────────────────────────── */

function brainZoomIn() {
  var canvas = document.getElementById('brain-canvas');
  if (!canvas || !_brainZoomBehavior) return;
  d3.select(canvas).transition().duration(200).call(_brainZoomBehavior.scaleBy, 1.4);
}

function brainZoomOut() {
  var canvas = document.getElementById('brain-canvas');
  if (!canvas || !_brainZoomBehavior) return;
  d3.select(canvas).transition().duration(200).call(_brainZoomBehavior.scaleBy, 1 / 1.4);
}

function _fitGraphToView() {
  var canvas = document.getElementById('brain-canvas');
  if (!canvas || !_brainZoomBehavior || _brainSimNodes.length === 0) return;

  var dpr = window.devicePixelRatio || 1;
  var cw = canvas.width / dpr;
  var ch = canvas.height / dpr;

  var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  var count = 0;
  for (var i = 0; i < _brainSimNodes.length; i++) {
    var sn = _brainSimNodes[i];
    if (sn._hidden) continue;
    if (sn.x < minX) minX = sn.x;
    if (sn.x > maxX) maxX = sn.x;
    if (sn.y < minY) minY = sn.y;
    if (sn.y > maxY) maxY = sn.y;
    count++;
  }
  if (count === 0 || !isFinite(minX)) return;

  var graphW = maxX - minX || 1;
  var graphH = maxY - minY || 1;
  var padding = 80;
  var scale = Math.min((cw - padding * 2) / graphW, (ch - padding * 2) / graphH);
  scale = Math.max(0.1, Math.min(5, scale));

  var gcx = (minX + maxX) / 2;
  var gcy = (minY + maxY) / 2;
  var transform = d3.zoomIdentity.translate(cw / 2, ch / 2).scale(scale).translate(-gcx, -gcy);

  d3.select(canvas).call(_brainZoomBehavior.transform, transform);
  _brainTransform = transform;
}

function _fitToNodes(idSet) {
  var canvas = document.getElementById('brain-canvas');
  if (!canvas || !_brainZoomBehavior) return;

  var dpr = window.devicePixelRatio || 1;
  var cw = canvas.width / dpr;
  var ch = canvas.height / dpr;

  var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  var count = 0;
  for (var i = 0; i < _brainSimNodes.length; i++) {
    var sn = _brainSimNodes[i];
    if (!idSet.has(sn.id)) continue;
    if (sn.x < minX) minX = sn.x;
    if (sn.x > maxX) maxX = sn.x;
    if (sn.y < minY) minY = sn.y;
    if (sn.y > maxY) maxY = sn.y;
    count++;
  }
  if (count === 0 || !isFinite(minX)) return;

  var transform;
  if (count === 1) {
    transform = d3.zoomIdentity.translate(cw / 2, ch / 2).scale(2.5).translate(-minX, -minY);
  } else {
    var graphW = maxX - minX || 1;
    var graphH = maxY - minY || 1;
    var padding = 60;
    var scale = Math.min((cw - padding * 2) / graphW, (ch - padding * 2) / graphH);
    scale = Math.max(0.1, Math.min(10, scale));
    var gcx = (minX + maxX) / 2;
    var gcy = (minY + maxY) / 2;
    transform = d3.zoomIdentity.translate(cw / 2, ch / 2).scale(scale).translate(-gcx, -gcy);
  }

  d3.select(canvas).transition().duration(300).call(_brainZoomBehavior.transform, transform);
}

/* ── Search ───────────────────────────────────────────────────── */

function searchBrainGraph(query) {
  if (!query || !query.trim()) {
    _brainSearchMatches = null;
    return;
  }

  var norm = _stripDiacritics(query.trim().toLowerCase());
  var matches = new Set();

  for (var i = 0; i < _brainSimNodes.length; i++) {
    var sn = _brainSimNodes[i];
    if (sn._hidden) continue;
    var label = _stripDiacritics((sn.label || '').toLowerCase());
    if (label.indexOf(norm) !== -1) matches.add(sn.id);
  }

  _brainSearchMatches = matches.size > 0 ? matches : null;
  if (matches.size > 0) _fitToNodes(matches);
}

/* ── Filter chips ─────────────────────────────────────────────── */

function toggleBrainFilter(type) {
  _brainFilters[type] = !_brainFilters[type];
  var chips = document.querySelectorAll('.brain-chip');
  chips.forEach(function(chip) {
    if (chip.dataset.type === type) chip.classList.toggle('off', !_brainFilters[type]);
  });
  _rebuildSimulationForFilters();
}

function _rebuildSimulationForFilters() {
  for (var i = 0; i < _brainSimNodes.length; i++) {
    _brainSimNodes[i]._hidden = !_brainFilters[_brainSimNodes[i].type];
  }

  if (_brainSimulation) {
    var visibleNodes = _brainSimNodes.filter(function(s) { return !s._hidden; });
    var visibleLinks = _brainSimLinks.filter(function(sl) {
      return sl.source && sl.target && !sl.source._hidden && !sl.target._hidden;
    });
    _brainSimulation.nodes(visibleNodes);
    _brainSimulation.force('link').links(visibleLinks);
    _brainSimulation.alpha(0.3).restart();
  }

  if (!_brainAnimating && _brainSimNodes.length > 0) _startAnimLoop();
}

function _updateFilterCounts() {
  var counts = { customer: 0, group: 0, doc: 0, learning: 0, skill: 0 };
  for (var i = 0; i < _brainNodes.length; i++) {
    var t = _brainNodes[i].type;
    if (counts[t] !== undefined) counts[t]++;
  }
  var types = Object.keys(counts);
  for (var j = 0; j < types.length; j++) {
    var el = document.getElementById('brain-count-' + types[j]);
    if (el) el.textContent = counts[types[j]];
  }
}

/* ── Stats ────────────────────────────────────────────────────── */

function _updateBrainStats() {
  var el = document.getElementById('brain-stats');
  if (!el) return;
  var nc = _brainStats ? _brainStats.nodes : _brainNodes.length;
  var ec = _brainStats ? _brainStats.edges : _brainEdges.length;
  el.textContent = nc + ' nodes · ' + ec + ' edges';
}

/* ── Side panel ───────────────────────────────────────────────── */

async function openBrainPanel(nodeId) {
  var panel = document.getElementById('brain-panel');
  if (!panel) return;
  var node = _brainNodeMap[nodeId];
  if (!node) return;

  panel.classList.add('open');

  var dot = document.getElementById('brain-panel-dot');
  if (dot) dot.style.background = BRAIN_COLORS[node.type] || '#94a3b8';

  var labelEl = document.getElementById('brain-panel-label');
  if (labelEl) labelEl.textContent = node.label || node.id;

  var typeEl = document.getElementById('brain-panel-type');
  if (typeEl) {
    var typeLabels = { customer: 'Khách hàng', group: 'Nhóm', doc: 'Tài liệu', learning: 'Học hỏi', skill: 'Kỹ năng' };
    typeEl.textContent = typeLabels[node.type] || node.type;
  }

  var linksEl = document.getElementById('brain-panel-chips');
  if (linksEl) {
    linksEl.innerHTML = '';
    var adj = _brainAdjacency[nodeId] || [];
    for (var i = 0; i < adj.length && i < 20; i++) {
      var linked = adj[i].node;
      if (!linked) continue;
      var chip = document.createElement('span');
      chip.className = 'bpl-chip';
      chip.textContent = linked.label || linked.id;
      chip.style.borderColor = BRAIN_COLORS[linked.type] || '#94a3b8';
      chip.style.color = BRAIN_COLORS[linked.type] || '#94a3b8';
      chip.dataset.nodeId = linked.id;
      chip.addEventListener('click', _onLinkChipClick);
      linksEl.appendChild(chip);
    }
    if (adj.length === 0) {
      linksEl.innerHTML = '<span class="brain-panel-empty">Không có liên kết</span>';
    }
  }

  var contentEl = document.getElementById('brain-panel-content');
  if (contentEl) {
    contentEl.innerHTML = '<span class="brain-panel-loading">...</span>';
    try {
      var detail = await window.claw.getBrainNodeDetail(nodeId);
      if (detail && detail.content) {
        var truncated = detail.content.length > 500 ? detail.content.substring(0, 500) + '...' : detail.content;
        var html = DOMPurify.sanitize(marked.parse(truncated));
        contentEl.innerHTML = html;
      } else {
        contentEl.innerHTML = '<span class="brain-panel-empty">Không có nội dung</span>';
      }
    } catch (err) {
      contentEl.innerHTML = '<span class="brain-panel-empty">Không tải được nội dung</span>';
    }
  }

  var actionEl = document.getElementById('brain-panel-action');
  if (actionEl) {
    var actionMap = {
      customer: { label: 'Mở trong Zalo', page: 'zalo' },
      group:    { label: 'Mở trong Zalo', page: 'zalo' },
      doc:      { label: 'Mở trong Knowledge', page: 'knowledge' },
      learning: null, skill: null
    };
    var action = actionMap[node.type];
    if (action) {
      actionEl.textContent = action.label;
      actionEl.style.display = '';
      actionEl.onclick = function() { if (typeof switchPage === 'function') switchPage(action.page); };
    } else {
      actionEl.style.display = 'none';
    }
  }
}

function closeBrainPanel() {
  var panel = document.getElementById('brain-panel');
  if (panel) panel.classList.remove('open');
  _brainSelectedId = null;
}

function _onLinkChipClick(ev) {
  var nodeId = ev.currentTarget.dataset.nodeId;
  if (!nodeId) return;
  var sn = _brainSimNodeMap[nodeId];
  if (!sn) return;

  _brainSelectedId = nodeId;

  var canvas = document.getElementById('brain-canvas');
  if (canvas && _brainZoomBehavior) {
    var dpr = window.devicePixelRatio || 1;
    var cw = canvas.width / dpr;
    var ch = canvas.height / dpr;
    var scale = Math.max((_brainTransform || { k: 1 }).k, 1.5);
    var transform = d3.zoomIdentity.translate(cw / 2, ch / 2).scale(scale).translate(-sn.x, -sn.y);
    d3.select(canvas).transition().duration(300).call(_brainZoomBehavior.transform, transform);
  }

  openBrainPanel(nodeId);
}

/* ── Refresh ──────────────────────────────────────────────────── */

function refreshBrainGraph() {
  if (_brainRefreshing) return;
  _brainRefreshing = true;
  var btn = document.getElementById('brain-refresh-btn');
  if (btn) btn.classList.add('spinning');
  window.claw.rebuildBrainGraph().catch(function(err) {
    console.error('[brain] rebuildBrainGraph failed:', err);
    _brainRefreshing = false;
    if (btn) btn.classList.remove('spinning');
    if (typeof showToast === 'function') showToast('Không thể cập nhật Brain graph', 'error');
  });
}

/* ── Lifecycle ────────────────────────────────────────────────── */

function onBrainTabActivate() {
  _resizeBrainCanvas();
  if (_brainSimNodes.length > 0 && !_brainAnimating) {
    if (_brainSimulation) _brainSimulation.restart();
    _startAnimLoop();
  } else {
    _renderFrame();
  }
}

function onBrainTabDeactivate() {
  _stopAnimLoop();
  if (_brainSimulation) _brainSimulation.stop();
}
