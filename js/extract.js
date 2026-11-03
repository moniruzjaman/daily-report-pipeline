/* extract.js — file readers (PDF / DOCX / TXT, with OCR for scanned PDFs) + text → grid parser. */

import { foldDigits } from './bijoy.js';

/* ---------------- OCR (tesseract.js, lazy-loaded) ---------------- */

/**
 * tesseract.js is vendored but NOT preloaded (it's ~50 KB core + ~10 MB of
 * language data fetched on first use). We load it only when a document has no
 * text layer, so normal PDFs/DOCX stay fast and fully offline after the first
 * OCR run (the language model gets cached by the browser / service worker).
 */
let ocrWorkerPromise = null;
let ocrLangLoaded = null; // 'ben' once Bengali works, 'eng' if we had to fall back

export function isOcrAvailable() {
  try {
    new Worker(vendorUrl('tesseract.worker.min.js'), { name: 'TesseractWorker' });
    return true;
  } catch {
    return false; // sandboxed iframe / CSP blocks Workers → OCR impossible
  }
}

async function getOcrWorker(onProgress) {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      const src = vendorUrl('tesseract.worker.min.js');
      const res = await fetch(src);
      if (!res.ok) throw new Error(`OCR লাইব্রেরি লোড হয়নি (${res.status})`);
      const code = await res.text();
      // Indirect eval → UMD attaches createWorker to globalThis (like a <script>).
      (0, eval)(code + '\n//# sourceURL=' + src);
      const T = globalThis.Tesseract;
      if (!T || typeof T.createWorker !== 'function') {
        throw new Error('tesseract.worker.min.js did not expose Tesseract.createWorker');
      }
      const opts = {
        workerPath: src,
        corePath: vendorUrl('tesseract-core/'),
        workerBlobURL: false,
        logger: (m) => { if (m && m.status) onProgress(m.status, Math.round((m.progress || 0) * 100)); },
      };
      // Bengali first; silently fall back to English if its traineddata is missing.
      let worker, lang = 'ben';
      try {
        worker = await T.createWorker(opts, 'ben', { cachePath: vendorUrl('tesseract-lang/') });
      } catch (e1) {
        lang = 'eng';
        try {
          worker = await T.createWorker(opts, 'eng', { cachePath: vendorUrl('tesseract-lang/') });
        } catch (e2) {
          throw new Error(`OCR মডেল ডাউনলোড ব্যর্থ (${(e1 && e1.message) || e1}) — ইন্টারনেট সংযোগ পরীক্ষা করুন অথবা টেক্সট "পেস্ট" করুন।`);
        }
      }
      ocrLangLoaded = lang;
      return worker;
    })().catch((err) => { ocrWorkerPromise = null; throw err; });
  }
  return ocrWorkerPromise;
}

