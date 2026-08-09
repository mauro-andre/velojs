/**
 * VeloJS Graph Viewer
 *
 * Serves an interactive, self-contained HTML visualization of
 * .velojs/graph.json — route tree + force-directed dependency graph.
 * Plain node:http, no dependencies. The graph JSON is read from disk
 * on every request so the view is always fresh.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const VIEWER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>VeloJS Graph</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #0b0e14; color: #d7dde8; overflow: hidden; }
  #topbar { display: flex; align-items: center; gap: 12px; padding: 10px 14px; background: #11151f; border-bottom: 1px solid #232a3a; }
  #topbar h1 { font-size: 14px; font-weight: 600; color: #e8edf5; }
  #topbar h1 span { color: #5b8def; }
  .tab { padding: 5px 14px; border-radius: 6px; border: 1px solid #2a3247; background: transparent; color: #9aa5b8; font: inherit; font-size: 12px; cursor: pointer; }
  .tab.active { background: #1d2740; color: #e8edf5; border-color: #3d5a99; }
  #search { margin-left: auto; padding: 5px 10px; border-radius: 6px; border: 1px solid #2a3247; background: #0b0e14; color: #d7dde8; font: inherit; font-size: 12px; width: 220px; }
  #search:focus { outline: none; border-color: #3d5a99; }
  #canvas { display: block; cursor: grab; }
  #panel { position: fixed; top: 46px; right: 0; width: 330px; bottom: 0; background: #11151f; border-left: 1px solid #232a3a; padding: 16px; overflow-y: auto; transform: translateX(100%); transition: transform .18s ease; font-size: 12px; }
  #panel.open { transform: translateX(0); }
  #panel h2 { font-size: 14px; color: #e8edf5; word-break: break-all; margin-bottom: 4px; }
  #panel .file { color: #6b768c; font-size: 11px; margin-bottom: 12px; word-break: break-all; }
  #panel h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #6b768c; margin: 14px 0 6px; }
  #panel li { list-style: none; padding: 3px 0; color: #aebad0; word-break: break-all; cursor: pointer; }
  #panel li:hover { color: #5b8def; }
  #panel li.ext { color: #6b768c; cursor: default; }
  #panel li.ext:hover { color: #6b768c; }
  .badge { display: inline-block; padding: 1px 7px; border-radius: 4px; font-size: 10px; margin-right: 5px; background: #1d2740; color: #9db8ef; border: 1px solid #2f3d5f; }
  #legend { position: fixed; left: 14px; bottom: 14px; background: #11151fdd; border: 1px solid #232a3a; border-radius: 8px; padding: 10px 14px; font-size: 11px; color: #9aa5b8; }
  #legend i { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 6px; }
  #hint { position: fixed; left: 50%; transform: translateX(-50%); bottom: 14px; font-size: 11px; color: #55607a; }
</style>
</head>
<body>
<div id="topbar">
  <h1>velo<span>js</span> graph</h1>
  <button class="tab active" id="tab-routes">Route tree</button>
  <button class="tab" id="tab-modules">Dependencies</button>
  <input id="search" placeholder="filter modules... (/)">
</div>
<canvas id="canvas"></canvas>
<div id="panel"></div>
<div id="legend">
  <div><i style="background:#f59e0b"></i>root</div>
  <div><i style="background:#a78bfa"></i>layout</div>
  <div><i style="background:#5b8def"></i>page</div>
  <div><i style="background:#4b5565"></i>module</div>
</div>
<div id="hint">drag to pan · scroll to zoom · drag nodes · hover = impact · click = focus neighborhood · / = search · esc = reset</div>
<script>
var KIND_COLORS = { root: "#f59e0b", layout: "#a78bfa", page: "#5b8def", unknown: "#4b5565" };

var graph = null;
var view = "routes";
var cam = { x: 0, y: 0, k: 1 };
var canvas = document.getElementById("canvas");
var ctx = canvas.getContext("2d");
var W = 0, H = 0;

function resize() {
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = W * devicePixelRatio; canvas.height = H * devicePixelRatio;
  canvas.style.width = W + "px"; canvas.style.height = H + "px";
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
}
window.addEventListener("resize", resize); resize();

// ---------- data ----------
var modNodes = [], modEdges = [], modById = {};
var routeNodes = [], routeEdges = [];

function buildModuleGraph() {
  var ids = Object.keys(graph.modules);
  ids.forEach(function (id, i) {
    var m = graph.modules[id];
    modNodes.push({ id: id, kind: m.kind, exports: m.exports, imports: m.imports, importedBy: m.importedBy, file: m.file,
      x: (Math.random() - 0.5) * 800, y: (Math.random() - 0.5) * 800, vx: 0, vy: 0 });
  });
  modNodes.forEach(function (n) { modById[n.id] = n; });
  modNodes.forEach(function (n) {
    n.imports.forEach(function (imp) {
      if (modById[imp]) modEdges.push({ from: n, to: modById[imp] });
    });
  });
}

function buildRouteLayout() {
  var leafCount = 0;
  // tidy-ish: leaves get sequential x; parents sit at the midpoint of children
  function layout(node, depth, parent) {
    var rn = { data: node, depth: depth, x: 0, y: depth, parent: parent, kids: [] };
    routeNodes.push(rn);
    if (parent) { parent.kids.push(rn); routeEdges.push({ from: parent, to: rn }); }
    if (!node.children.length) { rn.x = leafCount++; return rn; }
    var xs = node.children.map(function (c) { return layout(c, depth + 1, rn).x; });
    rn.x = (xs[0] + xs[xs.length - 1]) / 2;
    return rn;
  }
  graph.routes.forEach(function (r) { layout(r, 0, null); });
  var gapX = 250, gapY = 130;
  var minX = Math.min.apply(null, routeNodes.map(function (n) { return n.x; }));
  routeNodes.forEach(function (n) { n.px = (n.x - minX) * gapX + 80; n.py = n.y * gapY + 80; });
}

// ---------- camera helpers ----------
function fitView(xs, ys) {
  var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
  var minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
  var w = Math.max(maxX - minX, 1), h = Math.max(maxY - minY, 1);
  cam.k = Math.min((W - 120) / w, (H - 120) / h, 1.4);
  cam.x = W / 2 - (minX + w / 2) * cam.k;
  cam.y = H / 2 - (minY + h / 2) * cam.k;
}
function toScreen(x, y) { return [x * cam.k + cam.x, y * cam.k + cam.y]; }
function toWorld(sx, sy) { return [(sx - cam.x) / cam.k, (sy - cam.y) / cam.k]; }

// ---------- force simulation (modules) ----------
var alpha = 1;
var MAXV = 25;
function tick() {
  if (alpha < 0.005) return;
  alpha *= 0.995;
  var i, j, n, m, dx, dy, d2, f;
  for (i = 0; i < modNodes.length; i++) {
    n = modNodes[i];
    for (j = i + 1; j < modNodes.length; j++) {
      m = modNodes[j];
      dx = n.x - m.x; dy = n.y - m.y;
      d2 = dx * dx + dy * dy + 0.01;
      f = 2600 / d2 * alpha;
      var d = Math.sqrt(d2);
      n.vx += dx / d * f; n.vy += dy / d * f;
      m.vx -= dx / d * f; m.vy -= dy / d * f;
    }
  }
  modEdges.forEach(function (e) {
    dx = e.to.x - e.from.x; dy = e.to.y - e.from.y;
    var d = Math.sqrt(dx * dx + dy * dy) || 1;
    f = (d - 110) * 0.02 * alpha;
    e.from.vx += dx / d * f * d * 0.02; e.from.vy += dy / d * f * d * 0.02;
    e.to.vx -= dx / d * f * d * 0.02; e.to.vy -= dy / d * f * d * 0.02;
  });
  modNodes.forEach(function (n) {
    if (n === dragNode) return;
    n.vx += -n.x * 0.002 * alpha; n.vy += -n.y * 0.002 * alpha;
    n.vx *= 0.85; n.vy *= 0.85;
    if (n.vx > MAXV) n.vx = MAXV; else if (n.vx < -MAXV) n.vx = -MAXV;
    if (n.vy > MAXV) n.vy = MAXV; else if (n.vy < -MAXV) n.vy = -MAXV;
    n.x += n.vx; n.y += n.vy;
  });
}

// ---------- focus mode ----------
// Click isolates a node's neighborhood: transitive imports + importedBy
// (modules), or ancestors + subtree (routes). Click empty / ESC exits.
var focusModSet = null, focusRouteSet = null;
function computeFocusModules(id) {
  var set = {}, q = [id];
  set[id] = true;
  while (q.length) {
    var m = graph.modules[q.shift()];
    if (!m) continue;
    m.imports.forEach(function (i) { if (modById[i] && !set[i]) { set[i] = true; q.push(i); } });
    m.importedBy.forEach(function (i) { if (modById[i] && !set[i]) { set[i] = true; q.push(i); } });
  }
  return set;
}
function computeFocusRoutes(rn) {
  var set = [];
  var p = rn.parent;
  while (p) { set.push(p); p = p.parent; }
  (function down(n) { set.push(n); n.kids.forEach(down); })(rn);
  return set;
}
function modVisible(n) { return matches(n.id) && (!focusModSet || focusModSet[n.id]); }
function routeVisible(n) { return matches(n.data.moduleId || "(wrapper)") && (!focusRouteSet || focusRouteSet.indexOf(n) >= 0); }

// ---------- impact highlight ----------
var hoverNode = null;
var impactSet = null;
function computeImpact(n) {
  var set = {}, queue = [n.id];
  set[n.id] = 2;
  while (queue.length) {
    var id = queue.shift();
    var mod = graph.modules[id];
    if (!mod) continue;
    mod.importedBy.forEach(function (up) {
      if (!(up in set)) { set[up] = 1; queue.push(up); }
    });
  }
  return set;
}

// ---------- selection / panel ----------
var selected = null;
var panel = document.getElementById("panel");
function showPanel(id) {
  selected = id;
  var m = graph.modules[id];
  if (!m) { panel.className = ""; panel.innerHTML = ""; return; }
  var b = [];
  if (m.exports.hasComponent) b.push('<span class="badge">Component</span>');
  if (m.exports.hasLoader) b.push('<span class="badge">loader</span>');
  m.exports.actions.forEach(function (a) { b.push('<span class="badge">action_' + a + "</span>"); });
  m.exports.streams.forEach(function (s) { b.push('<span class="badge">stream_' + s + "</span>"); });
  m.exports.sockets.forEach(function (s) { b.push('<span class="badge">socket_' + s + "</span>"); });
  var html = "<h2>" + id + '</h2><div class="file">' + m.file + " · " + m.kind + "</div><div>" + b.join("") + "</div>";
  html += "<h3>imports (" + m.imports.length + ")</h3><ul>";
  m.imports.forEach(function (i) {
    html += modById[i] ? "<li data-id='" + i + "'>→ " + i + "</li>" : "<li class='ext'>→ " + i + "</li>";
  });
  html += "</ul><h3>imported by (" + m.importedBy.length + ")</h3><ul>";
  m.importedBy.forEach(function (i) { html += "<li data-id='" + i + "'>← " + i + "</li>"; });
  html += "</ul>";
  panel.innerHTML = html;
  panel.className = "open";
  panel.querySelectorAll("li[data-id]").forEach(function (li) {
    li.addEventListener("click", function () { showPanel(li.getAttribute("data-id")); focusModule(li.getAttribute("data-id")); });
  });
}
function focusModule(id) {
  var n = modById[id];
  if (!n) return;
  if (view !== "modules") setView("modules");
  cam.x = W / 2 - n.x * cam.k; cam.y = H / 2 - n.y * cam.k;
}

// ---------- search ----------
var query = "";
document.getElementById("search").addEventListener("input", function (e) { query = e.target.value.toLowerCase(); });
document.addEventListener("keydown", function (e) {
  if (e.key === "/" && document.activeElement !== document.getElementById("search")) { e.preventDefault(); document.getElementById("search").focus(); }
  if (e.key === "Escape") { panel.className = ""; selected = null; query = ""; document.getElementById("search").value = ""; focusModSet = null; focusRouteSet = null; }
});

// ---------- interaction ----------
var dragNode = null, panning = false, lastX = 0, lastY = 0, moved = false;
function nodeAt(sx, sy) {
  var w = toWorld(sx, sy);
  var list = view === "modules" ? modNodes : routeNodes;
  for (var i = list.length - 1; i >= 0; i--) {
    var n = list[i];
    if (view === "modules" ? !modVisible(n) : !routeVisible(n)) continue;
    var nx = view === "modules" ? n.x : n.px, ny = view === "modules" ? n.y : n.py;
    var dx = w[0] - nx, dy = w[1] - ny;
    if (dx * dx + dy * dy < 14 * 14 / (cam.k * cam.k) + 36) return n;
  }
  return null;
}
canvas.addEventListener("mousedown", function (e) {
  var n = nodeAt(e.clientX, e.clientY);
  if (n && view === "modules") { dragNode = n; alpha = Math.max(alpha, 0.3); }
  else panning = true;
  lastX = e.clientX; lastY = e.clientY; moved = false;
});
canvas.addEventListener("mousemove", function (e) {
  var dx = e.clientX - lastX, dy = e.clientY - lastY;
  if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
  if (dragNode) { var w = toWorld(e.clientX, e.clientY); dragNode.x = w[0]; dragNode.y = w[1]; dragNode.vx = dragNode.vy = 0; }
  else if (panning) { cam.x += dx; cam.y += dy; }
  else {
    var n = nodeAt(e.clientX, e.clientY);
    hoverNode = view === "modules" ? n : null;
    impactSet = hoverNode ? computeImpact(hoverNode) : null;
    canvas.style.cursor = n ? "pointer" : "grab";
  }
  lastX = e.clientX; lastY = e.clientY;
});
canvas.addEventListener("mouseup", function (e) {
  if (!moved) {
    var n = nodeAt(e.clientX, e.clientY);
    if (view === "modules") {
      showPanel(n ? n.id : null);
      focusModSet = n ? computeFocusModules(n.id) : null;
    } else {
      if (n && n.data.moduleId) showPanel(n.data.moduleId);
      focusRouteSet = n ? computeFocusRoutes(n) : null;
    }
  }
  dragNode = null; panning = false;
});
canvas.addEventListener("wheel", function (e) {
  e.preventDefault();
  var k = Math.exp(-e.deltaY * 0.0012);
  var w = toWorld(e.clientX, e.clientY);
  cam.k *= k;
  cam.x = e.clientX - w[0] * cam.k; cam.y = e.clientY - w[1] * cam.k;
}, { passive: false });

// ---------- rendering ----------
function matches(id) { return !query || id.toLowerCase().indexOf(query) >= 0; }

function drawRoutes() {
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = "#2a3247"; ctx.lineWidth = 1.2;
  routeEdges.forEach(function (e) {
    if (!routeVisible(e.from) || !routeVisible(e.to)) return;
    var a = toScreen(e.from.px, e.from.py), b = toScreen(e.to.px, e.to.py);
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.bezierCurveTo(a[0], (a[1] + b[1]) / 2, b[0], (a[1] + b[1]) / 2, b[0], b[1]);
    ctx.stroke();
  });
  routeNodes.forEach(function (n) {
    var d = n.data;
    var id = d.moduleId || "(wrapper)";
    if (!routeVisible(n)) return;
    var p = toScreen(n.px, n.py);
    var color = d.isRoot ? KIND_COLORS.root : (d.children.length ? KIND_COLORS.layout : KIND_COLORS.page);
    var sel = selected === d.moduleId;
    ctx.beginPath(); ctx.arc(p[0], p[1], sel ? 9 : 6, 0, 7);
    ctx.fillStyle = color; ctx.fill();
    if (sel) { ctx.strokeStyle = "#e8edf5"; ctx.lineWidth = 2; ctx.stroke(); }
    // level-of-detail: labels only when zoomed in enough, otherwise the
    // overview stays clean (dots only). fullPath needs even more zoom.
    if (cam.k >= 0.55 || sel) {
      ctx.fillStyle = "#d7dde8"; ctx.font = "11px ui-monospace, monospace"; ctx.textAlign = "center";
      ctx.fillText(id.split("/").pop(), p[0], p[1] - 13);
    }
    if (cam.k >= 0.85 || sel) {
      ctx.fillStyle = "#55607a"; ctx.font = "10px ui-monospace, monospace";
      var sub = d.fullPath || "";
      if (d.middlewares.length) sub += "  ·  " + d.middlewares.join(", ");
      ctx.fillText(sub, p[0], p[1] + 20);
    }
  });
}

function drawModules() {
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = "#232a3a"; ctx.lineWidth = 1;
  modEdges.forEach(function (e) {
    if (!modVisible(e.from) || !modVisible(e.to)) return;
    var hot = impactSet && impactSet[e.from.id] && impactSet[e.to.id];
    var a = toScreen(e.from.x, e.from.y), b = toScreen(e.to.x, e.to.y);
    ctx.strokeStyle = hot ? "#f59e0b" : "#232a3a";
    ctx.lineWidth = hot ? 1.8 : 1;
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
  });
  modNodes.forEach(function (n) {
    if (!modVisible(n)) return;
    var p = toScreen(n.x, n.y);
    var dim = impactSet && !impactSet[n.id];
    var hot = impactSet && impactSet[n.id];
    var r = n.kind === "unknown" ? 4 : 7;
    ctx.globalAlpha = dim ? 0.15 : 1;
    ctx.beginPath(); ctx.arc(p[0], p[1], selected === n.id ? r + 3 : r, 0, 7);
    ctx.fillStyle = hot === 2 ? "#f59e0b" : KIND_COLORS[n.kind] || KIND_COLORS.unknown;
    ctx.fill();
    if (selected === n.id) { ctx.strokeStyle = "#e8edf5"; ctx.lineWidth = 2; ctx.stroke(); }
    if (!dim) {
      ctx.fillStyle = hot ? "#e8edf5" : "#9aa5b8";
      ctx.font = "10px ui-monospace, monospace"; ctx.textAlign = "center";
      ctx.fillText(n.id.split("/").pop(), p[0], p[1] - r - 5);
    }
    ctx.globalAlpha = 1;
  });
}

function frame() {
  tick();
  if (view === "routes") drawRoutes(); else drawModules();
  requestAnimationFrame(frame);
}

// ---------- tabs ----------
function setView(v) {
  view = v;
  document.getElementById("tab-routes").className = "tab" + (v === "routes" ? " active" : "");
  document.getElementById("tab-modules").className = "tab" + (v === "modules" ? " active" : "");
  if (v === "routes") fitView(routeNodes.map(function (n) { return n.px; }), routeNodes.map(function (n) { return n.py; }));
  else { alpha = Math.max(alpha, 0.4); fitView(modNodes.map(function (n) { return n.x; }), modNodes.map(function (n) { return n.y; })); }
}
document.getElementById("tab-routes").addEventListener("click", function () { setView("routes"); });
document.getElementById("tab-modules").addEventListener("click", function () { setView("modules"); });

// ---------- boot ----------
fetch("/graph.json").then(function (r) { return r.json(); }).then(function (g) {
  graph = g;
  buildModuleGraph();
  buildRouteLayout();
  alpha = 1;
  // pre-simulate so the first paint is already organized
  for (var i = 0; i < 300 && alpha > 0.05; i++) tick();
  setView("routes");
  frame();
});
</script>
</body>
</html>`;

/**
 * Starts the graph viewer server. Reads `.velojs/graph.json` from
 * projectRoot on every request — always fresh. Returns the URL.
 */
export async function serveGraphViewer(projectRoot: string): Promise<string> {
    const graphPath = path.join(projectRoot, ".velojs", "graph.json");

    const server = http.createServer((req, res) => {
        if (req.url === "/graph.json") {
            let body: string;
            try {
                body = fs.readFileSync(graphPath, "utf-8");
            } catch {
                res.writeHead(404, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "graph.json not found — run `velojs graph` first" }));
                return;
            }
            res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
            res.end(body);
            return;
        }

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(VIEWER_HTML);
    });

    const url = await new Promise<string>((resolvePromise) => {
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = typeof address === "object" && address ? address.port : 0;
            resolvePromise(`http://127.0.0.1:${port}`);
        });
    });

    return url;
}
