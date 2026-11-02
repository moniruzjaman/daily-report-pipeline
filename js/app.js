/* app.js — pipeline orchestrator + UI wiring.
 * Stages: read → detect → extract → normalize → parse → validate. */

import { analyseEncoding, normalizeText } from './bijoy.js';
import { readFileAny, parseGrid } from './extract.js';
import { validateGrid } from './validate.js';
import {
  renderFileMeta, renderGrid, renderValidation, renderDashboard,
  gridToCsv, buildExport, download,
} from './dashboard.js';
import { SAMPLE_NAME, SAMPLE_TEXT, SAMPLE_NOTE } from './sample-data.js';

const $ = (id) => document.getElementById(id);

const state = {
  fileName: null,
  doc: null,       // { kind, pages, text, hasTextLayer }
  encoding: null,  // analyseEncoding result
  normalize: null, // normalizeText result
  grid: null,
  result: null,
};

/* ---------------- pipeline UI ---------------- */

function stage(name, status, note = '') {
  const el = document.querySelector(`.stage[data-stage="${name}"]`);
  if (!el) return;
  el.classList.remove('active', 'done', 'error');
  if (status) el.classList.add(status);
  el.querySelector('.st-note').textContent = note;
}
function resetStages() {
  ['read', 'detect', 'extract', 'normalize', 'parse', 'validate'].forEach((s) => stage(s, null, ''));
}
function alertBox(kind, html) {
  const el = $('inputAlert');
  el.className = `alert ${kind} show`;
  el.innerHTML = html;
}
function clearAlert() { $('inputAlert').className = 'alert'; }

function showDataCards(show) {
  document.body.dataset.view = show ? 'data' : 'empty';
  document.querySelectorAll('.needs-data').forEach((el) => el.classList.toggle('hidden', !show));
}

/* ---------------- core pipeline ---------------- */

async function runPipeline({ name, text, doc }) {
  resetStages();
  clearAlert();
  showDataCards(false);
  state.fileName = name;
  state.doc = doc;

  try {
    // 1. read
    stage('read', 'done', `${doc.kind} · ${doc.pages}p`);

    // 2. detect encoding
    state.encoding = analyseEncoding(text);
    stage('detect', 'done', state.encoding.label);

    // 3/4. extract + normalize (for files, extraction already happened in readFileAny)
    state.normalize = normalizeText(text, state.encoding.encoding);
    stage('extract', 'done', `${text.length.toLocaleString()} chars`);
    stage('normalize', 'done', state.normalize.converted
      ? `bijoy→unicode ✓${state.normalize.unmapped ? ` · ${state.normalize.unmapped} unmapped` : ''}`
      : 'unicode — রূপান্তর দরকার নেই');

    if (state.encoding.encoding === 'bijoy' && !state.normalize.text.trim()) {
      stage('normalize', 'error', 'রূপান্তর ব্যর্থ');
      alertBox('error', 'বিজয় টেক্সট রূপান্তরে ব্যর্থ — ফাইলটি সম্ভবত পুরোনো বাইনারি .doc (DOCX নয়)। টেক্সট কপি করে "Paste data" ব্যবহার করুন।');
      return;
    }

    await processText(state.normalize.text);
  } catch (err) {
    console.error(err);
    alertBox('error', `পাইপলাইন ব্যর্থ: ${err.message || err}`);
  }
}

async function processText(text) {
  // 5. parse grid
  state.grid = parseGrid(text.split(/\r?\n/).map((t) => ({ text: t })));
  if (!state.grid.rows.length) {
    stage('parse', 'error', 'সারি পাওয়া যায়নি');
    alertBox('warn', 'কোনো ডেটা-সারি পার্স করা যায়নি। প্রতি লাইনে "নাম সংখ্যা সংখ্যা ..." ফরম্যাট আশা করা হয়েছে — "Paste data" থেকে ম্যানুয়ালি দেওয়ার চেষ্টা করুন।');
    return;
  }
  stage('parse', 'done', `${state.grid.rows.length} rows × ${state.grid.nCols} cols`);

  // 6. validate
  state.result = validateGrid(state.grid);
  stage('validate', state.result.tally.fail ? 'error' : 'done',
    `${state.result.tally.pass}✓ ${state.result.tally.fail}✗ ${state.result.tally.warn}!`);

  // render everything (grid last so it draws the fresh cell flags)
  renderDocMeta();
  renderValidation($('valPills'), $('issuesWrap'), state.result, state.grid);
  renderDashboard($('kpis'), state.grid, state.result);
  showDataCards(true);
  renderGrid($('grid'), state.grid);

  if (state.encoding.encoding === 'bijoy') {
    alertBox('info', 'বিজয় (SutonnyMJ) এনকোডিং সনাক্ত হয়েছে — টেক্সট ইউনিকোডে রূপান্তর করা হয়েছে ✓');
  }
}