/** Render one pdf.js page to a bitmap suitable for OCR (~300 dpi effective). */
async function renderPageForOcr(page) {
  const vp1 = page.getViewport({ scale: 1 });
  const MAX_SIDE = 2600;
  let scale = Math.max(2, Math.min(3, MAX_SIDE / Math.max(vp1.width, vp1.height)));
  const viewport = page.getViewport({ scale });
  let canvas, ctx;
  try {
    canvas = new OffscreenCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
    ctx = canvas.getContext('2d', { alpha: false });
  } catch {
    canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    ctx = canvas.getContext('2d', { alpha: false });
  }
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

/**
 * OCR a scanned PDF. Renders each page through pdf.js and runs tesseract.js
 * over the bitmaps. Throws a friendly error if Workers are unavailable or the
 * OCR engine cannot be loaded. `onProgress(page, total, status)` reports both
 * page advancement and in-page recognition progress.
 */
export async function ocrPdf(file, onProgress = () => {}, { maxPages = 12 } = {}) {
  const lib = getPdfjsLib();
  configurePdfWorker(lib);
  if (typeof Worker === 'undefined' || !isOcrAvailable()) {
    throw new Error('এই পরিবেশে Worker ব্লকড — OCR চালানো যায় না (স্যান্ডবক্সড প্রিভিউ)। ব্রাউজারে সরাসরি খুলুন, অথবা টেক্সট কপি করে "পেস্ট" করুন।');
  }
  const raw = await file.arrayBuffer();
  const data = new Uint8Array(raw);
  const params = () => ({
    data: data.slice(0),
    disableAutoFetch: true,
    disableStream: true,
    isEvalSupported: false,
    cMapUrl: vendorUrl('cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: vendorUrl('standard_fonts/'),
  });
  let pdf;
  try {
    pdf = await lib.getDocument(params()).promise;
  } catch (err) {
    if (lib.GlobalWorkerOptions?.workerPort) {
      try { lib.GlobalWorkerOptions.workerPort.terminate(); } catch { /* ignore */ }
      lib.GlobalWorkerOptions.workerPort = null;
    }
    await loadFakeWorker(lib);
    pdf = await lib.getDocument(params()).promise;
  }
  const numPages = pdf.numPages || 1;
  const limit = Math.min(numPages, maxPages);
  let worker = null;
  const lines = [];
  try {
    worker = await getOcrWorker((status, pct) => onProgress(ocrCurPage, limit, `${status} ${pct}%`));
    for (let p = 1; p <= limit; p++) {
      ocrCurPage = p;
      onProgress(p, limit, 'রেন্ডার');
      const page = await pdf.getPage(p);
      const canvas = await renderPageForOcr(page);
      onProgress(p, limit, 'OCR');
      const { data: out } = await worker.recognize(canvas);
      for (const l of String(out.text || '').split(/\r?\n/)) {
        const t = l.replace(/\s+/g, ' ').trim();
        if (t) lines.push({ text: t, page: p, ocr: true });
      }
    }
  } finally {
    if (worker) { try { await worker.terminate(); } catch { /* ignore */ } }
    ocrWorkerPromise = null; // fresh worker next time (lang/model may change)
    try { await pdf.destroy(); } catch { /* ignore */ }
  }
  ocrCurPage = 0;
  const text = lines.map((l) => l.text).join('\n');
  if (!text.replace(/\s/g, '').length) {
    throw new Error('OCR কোনো টেক্সট পায়নি — ছবির মান (resolution) কম হতে পারে। স্ক্যান আরও পরিষ্কার করে আবার চেষ্টা করুন।');
  }
  return {
    kind: 'pdf',
    pages: numPages,
    ocrPages: limit,
    ocrLang: ocrLangLoaded || 'ben',
    lines,
    text,
    hasTextLayer: true, // content now available via OCR
    viaOcr: true,
  };
}
let ocrCurPage = 0;

/* ---------------- helpers ---------------- */

/** Robustly locate the pdf.js global regardless of how vendor/pdf.min.js exposed it. */
function getPdfjsLib() {
  const g = globalThis;
  const lib = g.pdfjsLib || g['pdfjs-dist/build/pdf']?.pdfjsLib || g.PDFJS;
  if (!lib || typeof lib.getDocument !== 'function') {
    throw new Error('PDF লাইব্রেরি (vendor/pdf.min.js) লোড হয়নি — index.html-এর script ট্যাগ পরীক্ষা করুন, অথবা একবার hard-refresh / Service Worker ক্যাশ রিসেট দিন।');
  }
  return lib;
}

/** Absolute, page-independent URL for a vendored asset (correct under any base path). */
function vendorUrl(name) {
  try {
    return new URL(`../vendor/${name}`, import.meta.url).href;
  } catch {
    return `vendor/${name}`;
  }
}

/**
 * Configure the pdf.js worker once. Strategy:
 *   1. create a real same-origin Worker ourselves and hand it over as
 *      workerPort — immune to blob:-worker CSP restrictions and correct
 *      under any deployment base path;
 *   2. plain absolute workerSrc string (pdf.js builds its own worker);
 *   3. on failure → main-thread "fake worker" loaded from the vendored
 *      pdf.worker.min.js script (see loadFakeWorker) — never fails with
 *      "can't parse PDF" just because Workers are blocked.
 */
let pdfConfigured = false;
let fakeWorkerPromise = null;

function configurePdfWorker(lib) {
  if (pdfConfigured) return;
  try {
    const workerSrc = vendorUrl('pdf.worker.min.js');
    lib.GlobalWorkerOptions.workerSrc = workerSrc;
    if (typeof Worker !== 'undefined' && !lib.GlobalWorkerOptions.workerPort) {
      try {
        // Real browser environment: use our own same-origin classic worker.
        lib.GlobalWorkerOptions.workerPort = new Worker(workerSrc, { type: 'classic' });
      } catch { /* Worker blocked (sandbox/CSP) — readPdf falls back below */ }
    }
  } catch { /* older builds without GlobalWorkerOptions — ignore */ }
  pdfConfigured = true;
}

/**
 * Load vendor/pdf.worker.min.js into the current context and register it as
 * pdf.js's main-thread "fake worker". Works both in the browser (sandboxed
 * iframes where `new Worker` is blocked) and in Node smoke tests.
 * The UMD build attaches its export to `globalThis["pdfjs-dist/build/pdf.worker"]`.
 */
async function loadFakeWorker(lib) {
  if (!fakeWorkerPromise) {
    fakeWorkerPromise = (async () => {
      const src = vendorUrl('pdf.worker.min.js');
      const res = await fetch(src);
      if (!res.ok) throw new Error(`worker fetch failed (${res.status})`);
      const code = await res.text();
      // Indirect eval runs the UMD with globalThis as its window — same effect
      // as a <script> tag, without needing CSP-unsafe inline script elements.
      (0, eval)(code + '\n//# sourceURL=' + src);
      const exported = globalThis['pdfjs-dist/build/pdf.worker']?.pdfjsWorker
        ?? globalThis.pdfjsWorker
        ?? globalThis['pdfjs-dist/build/pdf.worker'];
      const handler = exported?.WorkerMessageHandler;
      if (!handler) throw new Error('pdf.worker.min.js did not export WorkerMessageHandler');
      if (lib.GlobalWorkerOptions) lib.GlobalWorkerOptions.workerPort = null;
      // pdf.js ≥3.10 API takes the whole worker-module object; older ones take
      // the named param object. Pass both shapes so either version works.
      lib.setupFakeWorkerGlobal({ Promise, WorkerMessageHandler: handler, pdfjsWorker: exported });
      return handler;
    })().catch((err) => { fakeWorkerPromise = null; throw err; });
  }
  return fakeWorkerPromise;
}

/* ---------------- readers ---------------- */

/**
 * Open a PDF with pdf.js, transparently falling back to pdf.js's main-thread
 * "fake worker" when real Workers are blocked (sandboxed previews / strict CSP)
 * — this is what previously surfaced as "can't parse PDF".
 */
async function openPdf(file) {
  const lib = getPdfjsLib();
  configurePdfWorker(lib);
  const raw = await file.arrayBuffer();
  // pdf.js may transfer/detach the ArrayBuffer it receives — always hand it a fresh copy.
  const data = new Uint8Array(raw);
  const params = () => ({
    data: data.slice(0),
    disableAutoFetch: true,
    disableStream: true,
    isEvalSupported: false,
    cMapUrl: vendorUrl('cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: vendorUrl('standard_fonts/'),
  });
  try {
    const pdf = await lib.getDocument(params()).promise;
    return pdf;
  } catch (err) {
    const msg = String((err && (err.message || err.name)) || err);
    if (/password/i.test(msg)) {
      throw new Error('PDF-ু পাসোয়ার্ড দিয়ে সুরক্ষিত — আনপ্রোটেক্ট করে আবার দিন।');
    }
    if (/worker|blob|URL|scheme|import|module|Failed to construct/i.test(msg)) {
      // Worker creation was blocked (sandboxed iframe / strict CSP). Fall back to
      // pdf.js's main-thread "fake worker" instead of failing with "can't parse PDF".
      try {
        if (lib.GlobalWorkerOptions?.workerPort) {
          try { lib.GlobalWorkerOptions.workerPort.terminate(); } catch { /* ignore */ }
          lib.GlobalWorkerOptions.workerPort = null;
        }
        await loadFakeWorker(lib);
        return await lib.getDocument(params()).promise;
      } catch (err2) {
        throw new Error(`PDF প্রসেসিং ব্যথ (জবিক্ষার ফলব্য্): ${err2 && err2.message ? err2.message : err2}`);
      }
    }
    throw new Error(`PDF প্রসেসিং ব্যথ: ${msg}`);
  }
}

/** Extract layout-aware lines from an already-opened pdf.js document. */
async function extractPdfLines(pdf, onProgress = () => {}) {
  const numPages = pdf.numPages || 1;
  const pages = [];
  for (let p = 1; p <= numPages; p++) {
    onProgress(p, numPages);
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    const lines = groupIntoLines(tc.items).map((l) => ({ ...l, page: p }));
    pages.push(lines);
  }
  // keep only non-empty lines; rebuild text from them so doc.lines and doc.text
  // stay aligned one-line-per-row for the grid parser
  const kept = pages.flat().filter((l) => l.text);
  const text = kept.map((l) => l.text).join('\n');
  return { text, lines: kept, numPages };
}

/**
 * Read a PDF. If it has no embedded text layer (i.e. it is a scan) and OCR is
 * possible in this environment, automatically render the pages through pdf.js
 * and run tesseract.js over them. Pass { tryOcr:false } to skip that.
 */
export async function readPdf(file, onProgress = () => {}, { tryOcr = true } = {}) {
  const pdf = await openPdf(file);
  let out;
  try {
    out = await extractPdfLines(pdf, (p, total) => onProgress(p, total));
  } finally {
    try { await pdf.destroy(); } catch { /* ignore */ }
  }
  const hasTextLayer = out.text.replace(/\s/g, '').length > 20;
  if (!hasTextLayer && tryOcr && isOcrAvailable()) {
    // Scanned PDF → automatic OCR pass.
    return ocrPdf(file, (p, total, status) => onProgress(p, total, status || 'OCR'));
  }
  return {
    kind: 'pdf',
    pages: out.numPages,
    lines: out.lines,
    text: out.text,
    hasTextLayer,
  };
}

function groupIntoLines(items) {
  const rows = items
    .filter((it) => it.str && it.str.trim() !== '')
    .map((it) => ({ x: it.transform[4], y: it.transform[5], str: it.str, w: it.width }));
  rows.sort((a, b) => (b.y - a.y) || (a.x - b.x));
  const lines = [];
  for (const r of rows) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - r.y) < 3.2) {
      const gap = r.x - (last.endX ?? last.x);
      last.parts.push(gap > Math.max(6, (r.w || 4) * 0.9) ? ' ' : '');
      last.parts.push(r.str);
      last.endX = r.x + (r.w || 0);
    } else {
      lines.push({ y: r.y, x: r.x, endX: r.x + (r.w || 0), parts: [r.str] });
    }
  }
  return lines.map((l) => ({ text: l.parts.join('').replace(/\s+/g, ' ').trim(), y: l.y }));
}

