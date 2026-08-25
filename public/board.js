// board.js — PCB-style realtime visualization engine (two-canvas, pooled particles)

const KIND_COLOR = {
  log: '#58e88a', status: '#ffd166', task: '#8fd3ff', msg: '#4fd8ff',
  'state-set': '#ff9de2', 'state-del': '#ff9de2', dm: '#4fd8ff',
  spawn: '#f4f4a6', join: '#f4f4a6', exit: '#58e88a', leave: '#ff5470', err: '#ff5470',
};
const STATUS_LED = {
  booting: ['#ffd166', 6], working: ['#4fd8ff', 10], idle: ['#58e88a', 1.4],
  done: ['#58e88a', 0], error: ['#ff5470', 3], lost: ['#ff5470', 1],
};

function chamfer(pts, c = 9) {
  if (pts.length < 3) return pts.slice();
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const A = pts[i - 1], B = pts[i], C = pts[i + 1];
    const d1 = Math.hypot(B.x - A.x, B.y - A.y) || 1;
    const d2 = Math.hypot(C.x - B.x, C.y - B.y) || 1;
    const c1 = Math.min(c, d1 / 2), c2 = Math.min(c, d2 / 2);
    out.push({ x: B.x - ((B.x - A.x) / d1) * c1, y: B.y - ((B.y - A.y) / d1) * c1 });
    out.push({ x: B.x + ((C.x - B.x) / d2) * c2, y: B.y + ((C.y - B.y) / d2) * c2 });
  }
  out.push(pts[pts.length - 1]);
  return out;
}