function renderDocMeta() {
  const enc = state.encoding;
  const encCls = { unicode: 'enc-unicode', bijoy: 'enc-bijoy', latin: 'enc-latin' }[enc.encoding];
  const meta = [
    ['ফাইল', escapeHtml(state.fileName)],
    ['ধরন', state.doc.kind.toUpperCase() + (state.doc.kind === 'pdf' ? ` · ${state.doc.pages} পৃষ্ঠা` : '')],
    ['এনকোডিং', enc.label, encCls],
  ];
  if (state.normalize?.converted) {
    meta.push(['রূপান্তর', `বিজয় → ইউনিকোড${state.normalize.unmapped ? ` · অম্যাপড ${state.normalize.unmapped}` : ' ✓'}`, 'enc-bijoy']);
  }
  if (state.doc.kind === 'pdf' && !state.doc.hasTextLayer) {
    meta.push(['টেক্সট-লেয়ার', 'নেই (স্ক্যান)', 'enc-bijoy']);
  }
  renderFileMeta($('docMeta'), meta);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/* ---------------- file input ---------------- */

async function handleFile(file) {
  if (!file) return;
  $('fileMeta').classList.add('hidden');
  clearAlert();
  resetStages();
  stage('read', 'active', `${(file.size / 1024).toFixed(0)} KB`);
  try {
    const doc = await readFileAny(file, (p, total) => stage('extract', 'active', `পৃষ্ঠা ${p}/${total}`));
    if (doc.kind === 'pdf' && !doc.hasTextLayer) {
      stage('read', 'done', `${(file.size / 1024).toFixed(0)} KB`);
      stage('extract', 'error', 'টেক্সট-লেয়ার নেই');
      alertBox('warn',
        `<b>স্ক্যান করা PDF (টেক্সট-লেয়ার নেই)।</b> এই সংস্করণে OCR নেই — দুটি উপায়:<br>
         ১. PDF থেকে টেক্সট কপি করে <b>"Paste data"</b> বক্সে পেস্ট করুন (প্রতি লাইনে: নাম সংখ্যা সংখ্যা …)।<br>
         ২. অফিসের কম্পিউটারে ফাইলটি DOCX হিসেবে সেভ/টাইপ করে আপলোড করুন — DOCX পুরোপুরি সমর্থিত।`);
      return;
    }
    const chips = [
      ['ফাইল', escapeHtml(file.name)],
      ['সাইজ', `${(file.size / 1024).toFixed(0)} KB`],
      ['ধরন', doc.kind.toUpperCase()],
    ];
    renderFileMeta($('fileMeta'), chips);
    await runPipeline({ name: file.name, text: doc.text, doc });
  } catch (err) {
    console.error(err);
    stage('read', 'error', 'পড়া যায়নি');
    alertBox('error', `ফাইল পড়া যায়নি: ${err.message || err}. পুরোনো .doc (DOCX নয়) হলে আগে Word-এ খুলে .docx হিসেবে সেভ করুন।`);
  }
}

/* ---------------- re-check after manual edits ---------------- */

function regridFromDom() {
  const gridEl = $('grid');
  state.grid.headers = [...gridEl.tHead.rows[0].cells].map((th) => th.textContent.trim());
  const newRows = [];
  for (const tr of gridEl.tBodies[0].rows) {
    if (tr.dataset.section !== undefined) continue; // decorative section row
    const cells = [...tr.cells];
    const label = cells[0].textContent.trim();
    const nums = cells.slice(1).map((td) => {
      const raw = td.textContent.trim();
      return { raw, val: parseNumLoose(raw) };
    });
    newRows.push({ label, isTotal: detectTotal(label), cells: nums, sectionBefore: undefined });
  }
  let di = 0;
  state.grid.rows = state.grid.rows.map((row) => {
    const nr = newRows[di++];
    if (!nr) return row;
    nr.sectionBefore = row.sectionBefore; // preserve section markers
    return nr;
  });
}

function parseNumLoose(s) {
  if (!s || /^[-–—.]+$/.test(s)) return null;
  const bn = '০১২৩৪৫৬৭৮৯';
  s = s.replace(/[০-৯]/g, (d) => String(bn.indexOf(d))).replace(/,/g, '').replace(/%$/, '');
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}
function detectTotal(label) {
  return /(?:সর্বমোট|উপমোট|(?:^|\s)মোট(?:\s|$)|যোগফল$)/.test(label.trim()) || /^(total|subtotal)$/i.test(label.trim());
}

function runRecheck() {
  regridFromDom();
  state.result = validateGrid(state.grid);
  renderValidation($('valPills'), $('issuesWrap'), state.result, state.grid);
  renderDashboard($('kpis'), state.grid, state.result);
  renderGrid($('grid'), state.grid);
}

/* ---------------- exports ---------------- */

function safeName() {
  return (state.fileName || 'daily-report').replace(/\.[^.]+$/, '').replace(/[^\w\u0980-\u09FF.-]+/g, '_').slice(0, 60);
}

/* ---------------- wiring ---------------- */

function wire() {
  const dz = $('dropzone');
  const fi = $('fileInput');
  dz.addEventListener('click', () => fi.click());
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fi.click(); });
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', (e) => handleFile(e.dataTransfer.files[0]));
  fi.addEventListener('change', () => handleFile(fi.files[0]));

  $('sampleBtn').addEventListener('click', () => {
    renderFileMeta($('fileMeta'), [['ফাইল', escapeHtml(SAMPLE_NAME)], ['ধরন', 'SAMPLE']]);
    runPipeline({ name: SAMPLE_NAME, text: SAMPLE_TEXT, doc: { kind: 'sample', pages: 1, text: SAMPLE_TEXT, hasTextLayer: true } });
    if (SAMPLE_NOTE) setTimeout(() => alertBox('info', SAMPLE_NOTE), 50);
  });

  $('pasteToggle').addEventListener('click', () => {
    $('pasteWrap').classList.toggle('hidden');
    $('pasteBox').focus();
  });
  $('pasteRun').addEventListener('click', () => {
    const text = $('pasteBox').value;
    if (!text.trim()) { alertBox('warn', 'আগে কিছু টেক্সট পেস্ট করুন।'); return; }
    renderFileMeta($('fileMeta'), [['ফাইল', 'Pasted data'], ['ধরন', 'TEXT']]);
    runPipeline({ name: 'Pasted data.txt', text, doc: { kind: 'txt', pages: 1, text, hasTextLayer: true } });
  });

  $('resetBtn').addEventListener('click', () => {
    state.grid = null; state.result = null; state.doc = null;
    $('fileMeta').classList.add('hidden');
    $('pasteBox').value = '';
    showDataCards(false);
    resetStages();
    clearAlert();
    fi.value = '';
  });

  $('recheckBtn').addEventListener('click', runRecheck);

  $('expJson').addEventListener('click', () => {
    if (!state.grid) return;
    const doc = { file: state.fileName, kind: state.doc?.kind, encoding: state.encoding?.label, converted: state.normalize?.converted };
    download(`${safeName()}.pipeline.json`, JSON.stringify(buildExport({ ...state, meta: doc }), null, 2), 'application/json');
  });
  $('expCsv').addEventListener('click', () => {
    if (!state.grid) return;
    download(`${safeName()}.csv`, gridToCsv(state.grid), 'text/csv;charset=utf-8');
  });
  $('expPrint').addEventListener('click', () => window.print());

  // online/offline badge
  const upd = () => {
    $('netBadge').classList.toggle('offline', !navigator.onLine);
    $('netLabel').textContent = navigator.onLine ? 'online' : 'offline';
  };
  window.addEventListener('online', upd);
  window.addEventListener('offline', upd);
  upd();
}

/* ---------------- PWA ---------------- */

function pwa() {
  if (location.protocol === 'file:') {
    $('protoAlert').classList.add('show');
  }
  const secure = location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname);
  if ('serviceWorker' in navigator && secure) {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('SW registration failed:', err));
  }
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    $('installBtn').style.display = 'inline-block';
  });
  $('installBtn').addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    $('installBtn').style.display = 'none';
  });
}

wire();
pwa();
