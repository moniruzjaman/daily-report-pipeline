/* insights.js — turns grid + validation result into
 *  1. a verdict (health score, banner copy),
 *  2. ranked, human-readable insight cards with jump-to-row targets,
 *  3. shaped datasets for the dashboard charts (section comparison,
 *     printed-total variances, year-over-year deltas).
 * All rules are header-keyword driven so any `label + numbers` grid works. */

const colHeader = (grid, i) => (grid.headers[i + 1] || '').toLowerCase();

function findCols(grid) {
  const cols = { lastTarget: -1, lastAch: -1, curTarget: -1, curAch: -1, pct: -1 };
  for (let i = 0; i < grid.nCols; i++) {
    const h = colHeader(grid, i);
    const isT = /লক্ষ্য|target/.test(h);
    const isA = /অর্জন|achiev/.test(h);
    const isLast = /গত|last|previous|পূর্ব/.test(h);
    if (isT) { if (isLast) cols.lastTarget = i; else cols.curTarget = i; }
    else if (isA) { if (isLast) cols.lastAch = i; else cols.curAch = i; }
    else if (/%|শতকরা|percent|pct/.test(h)) cols.pct = i;
  }
  return cols;
}

function sectionOf(grid, r) {
  for (let i = Math.min(r - 1, grid.rows.length - 2); i >= 0; i--) {
    if (grid.rows[i].sectionBefore) return grid.rows[i].sectionBefore;
    if (grid.rows[i].isTotal) return ''; // standalone run after a মোট row — no section heading
  }
  return '';
}
function shortSection(s) { return (s || '').replace(/\s*\([^)]*\)\s*/g, '').trim() || 'অন্যান্য'; }
function shortCol(grid, c) {
  const h = grid.headers[c + 1] || '';
  const cur = /চলতি|current/.test(h);
  if (/লক্ষ্য|target/.test(h)) return cur ? 'চলতি লক্ষ্য' : 'গত লক্ষ্য';
  if (/অর্জন|achiev/.test(h)) return cur ? 'চলতি অর্জন' : 'গত অর্জন';
  return h.length > 14 ? h.slice(0, 13) + '…' : h;
}
const fmt = (v) => Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
const fmtPct = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`;

/* ------------------------- chart datasets ------------------------- */

/** Section-level comparison: one group per section (using its মোট row,
 *  or the sum of data rows when no total row exists). */
/** Clean a মোট-row label into a group name: 'আলু সর্বমোট' → 'আলু'. */
function totalLabelName(raw) {
  return (raw || '').replace(/(উপমোট|সর্বমোট|যোগফল|মোট|total|subtotal)/gi, '').trim();
}

export function sectionSeries(grid) {
  const cols = findCols(grid);
  // runs of rows per section, like validate.js
  const runs = [];
  let cur = [];
  grid.rows.forEach((row, r) => {
    if (row.sectionBefore && cur.length) { runs.push(cur); cur = []; }
    cur.push({ row, r });
    if (row.isTotal) { runs.push(cur); cur = []; }
  });
  if (cur.length) runs.push(cur);

  let seriesIdx, seriesNames;
  if (cols.lastTarget >= 0 || cols.curTarget >= 0 || cols.curAch >= 0) {
    seriesIdx = [cols.lastTarget, cols.lastAch, cols.curTarget, cols.curAch];
    seriesNames = ['গত বছর লক্ষ্য', 'গত বছর অর্জন', 'চলতি বছর লক্ষ্য', 'চলতি বছর অর্জন'];
  } else {
    seriesIdx = [0, 1, 2, 3];
    seriesNames = seriesIdx.map((i) => grid.headers[i + 1] || `কলাম ${i + 1}`);
  }
  const colors = ['#9aa6ab', '#2e6a80', '#c8871e', '#3f7d4e'];
  const series = seriesIdx
    .map((ci, si) => ({ name: seriesNames[si], color: colors[si], ci }))
    .filter((s) => s.ci >= 0);

  const groups = [];
  for (const run of runs) {
    const totalEntry = run[run.length - 1].row.isTotal ? run[run.length - 1] : null;
    // sectioned runs take the section heading; standalone sub-tables take the
    // cleaned মোট-row label (শিমলা মরিচ উপমোট → শিমলা মরিচ, আলু সর্বমোট → আলু)
    let name = totalEntry
      ? (run[0].row.sectionBefore ? shortSection(run[0].row.sectionBefore) : totalLabelName(totalEntry.row.label))
      : shortSection(run[0].row.sectionBefore || run[0].row.label);
    name = name || 'অন্যান্য';
    const values = series.map((s) => {
      if (totalEntry) return totalEntry.row.cells[s.ci]?.val ?? null;
      const vals = run.map(({ row }) => row.cells[s.ci]?.val).filter((v) => v != null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
    });
    if (values.every((v) => v == null)) continue;
    groups.push({ label: name, values, row: totalEntry ? totalEntry.r : run[0].r });
  }
  return { groups, series: series.map(({ name, color }) => ({ name, color })) };
}

/** Printed-total variances from failed যোগফল checks (needs issue.data). */
export function varianceItems(grid, result) {
  const items = [];
  for (const i of result.issues) {
    if (i.sev !== 'fail' || !i.data || i.data.sum == null) continue;
    const d = i.data;
    // variance rows are always মোট rows — name the group from the row itself
    const base = totalLabelName(grid.rows[d.row]?.label);
    const name = base || shortSection(sectionOf(grid, d.row));
    items.push({
      label: `${name} · ${shortCol(grid, d.col)}`,
      value: Math.round((d.sum - d.printed) * 100) / 100,
      detail: `সারি-যোগ ${fmt(d.sum)} বনাম মুদ্রিত ${fmt(d.printed)} — «${grid.rows[d.row]?.label}» · ${grid.headers[d.col + 1]}`,
      sev: 'fail',
      row: d.row,
      color: 'var(--red)',
    });
  }
  return items;
}

/** Year-over-year delta per crop: (চলতি লক্ষ্য − গত অর্জন) / গত অর্জন. */
export function deltaItems(grid) {
  const cols = findCols(grid);
  if (cols.lastAch < 0 || cols.curTarget < 0) return [];
  const items = [];
  grid.rows.forEach((row, r) => {
    if (row.isTotal) return;
    const a = row.cells[cols.lastAch]?.val;
    const t = row.cells[cols.curTarget]?.val;
    if (!a || t == null || a === 0) return;
    const pct = ((t - a) / a) * 100;
    const sec = shortSection(sectionOf(grid, r));
    items.push({
      label: (sec ? `${sec} ` : '') + row.label,
      value: Math.round(pct * 10) / 10,
      detail: `চলতি লক্ষ্য ${fmt(t)} বনাম গত অর্জন ${fmt(a)}`,
      row: r,
      color: pct >= 0 ? '#2e6a80' : '#c8871e',
    });
  });
  items.sort((x, y) => y.value - x.value);
  return items;
}

/* ------------------------- verdict + insights ------------------------- */

export function buildVerdict(result) {
  const { tally, checksRun, passRate } = result;
  const score = checksRun ? Math.round(((tally.pass + tally.warn * 0.5) / checksRun) * 100) : 0;
  const cls = tally.fail ? 'bad' : tally.warn ? 'warn' : 'good';
  const title = tally.fail
    ? `${tally.fail}টি অসঙ্গতি ধরা পড়েছে`
    : tally.warn
      ? `${tally.warn}টি সন্দেহজনক সংখ্যা আছে`
      : 'সব যাচাই পাস ✓';
  const sub = `${checksRun}টি নিয়ম চেক করা হয়েছে — পাস-হার ${passRate}%`;
  return { score, cls, title, sub };
}

const SEV_LABEL = { fail: 'গুরুতর', warn: 'সন্দেহ', info: 'তথ্য', good: 'ভালো' };
const SEV_ICON = { fail: '✗', warn: '!', info: 'i', good: '✓' };

export function buildInsights(grid, result) {
  const out = [];
  const cols = findCols(grid);

  // 1. printed-total variances (the report's real findings), most extreme first
  const variances = varianceItems(grid, result)
    .map((v) => ({ v, mag: Math.abs(v.value) }))
    .sort((a, b) => b.mag - a.mag);
  for (const { v } of variances.slice(0, 4)) {
    const pct = v.value === 0 ? '' : ` (${(v.value > 0 ? '+' : '−') + Math.abs(v.value).toLocaleString('en-US')})`;
    out.push({
      sev: 'fail',
      title: `«${v.label}» মোট মেলেনি${pct}`,
      body: `${v.detail}. সম্ভবত টাইপো বা পুরোনো সারি-ম্যাপ — মুদ্রিত সংখ্যাটি মূল নথিতে মিলিয়ে নিন।`,
      row: v.row,
    });
  }

  // 2. extreme target-vs-last-year deltas (possible wrong column values)
  const deltas = deltaItems(grid).filter((d) => Math.abs(d.value) >= 40);
  for (const d of deltas.slice(0, 3)) {
    out.push({
      sev: 'warn',
      title: `${d.label}: চলতি লক্ষ্য গত অর্জনের ${fmtPct(d.value)}`,
      body: `${d.detail}. এত বড় ফারাক স্বাভাবিক নয় — হয় লক্ষ্য-কলামে ভুল সংখ্যা, নয়তো একক/স্কেল গোলমাল।`,
      row: d.row,
    });
  }

  // 2b. same-year target vs achievement blowups (e.g. বোরো গত-লক্ষ্য ৬,৫৩০
  // vs গত-অর্জন ৫৫০) — the kind of in-row contradiction a printed table hides
  const pairs = [];
  if (cols.lastTarget >= 0 && cols.lastAch >= 0) pairs.push([cols.lastTarget, cols.lastAch, 'গত বছর']);
  if (cols.curTarget >= 0 && cols.curAch >= 0) pairs.push([cols.curTarget, cols.curAch, 'চলতি বছর']);
  const blowups = [];
  grid.rows.forEach((row, r) => {
    if (row.isTotal) return;
    for (const [tc, ac, yr] of pairs) {
      const t = row.cells[tc]?.val;
      const a = row.cells[ac]?.val;
      if (!t || !a || a === 0) continue;
      const pct = ((t - a) / a) * 100;
      if (Math.abs(pct) >= 100) {
        const sec = shortSection(sectionOf(grid, r));
        blowups.push({ row: r, label: (sec ? `${sec} ` : '') + row.label, t, a, pct, yr });
      }
    }
  });
  blowups.sort((x, y) => Math.abs(y.pct) - Math.abs(x.pct));
  for (const b of blowups.slice(0, 2)) {
    out.push({
      sev: 'warn',
      title: `${b.label}: ${b.yr}ের লক্ষ্য ${fmt(b.t)} কিন্তু অর্জন মাত্র ${fmt(b.a)}`,
      body: `একই বছরের লক্ষ্য-অর্জন জোড়ার মধ্যে ${fmtPct(b.pct)} ফারাক — হয় লক্ষ্য-ঘরে ভুল সংখ্যা, নয়তো অর্জন-ঘর অসম্পূর্ণ। দুটি ঘরই মূল নথির সাথে মিলিয়ে নিন।`,
      row: b.row,
    });
  }

  // 3. column fill — which figure the return does NOT report everywhere
  const lowCols = [];
  for (let c = 0; c < grid.nCols; c++) {
    const filled = grid.rows.filter((r) => r.cells[c].val != null).length;
    const pctv = grid.rows.length ? Math.round((filled / grid.rows.length) * 100) : 100;
    if (pctv < 95) lowCols.push(`${grid.headers[c + 1]} — মাত্র ${pctv}% পূর্ণ (${filled}/${grid.rows.length} সারি)`);
  }
  if (lowCols.length) {
    out.push({
      sev: 'info',
      title: 'কিছু কলাম আংশিকভাবে রিপোর্ট করা হয়েছে',
      body: `${lowCols.join(' · ')}। বাকি ঘরে “−” আছে — এটি ফাইলের কাঠামো, নাকি উপাত্ত অনুপস্থিত, যাচাই করুন।`,
    });
  }

  // 4. big movers worth knowing (informational)
  const movers = deltaItems(grid).filter((d) => Math.abs(d.value) >= 10 && Math.abs(d.value) < 40);
  if (movers.length) {
    const d = movers[0];
    out.push({
      sev: 'good',
      title: `${d.label}: চলতি লক্ষ্য গত অর্জনের চেয়ে ${fmtPct(d.value)}`,
      body: `${d.detail}. এই ফসলে লক্ষ্য-সমন্বয় উল্লেখযোগ্য — অর্জন-হার নজরে রাখুন।`,
      row: d.row,
    });
  }

  // 5. all-clear card
  if (result.tally.fail === 0 && out.every((o) => o.sev !== 'fail')) {
    out.unshift({
      sev: 'good',
      title: 'সব মোট-সারি সারি-যোগের সাথে মিলেছে ✓',
      body: `${result.checksRun}টি গাণিতিক যাচাই চালানো হয়েছে — কোনো ব্যবধান পাওয়া যায়নি।`,
    });
  }

  // de-duplicate rows and cap
  const seen = new Set();
  return out
    .filter((o) => { const k = o.title; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 8)
    .map((o) => ({ ...o, sevLabel: SEV_LABEL[o.sev], icon: SEV_ICON[o.sev] }));
}

export function renderInsights(el, insights) {
  el.innerHTML = insights.map((o, idx) => `
    <article class="insight ${o.sev}">
      <div class="ins-head">
        <span class="ins-ico">${o.icon}</span>
        <h4>${o.title}</h4>
        <span class="sev ${o.sev === 'good' ? 'pass' : o.sev}">${o.sevLabel}</span>
      </div>
      <p>${o.body}</p>
      ${o.row != null ? `<button class="ins-jump" data-r="${o.row}">গ্রিডের সারিতে দেখুন →</button>` : ''}
    </article>`).join('');
}