export class Board {
  constructor(wrapper, bgCanvas, fxCanvas, { onHover, onSelect, onStats } = {}) {
    this.wrap = wrapper;
    this.bg = bgCanvas;
    this.fx = fxCanvas;
    this.b = bgCanvas.getContext('2d');
    this.f = fxCanvas.getContext('2d');
    this.onHover = onHover; this.onSelect = onSelect; this.onStats = onStats;

    this.W = 0; this.H = 0; this.dpr = 1;
    this.agents = new Map();
    this.traces = new Map();      // agentId -> trace
    this.packets = [];
    this.flashes = [];
    this.MAX_PACKETS = 520;
    this.selected = null;
    this.hovered = null;
    this.activity = 0;            // hub pulse 0..1
    this.termRects = new Map();   // agentId -> terminal window rect (board coords)

    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(wrapper);
    this.resize();

    fx.addEventListener('mousemove', (e) => this._pick(e.offsetX, e.offsetY));
    fx.addEventListener('mouseleave', () => { this.hovered = null; this.onHover?.(null); });
    fx.addEventListener('click', (e) => {
      const hit = this._hit(e.offsetX, e.offsetY);
      this.selected = hit ? hit.id : null;
      this.onSelect?.(this.selected);
    });

    let last = performance.now(), acc = 0, frames = 0, fpsT = 0;
    const loop = (t) => {
      const dt = Math.min(t - last, 50); last = t;
      acc += dt; frames++;
      if (t - fpsT > 1000) { this.onStats?.({ fps: Math.round(frames * 1000 / (t - fpsT)), pkts: this.packets.length }); fpsT = t; frames = 0; }
      this.tick(dt, t);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  resize() {
    const r = this.wrap.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.W = Math.max(320, r.width); this.H = Math.max(240, r.height);
    for (const cv of [this.bg, this.fx]) {
      cv.width = this.W * this.dpr; cv.height = this.H * this.dpr;
    }
    this.b.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.f.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.layout();
  }

  // ---------- topology ----------
  syncAgents(list) {
    const ids = new Set(list.map((a) => a.id));
    for (const a of list) {
      const cur = this.agents.get(a.id);
      if (cur) Object.assign(cur, a);
      else this.agents.set(a.id, { ...a, actT: 0 });
    }
    for (const id of [...this.agents.keys()]) if (!ids.has(id)) this.agents.delete(id);
    this.layout();
  }

  touchAgent(id) { const n = this.agents.get(id); if (n) n.actT = performance.now(); }

  syncTermRect(id, rect) {
    if (rect) this.termRects.set(id, { ...rect });
    else {
      const prev = this.termRects.get(id);
      if (prev && prev.dieAt === undefined) prev.dieAt = performance.now(); // begin dissolve
    }
  }

  _pin(side, i, n, rect) {
    // returns {x,y} of pin i of n on given side of rect
    const span = (side === 'left' || side === 'right') ? rect.h : rect.w;
    const usable = span - 44;
    const off = -usable / 2 + (usable / (Math.max(n, 2) - 1)) * i;
    switch (side) {
      case 'left': return { x: rect.x, y: rect.y + rect.h / 2 + off };
      case 'right': return { x: rect.x + rect.w, y: rect.y + rect.h / 2 + off };
      case 'top': return { x: rect.x + rect.w / 2 + off, y: rect.y };
      default: return { x: rect.x + rect.w / 2 + off, y: rect.y + rect.h };
    }
  }

  _nearestPin(rect, sides, targetPt) {
    const n = 6; let best = null;
    for (const side of sides) {
      for (let i = 0; i < n; i++) {
        const p = this._pin(side, i, n, rect);
        const d = Math.hypot(p.x - targetPt.x, p.y - targetPt.y);
        if (!best || d < best.d) best = { p, d, side, i };
      }
    }
    return best;
  }

  layout() {
    // prune traces of agents that have left — otherwise their wires linger forever
    for (const id of [...this.traces.keys()]) if (!this.agents.has(id)) this.traces.delete(id);
    const cx = this.W / 2, cy = this.H / 2;
    const hub = { x: cx - 82, y: cy - 62, w: 164, h: 124 };
    this.hubRect = hub;
    const list = [...this.agents.values()];
    const n = list.length;
    const rx = Math.min(this.W * 0.36, 560), ry = Math.min(this.H * 0.36, 360);
    list.forEach((a, i) => {
      const ang = (-90 + (360 / Math.max(n, 1)) * i) * Math.PI / 180;
      a.chipW = 148; a.chipH = 84;
      a.cx = cx + rx * Math.cos(ang);
      a.cy = cy + ry * Math.sin(ang) * (n === 1 ? 0 : 1) || cy;
      a.rect = { x: a.cx - a.chipW / 2, y: a.cy - a.chipH / 2, w: a.chipW, h: a.chipH };

      // trace geometry chip -> hub
      const dx = hub.x + hub.w / 2 - a.cx, dy = hub.y + hub.h / 2 - a.cy;
      const horiz = Math.abs(dx) >= Math.abs(dy);
      const chipSides = horiz ? (dx > 0 ? ['right'] : ['left']) : (dy > 0 ? ['bottom'] : ['top']);
      const hubSides = horiz ? (dx > 0 ? ['left'] : ['right']) : (dy > 0 ? ['top'] : ['bottom']);
      const probe = { x: hub.x + hub.w / 2, y: hub.y + hub.h / 2 };
      const cp = this._nearestPin(a.rect, chipSides, probe);
      const hp = this._nearestPin(hub, hubSides, { x: a.cx, y: a.cy });
      a.pinOut = cp; a.pinIn = hp;

      const mid = horiz ? (cp.p.x + hp.p.x) / 2 : (cp.p.y + hp.p.y) / 2;
      const raw = horiz
        ? [cp.p, { x: mid, y: cp.p.y }, { x: mid, y: hp.p.y }, hp.p]
        : [cp.p, { x: cp.p.x, y: mid }, { x: hp.p.x, y: mid }, hp.p];
      const pts = chamfer(raw, 9);
      const cum = [0];
      for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y));
      this.traces.set(a.id, { pts, cum, len: cum[cum.length - 1] });
    });
    this.drawStatic();
  }

