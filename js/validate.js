/* validate.js — rules engine for daily-return grids.
 * Generic checks: printed totals vs row/column sums (section-scoped),
 * target-achievement %, yield consistency (area × yield ≈ production),
 * fertilizer stock math, and sanity checks (negatives, duplicate labels).
 *
 * Daily returns stack several sub-tables (per crop group, each ending in a
 * মোট row) in one grid, so every total is checked only against the data rows
 * accumulated since the previous total row / section marker. */

const TOL_ABS = 1.0;

function relDiff(calc, printed) {
  const base = Math.max(Math.abs(printed), Math.abs(calc), 1);
  return Math.abs(calc - printed) / base;
}

function fmt(v) {
  if (v == null) return '—';
  const n = Number(v);
  const sign = n < 0 ? '−' : '';
  return sign + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

const colHeader = (grid, i) => (grid.headers[i + 1] || '').toLowerCase();

function findCol(grid, patterns) {
  for (let i = 0; i < grid.nCols; i++) {
    const h = colHeader(grid, i);
    if (patterns.some((p) => h.includes(p))) return i;
  }
  return -1;
}

/** Split ordered rows into section runs: [ {firstRow, rows:[{row, r}]}, ... ] */
function sectionRuns(grid) {
  const runs = [];
  let current = [];
  grid.rows.forEach((row, r) => {
    if (row.sectionBefore && current.length) { runs.push(current); current = []; }
    current.push({ row, r });
    if (row.isTotal) { runs.push(current); current = []; }
  });
  if (current.length) runs.push(current);
  return runs;
}

export function validateGrid(grid) {
  const issues = [];
  const add = (issue) => issues.push(issue);
  const flag = (r, c, sev) => { grid.rows[r].cells[c].flag = sev; };
  const runs = sectionRuns(grid);

  /* --- Rule 1: printed total row vs sums of its section's data rows --- */
  const yieldRe = /(গড়ফলন|yield|pct|percent|%)/;
  for (const run of runs) {
    const last = run[run.length - 1];
    if (!last.row.isTotal) continue;
    const dataRows = run.slice(0, -1);
    if (dataRows.length < 2) continue;
    for (let c = 0; c < grid.nCols; c++) {
      if (yieldRe.test(colHeader(grid, c))) continue; // averages are not additive
      const printed = last.row.cells[c].val;
      if (printed == null) continue;
      const vals = dataRows.map(({ row }) => row.cells[c].val).filter((v) => v != null);
      if (vals.length < 2) continue;
      const sum = vals.reduce((a, b) => a + b, 0);
      const tol = Math.max(TOL_ABS, Math.abs(printed) * 0.002);
      const ok = Math.abs(sum - printed) <= tol;
      add({
        rule: 'যোগফল (Total row)',
        sev: ok ? 'pass' : 'fail',
        where: `«${last.row.label}» · ${grid.headers[c + 1]}`,
        detail: `সারি-যোগ ${fmt(sum)} বনাম মুদ্রিত ${fmt(printed)} — ${ok ? 'সামঞ্জস্য ✓' : `ব্যবধান ${fmt(sum - printed)} ✗`}`,
        cells: ok ? [] : [[last.r, c]],
      });
      if (!ok) flag(last.r, c, 'fail');
    }
  }

  /* --- Rule 2: in-row additive total column (মোট/total, but NOT মোট উৎপাদন) --- */
  const yieldColGlobal = findCol(grid, ['গড়ফলন', 'yield']);
  const totalCols = [];
  for (let c = 0; c < grid.nCols; c++) {
    const h = colHeader(grid, c);
    if (/(মোট|total|যোগফল)/.test(h) && !/(উৎপাদন|prod|গড়ফলন|yield|pct|percent|%)/.test(h)) totalCols.push(c);
  }
  if (totalCols.length) {
    for (const { row, r } of grid.rows.map((row, r) => ({ row, r }))) {
      for (const c of totalCols) {
        const printed = row.cells[c].val;
        if (printed == null) continue;
        const filtered = row.cells
          .filter((cell, i) => i !== c && i !== yieldColGlobal && cell.val != null)
          .map((cell) => cell.val);
        if (filtered.length < 2) continue;
        const sum = filtered.reduce((a, b) => a + b, 0);
        const tol = Math.max(TOL_ABS, Math.abs(printed) * 0.002);
        const ok = Math.abs(sum - printed) <= tol;
        add({
          rule: 'সারি-যোগফল (Row total column)',
          sev: ok ? 'pass' : 'fail',
          where: `«${row.label}» · ${grid.headers[c + 1]}`,
          detail: `উপাদান-যোগ ${fmt(sum)} বনাম মুদ্রিত ${fmt(printed)} — ${ok ? 'সামঞ্জস্য ✓' : `ব্যবধান ${fmt(sum - printed)} ✗`}`,
          cells: ok ? [] : [[r, c]],
        });
        if (!ok) flag(r, c, 'fail');
      }
    }
  }

  /* --- Rule 3: yield consistency  area × yield ≈ production --- */
  const yieldCol = yieldColGlobal;
  const prodCol = findCol(grid, ['উৎপাদন', 'prod']);
  if (yieldCol >= 0 && prodCol >= 0 && yieldCol !== prodCol) {
    let areaCol = findCol(grid, ['অর্জন', 'achiev', 'জমি', 'area']);
    if (areaCol < 0) areaCol = findCol(grid, ['লক্ষ্য', 'target']);
    if (areaCol >= 0 && areaCol !== yieldCol && areaCol !== prodCol) {
      for (const { row, r } of grid.rows.map((row, r) => ({ row, r }))) {
        if (row.isTotal) continue;
        const a = row.cells[areaCol]?.val, y = row.cells[yieldCol]?.val, p = row.cells[prodCol]?.val;
        if (!a || !y || !p) continue;
        const calc = a * y;
        const d = relDiff(calc, p);
        const sev = d <= 0.05 ? 'pass' : d <= 0.08 ? 'warn' : 'fail';
        add({
          rule: 'ফলন-সামঞ্জস্য (Area×Yield vs Production)',
          sev,
          where: `«${row.label}»`,
          detail: `${fmt(a)} × ${fmt(y)} = ${fmt(calc)} বনাম মুদ্রিত ${fmt(p)} — পার্থক্য ${(d * 100).toFixed(1)}%`,
          cells: sev === 'pass' ? [] : [[r, prodCol]],
        });
        if (sev !== 'pass') flag(r, prodCol, sev);
      }
    }
  }

  /* --- Rule 4: target-achievement percentage --- */
  const pctCol = findCol(grid, ['%', 'শতকরা', 'pct', 'percent']);
  const tgtCol = findCol(grid, ['লক্ষ্য', 'target']);
  const achCol = findCol(grid, ['অর্জন', 'achiev', 'ach']);
  if (pctCol >= 0 && tgtCol >= 0 && achCol >= 0) {
    for (const { row, r } of grid.rows.map((row, r) => ({ row, r }))) {
      if (row.isTotal) continue;
      const t = row.cells[tgtCol]?.val, a = row.cells[achCol]?.val, p = row.cells[pctCol]?.val;
      if (!t || !a || p == null) continue;
      const calc = (a / t) * 100;
      const d = Math.abs(calc - p);
      const ok = d <= 1.0;
      add({
        rule: 'লক্ষ্য-অর্জন %',
        sev: ok ? 'pass' : 'warn',
        where: `«${row.label}» · ${grid.headers[pctCol + 1]}`,
        detail: `গণনা ${calc.toFixed(1)}% বনাম মুদ্রিত ${fmt(p)}%`,
        cells: ok ? [] : [[r, pctCol]],
      });
      if (!ok) flag(r, pctCol, 'warn');
    }
  }

  /* --- Rule 5: stock math  opening + receipts − sales = closing --- */
  const openCol = findCol(grid, ['প্রারম্ভিক', 'opening', 'সমাগম']);
  const recvCol = findCol(grid, ['প্রাপ্তি', 'receipt', 'আমদানি']);
  const saleCol = findCol(grid, ['বিক্রয়', 'sale', 'বণ্টন', 'lifting', 'ব্যবহার', 'use']);
  const closeCol = findCol(grid, ['মজুদ', 'closing', 'অবশিষ্ট', 'stock']);
  if ([openCol, saleCol, closeCol].every((c) => c >= 0)) {
    for (const { row, r } of grid.rows.map((row, r) => ({ row, r }))) {
      if (row.isTotal) continue;
      const o = row.cells[openCol]?.val ?? 0;
      const rc = recvCol >= 0 ? (row.cells[recvCol]?.val ?? 0) : 0;
      const s = row.cells[saleCol]?.val;
      const cl = row.cells[closeCol]?.val;
      if (s == null || cl == null) continue;
      const calc = o + rc - s;
      const ok = Math.abs(calc - cl) <= TOL_ABS;
      add({
        rule: 'মজুদ হিসাব (Opening+Receipts−Sales=Closing)',
        sev: ok ? 'pass' : 'fail',
        where: `«${row.label}»`,
        detail: `${fmt(o)} + ${fmt(rc)} − ${fmt(s)} = ${fmt(calc)} বনাম মুদ্রিত ${fmt(cl)}`,
        cells: ok ? [] : [[r, closeCol]],
      });
      if (!ok) flag(r, closeCol, 'fail');
    }
  }

  /* --- Rule 6: sanity --- */
  grid.rows.forEach((row, r) => {
    row.cells.forEach((cell, c) => {
      if (cell.val != null && cell.val < 0) {
        add({ rule: 'ঋণাত্মক মান', sev: 'warn', where: `«${row.label}» · ${grid.headers[c + 1]}`, detail: `মান ${fmt(cell.val)}`, cells: [[r, c]] });
        flag(r, c, 'warn');
      }
    });
  });

  // duplicate labels within the same section run (across sections it is normal)
  for (const run of runs) {
    const count = {};
    run.forEach(({ row }) => { count[row.label] = (count[row.label] || 0) + 1; });
    Object.entries(count).forEach(([label, n]) => {
      if (n > 1) add({ rule: 'পুনরাবৃত্ত সারি', sev: 'info', where: `«${label}» ×${n}`, detail: 'একই অংশে একই নামের একাধিক সারি — ভুল সারি-ম্যাপ হতে পারে', cells: [] });
    });
  }

  const tally = { pass: 0, warn: 0, fail: 0, info: 0 };
  issues.forEach((i) => { tally[i.sev] += 1; });
  const checksRun = issues.filter((i) => i.sev !== 'info').length;
  return {
    issues,
    tally,
    checksRun,
    passRate: checksRun ? Math.round((tally.pass / checksRun) * 100) : 0,
  };
}