export async function readDocx(file) {
  const lib = globalThis.mammoth;
  if (!lib || typeof lib.convertToHtml !== 'function') {
    throw new Error('mammoth.js লোড হয়নি (vendor/mammoth.browser.min.js)। পেজ রিলোড করুন।');
  }
  const arrayBuffer = await file.arrayBuffer();
  // mammoth's browser build accepts an ArrayBuffer; the npm (Node) build expects a
  // Buffer-like object ({ buffer, length }). Pass both shapes so either works.
  const u8 = new Uint8Array(arrayBuffer);
  const { value: html } = await lib.convertToHtml({ arrayBuffer, buffer: u8 });
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const lines = [];
  for (const el of doc.body.children) {
    if (el.tagName === 'TABLE') {
      for (const tr of el.querySelectorAll('tr')) {
        const cells = [...tr.children].map((td) => td.textContent.replace(/\s+/g, ' ').trim());
        lines.push({ text: cells.join('\t'), table: true });
      }
    } else if (/^H[1-6]$|^P$|^UL$|^OL$/.test(el.tagName)) {
      const t = el.textContent.replace(/\s+/g, ' ').trim();
      if (t) lines.push({ text: t });
    }
  }
  const text = lines.map((l) => l.text).join('\n');
  return { kind: 'docx', pages: 1, lines, text, hasTextLayer: text.trim().length > 0 };
}

