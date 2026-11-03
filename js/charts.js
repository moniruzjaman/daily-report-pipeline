/* charts.js — dependency-free canvas charts for the dashboard.
 * drawGroupedBars: sections × series comparison (target/achievement).
 * drawDiverging : zero-centered horizontal bars (variances, % deltas).
 * Both are DPR-aware, redraw on container resize (ResizeObserver) and
 * share one hover tooltip. Pure canvas — works offline, nothing to load. */

let tipEl = null;
function tipShow(html, x, y) {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'chart-tip';
    document.body.appendChild(tipEl);
  }
  tipEl.innerHTML = html;
  tipEl.style.opacity = '1';
  const w = tipEl.offsetWidth || 180;
  tipEl.style.left = Math.min(x + 14, window.innerWidth - w - 10) + 'px';
  tipEl.style.top = Math.min(y + 14, window.innerHeight - 90) + 'px';
}
function tipHide() { if (tipEl) tipEl.style.opacity = '0'; }

function prep(canvas) {
  const box = canvas.parentElement;
  const w = box.clientWidth, h = box.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, w * dpr);
  canvas.height = Math.max(1, h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function niceMax(v) {
  if (!v) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (v <= m * base) return m * base;
  }
  return 10 * base;
}
function fmtAxis(v) {
  if (Math.abs(v) >= 100000) return (v / 1000).toLocaleString('en-US', { maximumFractionDigits: 0 }) + 'k';
  if (Math.abs(v) >= 1000) return (v / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 }) + 'k';
  return String(Math.round(v));
}
function fmtFull(v) { return Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 }); }

function watch(canvas, draw) {
  canvas._redraw = draw;
  if (canvas._ro) canvas._ro.disconnect();
  canvas._ro = new ResizeObserver(() => draw());
  canvas._ro.observe(canvas.parentElement);
}

const FONT = '11px "Noto Sans Bengali", "Hind Siliguri", Arial, sans-serif';

/* ------------------------------------------------------------------ */
/* Grouped vertical bars                                              */
/* ------------------------------------------------------------------ */

/** opts: { groups:[{label, row?, values:[…per series]}], series:[{name,color}],
 *          legendEl?, onClick?(group, gi) } */
export function drawGroupedBars(canvas, opts) {
  canvas._opts = opts;
  const draw = () => paintGrouped(canvas);
  watch(canvas, draw);
  draw();
}

