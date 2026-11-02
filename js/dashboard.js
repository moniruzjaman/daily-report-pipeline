/* dashboard.js — render document meta, editable grid, validation issues,
 * dashboard KPIs/charts, and file exports. Pure DOM, no dependencies. */

export function renderFileMeta(el, meta) {
  el.innerHTML = '';
  el.classList.remove('hidden');
  for (const [label, value, cls] of meta) {
    const chip = document.createElement('span');
    chip.className = 'chip' + (cls ? ` ${cls}` : '');
    chip.innerHTML = `<b>${label}:</b> ${value}`;
    el.appendChild(chip);
  }
}

export function renderGrid(gridEl, grid) {
  gridEl.innerHTML = '';
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  grid.headers.forEach((h) => {
    const th = document.createElement('th');
    th.contentEditable = 'true';
    th.spellcheck = false;
    th.textContent = h;
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  gridEl.appendChild(thead);

  const tbody = document.createElement('tbody');
  grid.rows.forEach((row, r) => {
    const tr = document.createElement('tr');
    if (row.sectionBefore) {
      const st = document.createElement('td');
      st.colSpan = grid.headers.length;
      st.className = 'section-row';
      st.textContent = row.sectionBefore;
      tr.appendChild(st);
      tbody.appendChild(tr);
      tr.dataset.section = row.sectionBefore;
      const tr2 = document.createElement('tr');
      tr2.dataset.r = r;
      fillRow(tr2, row, grid);
      tbody.appendChild(tr2);
      return;
    }
    tr.dataset.r = r;
    fillRow(tr, row, grid);
    if (row.isTotal) tr.classList.add('total-row');
    tbody.appendChild(tr);
  });
  gridEl.appendChild(tbody);
}

function fillRow(tr, row, grid) {
  const tdLabel = document.createElement('td');
  tdLabel.className = 'rowlabel';
  tdLabel.contentEditable = 'true';
  tdLabel.spellcheck = false;
  tdLabel.textContent = row.label;
  tr.appendChild(tdLabel);
  row.cells.forEach((cell) => {
    const td = document.createElement('td');
    td.contentEditable = 'true';
    td.spellcheck = false;
    td.textContent = cell.raw ?? '';
    if (cell.val == null && (cell.raw ?? '') !== '') td.classList.add('cell-miss');
    if (cell.flag === 'fail') td.classList.add('flag-fail');
    if (cell.flag === 'warn') td.classList.add('flag-warn');
    tr.appendChild(td);
  });
}

export function renderValidation(pillsEl, issuesWrapEl, result, grid) {
  const { tally, checksRun, passRate, issues } = result;
  pillsEl.innerHTML = `
    <div class="pill">Checks run<b>${checksRun}</b></div>
    <div class="pill pass">পাস<b>${tally.pass}</b></div>
    <div class="pill fail">ব্যর্থ<b>${tally.fail}</b></div>
    <div class="pill warn">সন্দেহজনক<b>${tally.warn}</b></div>
    <div class="pill">Pass rate<b>${passRate}%</b></div>`;

  const order = { fail: 0, warn: 1, info: 2, pass: 3 };
  const sorted = [...issues].sort((a, b) => order[a.sev] - order[b.sev]);
  const labelOf = { fail: 'ব্যর্থ', warn: 'সন্দেহ', pass: 'পাস', info: 'তথ্য' };
  let html = `<table class="issues"><thead><tr>
      <th>ফলাফল</th><th>নিয়ম</th><th>অবস্থান</th><th>বিস্তারিত</th>
    </tr></thead><tbody>`;
  for (const i of sorted) {
    const r = i.cells?.[0]?.[0];
    html += `<tr${r != null ? ` data-r="${r}"` : ''}><td><span class="sev ${i.sev}">${labelOf[i.sev]}</span></td>
      <td>${i.rule}</td><td>${i.where}</td><td>${i.detail}</td></tr>`;
  }
  html += '</tbody></table>';
  issuesWrapEl.innerHTML = html;

  // clear previous cell flags, then apply new ones
  grid.rows.forEach((row) => row.cells.forEach((c) => { c.flag = null; }));
  for (const i of issues) {
    for (const [r, c] of i.cells || []) {
      if (grid.rows[r] && grid.rows[r].cells[c]) grid.rows[r].cells[c].flag = i.sev === 'info' ? null : i.sev;
    }
  }
}

export function renderDashboard(el, grid, result) {
  const { tally, checksRun, passRate } = result;
  const nCells = grid.rows.reduce((a, r) => a + r.cells.filter((c) => c.val != null).length, 0);
  const totalSlots = grid.rows.length * grid.nCols;
  const fill = totalSlots ? Math.round((nCells / totalSlots) * 100) : 0;
  const nSections = new Set(grid.rows.map((r) => r.sectionBefore).filter(Boolean)).size || 1;

  el.innerHTML = `
    <div class="kpi"><div class="k-label">Rows parsed</div><div class="k-value">${grid.rows.length}</div><div class="k-sub">সারি · ${nSections} সেকশন</div></div>
    <div class="kpi"><div class="k-label">Numeric cells</div><div class="k-value">${nCells}</div><div class="k-sub">/${totalSlots} ঘর পূর্ণ (${fill}%)</div></div>
    <div class="kpi"><div class="k-label">Checks run</div><div class="k-value">${checksRun}</div><div class="k-sub">যাচাই চালানো হয়েছে</div></div>
    <div class="kpi ${tally.fail ? 'k-red' : 'k-green'}"><div class="k-label">Failed checks</div><div class="k-value">${tally.fail}</div><div class="k-sub">ব্যর্থ</div></div>
    <div class="kpi k-green"><div class="k-label">Pass rate</div><div class="k-value">${passRate}%</div><div class="k-sub">পাস-হার</div></div>`;

  renderDonut(document.getElementById('donut'), document.getElementById('donutLegend'), tally);
  renderColFill(document.getElementById('colFill'), grid);
}

function renderDonut(svg, legend, tally) {
  const parts = [
    ['পাস', tally.pass, '#3f7d4e'],
    ['ব্যর্থ', tally.fail, '#b3402e'],
    ['সন্দেহ', tally.warn, '#c8871e'],
  ].filter(([, n]) => n > 0);
  const total = parts.reduce((a, [, n]) => a + n, 0) || 1;
  const C = 2 * Math.PI * 44;
  let offset = 0;
  let segs = '';
  for (const [label, n, color] of parts) {
    const len = (n / total) * C;
    segs += `<circle r="44" cx="60" cy="60" fill="none" stroke="${color}" stroke-width="16"
      stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-offset}"
      transform="rotate(-90 60 60)"></circle>`;
    offset += len;
  }
  svg.innerHTML = `${segs}<text x="60" y="57" text-anchor="middle" font-size="20" font-weight="700" fill="#16323f">${total}</text>
    <text x="60" y="74" text-anchor="middle" font-size="9" fill="#6b7a80">checks</text>`;
  legend.innerHTML = parts
    .map(([label, n, color]) => `<li><span class="sw" style="background:${color}"></span>${label} — ${n}</li>`)
    .join('');
}

function renderColFill(el, grid) {
  el.innerHTML = '';
  for (let c = 0; c < grid.nCols; c++) {
    const filled = grid.rows.filter((r) => r.cells[c].val != null).length;
    const pct = grid.rows.length ? Math.round((filled / grid.rows.length) * 100) : 0;
    const cls = pct >= 90 ? 'full' : pct >= 60 ? 'mid' : 'low';
    el.innerHTML += `
      <div class="hb-row">
        <span title="${grid.headers[c + 1]}">${escapeHtml(String(grid.headers[c + 1] || `কলাম ${c + 1}`).slice(0, 16))}</span>
        <div class="hb-track"><div class="hb-fill ${cls}" style="width:${pct}%"></div></div>
        <span>${pct}%</span>
      </div>`;
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/* ---------------- exports ---------------- */

export function gridToCsv(grid) {
  const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const lines = [grid.headers.map(esc).join(',')];
  for (const row of grid.rows) {
    if (row.sectionBefore) lines.push(esc(row.sectionBefore));
    lines.push([esc(row.label), ...row.cells.map((c) => esc(c.raw))].join(','));
  }
  return '\ufeff' + lines.join('\r\n');
}

export function buildExport(state) {
  const { grid, result, meta } = state;
  return {
    pipeline: 'daily-report-pipeline',
    version: '1.1.0',
    exportedAt: new Date().toISOString(),
    document: meta,
    headers: grid.headers,
    rows: grid.rows.map((r) => ({
      section: r.sectionBefore || undefined,
      label: r.label,
      isTotal: r.isTotal || undefined,
      cells: r.cells.map((c) => ({ raw: c.raw, value: c.val })),
    })),
    validation: {
      checksRun: result.checksRun,
      tally: result.tally,
      passRate: result.passRate,
      issues: result.issues,
    },
  };
}

export function download(filename, content, mime) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime || 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