export async function readTxt(file) {
  const text = await file.text();
  const lines = text.split(/\r?\n/).map((t) => ({ text: t.trim() }));
  return { kind: 'txt', pages: 1, lines, text, hasTextLayer: text.trim().length > 0 };
}

/** Detect the container by magic bytes — more reliable than the file name alone. */
async function sniffKind(file) {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (head.length >= 4 && head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) return 'pdf'; // %PDF
  if (head.length >= 2 && head[0] === 0x50 && head[1] === 0x4b) return 'zip'; // ZIP → docx (or legacy .doc renamed)
  return null;
}

export async function readFileAny(file, onProgress) {
  const name = (file.name || '').toLowerCase();
  const sniffed = await sniffKind(file);
  if (sniffed === 'pdf' || (!sniffed && name.endsWith('.pdf'))) return readPdf(file, onProgress);
  if (sniffed === 'zip' || name.endsWith('.docx')) return readDocx(file); // .docx is a ZIP container
  if (name.endsWith('.doc')) {
    throw new Error('পুরোনো বাইনারি .doc সাপোর্টেড নয় — Word-এ খুলে .docx হিসেবে সেভ করে আবার দিন।');
  }
  return readTxt(file);
}

/* ---------------- grid parser ---------------- */

const NUM_RE = /^-?[\d,]+(?:\.\d+)?%?$/;

export function isTotalLabel(label) {
  const t = label.trim();
  if (!t) return false;
  if (/^(total|subtotal|grand\s*total|sub-total)$/i.test(t)) return true;
  return /(?:সর্বমোট|উপমোট|(?:^|\s)মোট(?:\s|$)|যোগফল$)/.test(t);
}

const SECTION_MAXLEN = 42;