function paintGrouped(canvas) {
  const opts = canvas._opts;
  const { ctx, w, h } = prep(canvas);
  const { groups, series } = opts;
  const M = { l: 52, r: 10, t: 12, b: 30 };
  const iw = w - M.l - M.r, ih = h - M.t - M.b;

  // legend
  if (opts.legendEl) {
    opts.legendEl.innerHTML = series
      .map((s) => `<span class="lg-item"><span class="sw" style="background:${s.color}"></span>${s.name}</span>`)
      .join('');
  }

  const maxV = niceMax(Math.max(1, ...groups.flatMap((g) => g.values.filter((v) => v != null))));
  const hi = canvas._hi || {};

  // y grid + ticks
  ctx.font = FONT;
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#8b979d';
  const ticks = 5;
  for (let i = 0; i <= ticks; i++) {
    const v = (maxV / ticks) * i;
    const y = M.t + ih - (v / maxV) * ih;
    ctx.strokeStyle = i === 0 ? '#d8d2c2' : '#eee9db';
    ctx.beginPath(); ctx.moveTo(M.l, y); ctx.lineTo(w - M.r, y); ctx.stroke();
    ctx.fillText(fmtAxis(v), M.l - 6, y);
  }

  const gw = iw / Math.max(1, groups.length);
  const bw = Math.min((gw * 0.72) / Math.max(1, series.length), 36);
  groups.forEach((g, gi) => {
    const gx = M.l + gi * gw;
    const x0 = gx + (gw - bw * series.length) / 2;
    series.forEach((s, si) => {
      const v = g.values[si];
      if (v == null) return;
      const bh = (v / maxV) * ih;
      const x = x0 + si * bw;
      const y = M.t + ih - bh;
      const dim = hi.gi != null && hi.gi !== gi;
      ctx.globalAlpha = dim ? 0.35 : 1;
      ctx.fillStyle = s.color;
      ctx.fillRect(x + 1, y, bw - 2, bh);
      if (hi.gi === gi && hi.si === si) {
        ctx.strokeStyle = '#22333b'; ctx.lineWidth = 1.5;
        ctx.strokeRect(x + 1, y, bw - 2, bh);
      }
      ctx.globalAlpha = 1;
    });
    // x label
    ctx.fillStyle = hi.gi === gi ? '#16323f' : '#5c6a71';
    ctx.font = `600 ${FONT}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const label = g.label.length > 13 ? g.label.slice(0, 12) + '…' : g.label;
    ctx.fillText(label, gx + gw / 2, M.t + ih + 8);
    ctx.font = FONT;
  });

  // hover hit-testing
  canvas.onmousemove = (e) => {
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (x < M.l || y < M.t || y > h - M.b) { canvas._hi = null; tipHide(); paintGrouped(canvas); return; }
    const gi = Math.floor((x - M.l) / gw);
    if (gi < 0 || gi >= groups.length) return;
    const gx = M.l + gi * gw;
    const x0 = gx + (gw - bw * series.length) / 2;
    let si = Math.floor((x - x0) / bw);
    if (si < 0 || si >= series.length) si = null;
    const changed = JSON.stringify(canvas._hi) !== JSON.stringify({ gi, si });
    canvas._hi = { gi, si };
    if (changed) paintGrouped(canvas);
    const v = si != null ? groups[gi].values[si] : null;
    tipShow(
      `<b>${groups[gi].label}</b>${si != null && v != null
        ? `<br>${series[si].name}: <b>${fmtFull(v)}</b>`
        : '<br>সারিতে জাম্প করতে ক্লিক করুন'}`,
      e.clientX, e.clientY
    );
  };
  canvas.onmouseleave = () => { canvas._hi = null; tipHide(); paintGrouped(canvas); };
  canvas.onclick = () => {
    if (canvas._hi && opts.onClick) opts.onClick(groups[canvas._hi.gi], canvas._hi.gi);
  };
}

/* ------------------------------------------------------------------ */
/* Diverging horizontal bars (zero-centered)                          */
/* ------------------------------------------------------------------ */

/** opts: { items:[{label, value, detail?, sev?, row?, clipped?}], cap?, onClick?(item) } */
export function drawDiverging(canvas, opts) {
  canvas._opts = opts;
  const draw = () => paintDiverging(canvas);
  watch(canvas, draw);
  draw();
}

function paintDiverging(canvas) {
  const opts = canvas._opts;
  const { ctx, w, h } = prep(canvas);
  const items = opts.items || [];
  const n = items.length;
  if (!n) return;
  const M = { l: 8, r: 8, t: 10, b: 8 };
  const labelW = Math.min(170, w * 0.32);
  const valW = 66;
  const barL = M.l + labelW, barR = w - M.r - valW;
  const barW = barR - barL;
  const rowH = Math.min(30, (h - M.t - M.b) / n);
  const cap = opts.cap || null;

  // zero line
  const zx = barL + barW / 2;
  const maxAbs = Math.max(...items.map((it) => Math.min(Math.abs(it.value), cap || Infinity)), 1e-9);
  const half = barW / 2 - 6;

  items.forEach((it, i) => {
    const y = M.t + i * rowH + rowH / 2;
    const bh = Math.min(14, rowH - 7);
    let frac = Math.abs(it.value) / (cap || maxAbs);
    const clipped = cap != null && Math.abs(it.value) > cap;
    frac = Math.min(1, frac);
    const len = frac * half;
    const color = it.color || (it.value >= 0 ? '#2e6a80' : '#c8871e');
    const hover = canvas._hi === i;

    // label
    ctx.font = `600 ${FONT}`; ctx.textBaseline = 'middle';
    ctx.fillStyle = hover ? '#16323f' : '#4a5a61';
    ctx.textAlign = 'left';
    let lb = it.label;
    while (lb.length > 4 && ctx.measureText(lb).width > labelW - 10) lb = lb.slice(0, -2);
    if (lb !== it.label) lb += '…';
    ctx.fillText(lb, M.l, y);

    // bar
    ctx.fillStyle = color;
    ctx.globalAlpha = hover ? 1 : 0.88;
    if (it.value >= 0) ctx.fillRect(zx, y - bh / 2, len, bh);
    else ctx.fillRect(zx - len, y - bh / 2, len, bh);
    ctx.globalAlpha = 1;
    if (clipped) {
      ctx.fillStyle = color;
      ctx.textAlign = it.value >= 0 ? 'left' : 'right';
      ctx.fillText('▸', it.value >= 0 ? zx + len + 2 : zx - len - 8, y);
    }
    if (hover) { ctx.strokeStyle = '#22333b'; ctx.lineWidth = 1.2; ctx.strokeRect(it.value >= 0 ? zx : zx - len, y - bh / 2, Math.max(2, len), bh); }

    // value — outside the bar when there is room, white inside the bar otherwise,
    // so near-cap values never collide with the label column
    const vs = fmtFull(it.value);
    ctx.font = `700 ${FONT}`;
    const tw = ctx.measureText(vs).width;
    let tx, align, inside = false;
    if (it.value >= 0) {
      tx = zx + len + 4; align = 'left';
      if (tx + tw > w - M.r) { tx = zx + len - 6; align = 'right'; inside = true; }
    } else {
      tx = zx - len - 4; align = 'right';
      if (tx - tw < barL + 6) { tx = zx - len + 6; align = 'left'; inside = true; }
    }
    ctx.fillStyle = inside ? '#fff' : (hover ? '#16323f' : color);
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillText(vs, tx, y);
  });

  // zero axis
  ctx.strokeStyle = '#c9c2b0'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(zx, M.t - 2); ctx.lineTo(zx, h - M.b + 2); ctx.stroke();

  canvas.onmousemove = (e) => {
    const r = canvas.getBoundingClientRect();
    const i = Math.floor((e.clientY - r.top - M.t) / rowH);
    if (i < 0 || i >= n) { canvas._hi = null; tipHide(); paintDiverging(canvas); return; }
    const changed = canvas._hi !== i;
    canvas._hi = i;
    if (changed) paintDiverging(canvas);
    const it = items[i];
    tipShow(`<b>${it.label}</b><br>${it.detail || ''}`, e.clientX, e.clientY);
  };
  canvas.onmouseleave = () => { canvas._hi = null; tipHide(); paintDiverging(canvas); };
  canvas.onclick = () => {
    if (canvas._hi != null && opts.onClick) opts.onClick(items[canvas._hi]);
  };
}

/* ------------------------------------------------------------------ */
/* Score ring (SVG string helper for the verdict banner)              */
/* ------------------------------------------------------------------ */

export function scoreRing(score, cls) {
  const R = 30, C = 2 * Math.PI * R;
  const len = (Math.max(0, Math.min(100, score)) / 100) * C;
  const color = cls === 'bad' ? 'var(--red)' : cls === 'warn' ? 'var(--amber)' : 'var(--green)';
  return `<svg viewBox="0 0 80 80" width="74" height="74" class="score-ring" role="img" aria-label="health score ${score}">
    <circle cx="40" cy="40" r="${R}" fill="none" stroke="rgba(245,241,232,.22)" stroke-width="9"></circle>
    <circle cx="40" cy="40" r="${R}" fill="none" stroke="${color}" stroke-width="9" stroke-linecap="round"
      stroke-dasharray="${len} ${C - len}" transform="rotate(-90 40 40)"></circle>
    <text x="40" y="44" text-anchor="middle" font-size="19" font-weight="800" fill="#f5f1e8">${score}</text>
  </svg>`;
}