  _pointAt(trace, dist) {
    const { pts, cum } = trace;
    for (let i = 1; i < cum.length; i++) {
      if (dist <= cum[i]) {
        const seg = cum[i] - cum[i - 1] || 1;
        const t = (dist - cum[i - 1]) / seg;
        return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t };
      }
    }
    return pts[pts.length - 1];
  }

  // ---------- events -> packets ----------
  handleEvent(ev) {
    this.activity = Math.min(1, this.activity + 0.25);
    const color = KIND_COLOR[ev.kind] || '#ffffff';
    const fromNode = this.agents.get(ev.from);

    if ((ev.kind === 'join' || ev.kind === 'spawn') && ev.agent) {
      const n = this.agents.get(ev.agent.id);
      if (n) this.flashes.push({ x: n.cx, y: n.cy, color: '#ffffff', t: 0, big: true });
      return;
    }
    if ((ev.kind === 'leave') && ev.id) {
      const n = this.agents.get(ev.id);
      if (n) this.flashes.push({ x: n.cx, y: n.cy, color: '#ff5470', t: 0, big: true });
      return;
    }
    if ((ev.kind === 'exit') && ev.agent) {
      const n = this.agents.get(ev.agent.id);
      if (n) this.flashes.push({ x: n.cx, y: n.cy, color: ev.status === 'done' ? '#58e88a' : '#ff5470', t: 0, big: true });
      return;
    }

    if (fromNode && ev.from !== 'hub') {
      this.touchAgent(ev.from);
      this._emit(fromNode.id, 1, color, 3.2);
      // fan-out propagation hub -> a few peers
      const others = [...this.agents.keys()].filter((id) => id !== ev.from);
      const fan = others.length > 6 ? 6 : others.length;
      for (let i = 0; i < fan; i++) {
        const peer = others[(i * 7 + ev.seq) % others.length];
        if (peer !== this.selected && this.packets.length > this.MAX_PACKETS * 0.7) continue; // shed load
        this._emit(peer, -1, color, 2.4);
      }
    }
    if (ev.kind === 'msg' && ev.to && ev.to !== '*') {
      const tgt = this.agents.get(ev.to);
      if (tgt) { this.touchAgent(ev.to); this._emit(ev.to, -1, '#4fd8ff', 4); }
    }
  }

  _emit(agentId, dir, color, speed) {
    const trace = this.traces.get(agentId);
    if (!trace || this.packets.length >= this.MAX_PACKETS) return;
    this.packets.push({ traceId: agentId, d: dir === 1 ? 0 : trace.len, dir, color, speed, size: 3.2 });
  }

  // ---------- rendering ----------
  drawStatic() {
    const g = this.b, W = this.W, H = this.H;
    g.clearRect(0, 0, W, H);
    // substrate gradient
    const grad = g.createRadialGradient(W / 2, H / 2, 60, W / 2, H / 2, Math.max(W, H) * 0.75);
    grad.addColorStop(0, '#0a1c12'); grad.addColorStop(1, '#05100a');
    g.fillStyle = grad; g.fillRect(0, 0, W, H);
    // dot grid
    g.fillStyle = 'rgba(46,110,72,.28)';
    for (let x = 13; x < W; x += 26) for (let y = 13; y < H; y += 26) g.fillRect(x, y, 1.2, 1.2);
    // silkscreen markings
    g.save();
    g.globalAlpha = 0.08; g.fillStyle = '#c9e5d2'; g.font = '700 64px Consolas, monospace';
    g.textAlign = 'right';
    g.fillText('ORCHESTRA', W - 24, H - 58);
    g.font = '600 14px Consolas, monospace';
    g.fillText('SYNC BUS · REV 1.0 · LOCALHOST FAB', W - 24, H - 38);
    g.textAlign = 'left';
    g.fillText('MOUNT', 18, 22);
    g.restore();
    // mounting holes
    g.strokeStyle = 'rgba(176,141,63,.35)';
    for (const [mx, my] of [[24, 24], [W - 24, 24], [24, H - 24], [W - 24, H - 24]]) {
      g.beginPath(); g.arc(mx, my, 7, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.arc(mx, my, 3, 0, Math.PI * 2); g.stroke();
    }
    // copper traces + vias
    for (const [, tr] of this.traces) {
      this._strokePath(g, tr.pts, 4, 'rgba(96,74,32,.9)');
      this._strokePath(g, tr.pts, 1.4, 'rgba(190,152,66,.55)');
      for (let i = 1; i < tr.pts.length - 1; i += 2) {
        const p = tr.pts[i];
        g.beginPath(); g.arc(p.x, p.y, 3, 0, Math.PI * 2);
        g.fillStyle = '#0a140c'; g.fill();
        g.strokeStyle = 'rgba(176,141,63,.7)'; g.lineWidth = 1.2; g.stroke();
      }
    }
  }

  _strokePath(g, pts, w, style) {
    g.beginPath();
    g.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
    g.strokeStyle = style; g.lineWidth = w; g.lineJoin = 'round'; g.lineCap = 'round';
    g.stroke();
  }

  tick(dt, t) {
    const g = this.f;
    g.clearRect(0, 0, this.W, this.H);
    this.activity *= Math.pow(0.994, dt);

    // ---- terminal wires (chip -> embedded terminal window) ----
    for (const [id, r] of this.termRects) {
      // fade out in sync with the closing terminal window
      let alpha = 1;
      if (r.dieAt !== undefined) {
        alpha = Math.max(0, 1 - (t - r.dieAt) / 650);
        if (alpha <= 0) { this.termRects.delete(id); continue; }
      }
      const a = this.agents.get(id);
      if (!a) { if (!alpha || alpha >= 1) this.termRects.delete(id); continue; }
      g.save();
      g.globalAlpha = alpha;
      const sx = a.cx, sy = a.cy + a.chipH / 2 + 5;
      const tx = r.x + r.w / 2, ty = r.y - 5;
      if (ty <= sy + 12) { // panel above the chip — route sideways
        var rawPts = [{ x: sx, y: sy }, { x: sx, y: sy + 14 }, { x: r.x - 10, y: sy + 14 }, { x: r.x - 10, y: r.y + r.h / 2 }, { x: r.x - 5, y: r.y + r.h / 2 }];
      } else {
        var rawPts = [{ x: sx, y: sy }, { x: sx, y: (sy + ty) / 2 }, { x: tx, y: (sy + ty) / 2 }, { x: tx, y: ty }];
      }
      const wpts = chamfer(rawPts, 7);
      this._strokePath(g, wpts, 4, 'rgba(96,74,32,.9)');
      this._strokePath(g, wpts, 1.4, 'rgba(190,152,66,.55)');
      // via at each bend
      for (let i = 1; i < wpts.length - 1; i++) {
        g.beginPath(); g.arc(wpts[i].x, wpts[i].y, 2.6, 0, Math.PI * 2);
        g.fillStyle = '#0a140c'; g.fill();
        g.strokeStyle = 'rgba(176,141,63,.7)'; g.lineWidth = 1; g.stroke();
      }
      // activity pulse traveling chip -> terminal
      const act = Math.max(0, 1 - (t - a.actT) / 2600);
      if (act > 0.02) {
        const cum = [0];
        for (let k = 1; k < wpts.length; k++) cum.push(cum[k - 1] + Math.hypot(wpts[k].x - wpts[k - 1].x, wpts[k].y - wpts[k - 1].y));
        const len = cum[cum.length - 1];
        const d = ((t / 4) % len);
        const p = this._pointAt({ pts: wpts, cum }, d);
        g.save();
        g.shadowColor = a.color; g.shadowBlur = 9;
        g.globalAlpha = act * alpha;
        g.beginPath(); g.arc(p.x, p.y, 3, 0, Math.PI * 2);
        g.fillStyle = a.color; g.fill();
        g.restore();
      }
      g.restore();
    }

    // ---- chips ----
    for (const [id, a] of this.agents) {
      const r = a.rect;
      const sel = id === this.selected, hov = id === this.hovered;
      // body
      g.beginPath(); this._rrect(g, r, 7);
      g.fillStyle = '#101f15'; g.fill();
      g.lineWidth = sel ? 2 : 1.2;
      g.strokeStyle = sel ? a.color : hov ? 'rgba(200,230,210,.8)' : 'rgba(80,150,105,.55)';
      if (sel || hov) { g.save(); g.shadowColor = a.color; g.shadowBlur = 14; g.stroke(); g.restore(); }
      else g.stroke();
      // notch (IC pin-1 marker)
      g.beginPath(); g.arc(r.x + 11, r.y + 11, 3, 0, Math.PI * 2);
      g.strokeStyle = 'rgba(201,229,210,.35)'; g.lineWidth = 1; g.stroke();
      // pins
      g.fillStyle = '#c9a227';
      for (const side of ['left', 'right']) {
        for (let i = 0; i < 6; i++) {
          const p = this._pin(side, i, 6, r);
          g.fillRect(p.x - 4, p.y - 1.8, 8, 3.6);
        }
      }
      // labels
      g.textAlign = 'center';
      g.fillStyle = '#d9efdf';
      g.font = '700 11px Consolas, monospace';
      const nm = (a.name || id).toUpperCase();
      g.fillText(nm.length > 15 ? nm.slice(0, 14) + '…' : nm, r.x + r.w / 2, r.y + r.h / 2 - 2);
      g.fillStyle = 'rgba(109,143,123,.9)';
      g.font = '9px Consolas, monospace';
      g.fillText(String(a.role || '').toUpperCase(), r.x + r.w / 2, r.y + r.h / 2 + 11);
      // activity bar
      const act = Math.max(0, 1 - (t - a.actT) / 4000);
      if (act > 0.02) {
        g.fillStyle = a.color;
        g.globalAlpha = act * 0.8;
        g.fillRect(r.x + 10, r.y + r.h - 7, (r.w - 20) * act, 2.4);
        g.globalAlpha = 1;
      }
      // LED
      const led = STATUS_LED[a.status] || STATUS_LED.idle;
      let alpha = 1;
      if (led[1] > 0) alpha = (Math.sin(t / 1000 * led[1] * Math.PI) + 1) / 2 * 0.75 + 0.25;
      g.save();
      g.shadowColor = led[0]; g.shadowBlur = 8;
      g.globalAlpha = alpha;
      g.beginPath(); g.arc(r.x + r.w - 13, r.y + 12, 3.6, 0, Math.PI * 2);
      g.fillStyle = led[0]; g.fill();
      g.restore();
    }

    // ---- hub ----
    const hub = this.hubRect;
    const pulse = 0.55 + this.activity * 0.45;
    g.beginPath(); this._rrect(g, hub, 10);
    g.fillStyle = '#13291b'; g.fill();
    g.save();
    g.shadowColor = '#58e88a'; g.shadowBlur = 18 * pulse;
    g.strokeStyle = `rgba(120,220,155,${0.45 + pulse * 0.4})`; g.lineWidth = 1.6; g.stroke();
    g.restore();
    g.fillStyle = '#c9a227';
    for (const side of ['left', 'right', 'top', 'bottom']) {
      for (let i = 0; i < 8; i++) {
        const p = this._pin(side, i, 8, hub);
        const horiz = side === 'left' || side === 'right';
        g.fillRect(horiz ? p.x - 4 : p.x - 1.8, horiz ? p.y - 1.8 : p.y - 4, horiz ? 8 : 3.6, horiz ? 3.6 : 8);
      }
    }
    g.textAlign = 'center';
    g.fillStyle = '#eafff2'; g.font = '700 15px Consolas, monospace';
    g.fillText('ORCHESTRA', hub.x + hub.w / 2, hub.y + hub.h / 2 - 8);
    g.fillStyle = 'rgba(109,143,123,.95)'; g.font = '9px Consolas, monospace';
    g.fillText('HUB · SYNC BUS MCU', hub.x + hub.w / 2, hub.y + hub.h / 2 + 8);
    // core LED breathing with activity
    g.save();
    g.shadowColor = '#58e88a'; g.shadowBlur = 10 + this.activity * 22;
    g.globalAlpha = 0.5 + pulse * 0.5;
    g.beginPath(); g.arc(hub.x + hub.w / 2, hub.y + hub.h / 2 + 24, 3.4, 0, Math.PI * 2);
    g.fillStyle = '#58e88a'; g.fill();
    g.restore();

    // ---- packets ----
    for (let i = this.packets.length - 1; i >= 0; i--) {
      const p = this.packets[i];
      const tr = this.traces.get(p.traceId);
      if (!tr) { this.packets.splice(i, 1); continue; }
      p.d += p.speed * dt * p.dir;
      if ((p.dir === 1 && p.d >= tr.len) || (p.dir === -1 && p.d <= 0)) {
        this.flashes.push({ x: this._pointAt(tr, p.dir === 1 ? tr.len : 0).x, y: this._pointAt(tr, p.dir === 1 ? tr.len : 0).y, color: p.color, t: 0 });
        this.packets.splice(i, 1);
        continue;
      }
      const pos = this._pointAt(tr, p.d);
      g.save();
      g.shadowColor = p.color; g.shadowBlur = 11;
      g.beginPath(); g.arc(pos.x, pos.y, p.size, 0, Math.PI * 2);
      g.fillStyle = p.color; g.fill();
      g.beginPath(); g.arc(pos.x, pos.y, p.size * 0.42, 0, Math.PI * 2);
      g.fillStyle = '#fff'; g.fill();
      g.restore();
    }

    // ---- flashes ----
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const fl = this.flashes[i];
      fl.t += dt;
      const k = fl.t / (fl.big ? 650 : 380);
      if (k >= 1) { this.flashes.splice(i, 1); continue; }
      g.save();
      g.globalAlpha = (1 - k) * 0.9;
      g.strokeStyle = fl.color; g.lineWidth = fl.big ? 2 : 1.4;
      g.shadowColor = fl.color; g.shadowBlur = 10;
      g.beginPath(); g.arc(fl.x, fl.y, 4 + k * (fl.big ? 42 : 18), 0, Math.PI * 2);
      g.stroke();
      g.restore();
    }
  }

  _rrect(g, r, rad) {
    g.moveTo(r.x + rad, r.y);
    g.arcTo(r.x + r.w, r.y, r.x + r.w, r.y + r.h, rad);
    g.arcTo(r.x + r.w, r.y + r.h, r.x, r.y + r.h, rad);
    g.arcTo(r.x, r.y + r.h, r.x, r.y, rad);
    g.arcTo(r.x, r.y, r.x + r.w, r.y, rad);
    g.closePath();
  }

  _hit(x, y) {
    for (const [, a] of this.agents) {
      const r = a.rect;
      if (x >= r.x - 4 && x <= r.x + r.w + 4 && y >= r.y - 4 && y <= r.y + r.h + 4) return a;
    }
    return null;
  }

  _pick(x, y) {
    const hit = this._hit(x, y);
    const id = hit ? hit.id : null;
    if (id !== this.hovered) {
      this.hovered = id;
      this.fx.style.cursor = id ? 'pointer' : 'crosshair';
    }
    this.onHover?.(hit, x, y);
  }
}