/** Parse normalized text lines into { headers, rows } grid model. */
export function parseGrid(lines) {
  const headerKeywords = /(লক্ষ্য|অর্জন|গড়ফলন|উৎপাদন|মোট|গত\s*বছর|চলতি|ফসল|ক্রম|জমি|কন্ট্রোল|হে\.?|মে\.?\s?টন|শতকরা|target|achiev|yield|prod|total|area|crop|%)/i;

  const headerLines = [];
  const rawRows = [];
  const sections = [];

  for (const { text, table } of lines) {
    if (!text) continue;
    const norm = foldDigits(text);
    const cells = norm.includes('\t') ? norm.split('\t') : splitByNumbers(norm);

    if (!table && !/\d/.test(norm) && norm.length <= SECTION_MAXLEN && !headerKeywords.test(norm)) {
      sections.push({ afterIndex: rawRows.length, label: norm });
      continue;
    }
    if (!/\d/.test(norm) && headerKeywords.test(norm) && !table) {
      headerLines.push(norm);
      continue;
    }
    if (cells.length >= 2) {
      const label = (cells[0] || '').trim() || '—';
      const nums = cells.slice(1).map((c) => ({ raw: c.trim(), val: parseNum(c) }));
      rawRows.push({ label, nums });
    } else if (cells.length === 1 && rawRows.length) {
      // continuation / comment line — attach to previous label
      rawRows[rawRows.length - 1].label += ' ' + cells[0].trim();
    }
  }

  // modal numeric column count
  const counts = {};
  rawRows.forEach((r) => { counts[r.nums.length] = (counts[r.nums.length] || 0) + 1; });
  const nCols = rawRows.length
    ? Number(Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0])
    : 0;

  const rows = rawRows.map((r) => {
    const nums = [];
    for (let i = 0; i < nCols; i++) nums.push(r.nums[i] ?? { raw: '', val: null });
    return {
      label: r.label,
      isTotal: isTotalLabel(r.label),
      cells: nums,
      extra: r.nums.slice(nCols),
    };
  });

  const headers = buildHeaders(headerLines.join(' '), nCols);
  // attach section markers to rows
  for (const s of sections) {
    if (s.afterIndex < rows.length) rows[s.afterIndex].sectionBefore = s.label;
  }
  return { headers, rows, nCols };
}

function splitByNumbers(line) {
  // label = everything before the first numeric token; tokens split on whitespace
  const tokens = line.trim().split(/\s+/);
  const out = [];
  let labelParts = [];
  for (const tok of tokens) {
    const clean = tok.replace(/[()|:;]+$/g, '');
    if (NUM_RE.test(clean) || NUM_RE.test(tok)) out.push(tok);
    else if (out.length === 0) labelParts.push(tok);
    else out.push(tok); // stray text after numbers — keep in numeric zone as non-number
  }
  return [labelParts.join(' '), ...out];
}

export function parseNum(s) {
  if (s == null) return null;
  let t = String(s).trim();
  if (!t || /^[-–—.]+$/.test(t)) return null;
  t = foldDigits(t).replace(/,/g, '').replace(/%$/, '');
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

function buildHeaders(headerText, nCols) {
  // pick known Bengali/English column words in order of appearance;
  // longest keyword wins when several match at the same position
  const known = [
    'গত বছর লক্ষ্যমাত্রা', 'গত বছর অর্জন', 'গতবছর লক্ষ্য', 'গতবছর অর্জন',
    'গত বছর গড়ফলন', 'গত বছর উৎপাদন', 'গতবছর গড়ফলন', 'গতবছর মোট উৎপাদন',
    'চলতি লক্ষ্য', 'চলতি বছর লক্ষ্যমাত্রা', 'চলতি অর্জন', 'চলতি বছর অর্জন',
    'কন্ট্রোল জমি', 'চলতি গড়ফলন', 'চলতি মোট উৎপাদন', 'শতকরা', 'মজুদ', 'প্রাপ্তি', 'বিক্রয়',
    'target', 'achiev', 'ach', 'yield', 'prod', 'total', 'area', 'pct', 'percent',
  ];
  const hay = headerText.toLowerCase();
  const taken = [];
  const found = [];
  [...known].sort((a, b) => b.length - a.length).forEach((k) => {
    const idx = hay.indexOf(k.toLowerCase());
    if (idx < 0) return;
    const end = idx + k.length;
    if (taken.some(([s, e]) => idx < e && end > s)) return; // overlaps a longer match
    taken.push([idx, end]);
    found.push([idx, k]);
  });
  found.sort((a, b) => a[0] - b[0]);
  const headers = ['ফসল / Item'];
  for (let i = 0; i < nCols; i++) headers.push(found[i] ? found[i][1] : `কলাম ${i + 1}`);
  return headers;
}
