/* extract.js — file readers (PDF / DOCX / TXT) + text → grid parser. */

import { foldDigits } from './bijoy.js';

/* ---------------- helpers ---------------- */

/** Robustly locate the pdf.js global regardless of how vendor/pdf.min.js exposed it. */
function getPdfjsLib() {
  const g = globalThis;
  const lib = g.pdfjsLib || g['pdfjs-dist/build/pdf']?.pdfjsLib || g.PDFJS;
  if (!lib || typeof lib.getDocument !== 'function') {
    throw new Error('pdf.js লোড হয়নি (vendor/pdf.min.js)। পেজ রিলোড করুন।');
  }
  return lib;
}

/** Configure the pdf.js worker once; fall back to a same-origin fake worker if needed. */
let pdfConfigured = false;
function ensurePdfWorker(lib) {
  if (pdfConfigured) return;
  try {
    lib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    // In some sandboxes Worker/blob URLs are blocked; pdf.js then needs eval-based
    // fake workers disabled so it can load the worker module via import().
    if (typeof window === 'undefined' || !window.Worker) {
      lib.GlobalWorkerOptions.isEvalSupported = false;
    }
  } catch { /* older builds without GlobalWorkerOptions — ignore */ }
  pdfConfigured = true;
}

/* ---------------- readers ---------------- */

export async function readPdf(file, onProgress = () => {}) {
  const lib = getPdfjsLib();
  ensurePdfWorker(lib);
  const buf = await file.arrayBuffer();
  let pdf;
  try {
    pdf = await lib.getDocument({ data: buf, isEvalSupported: false }).promise;
  } catch (err) {
    // Common failure in sandboxed contexts: worker creation blocked → retry without eval.
    if (/worker/i.test(String(err && err.message))) {
      lib.GlobalWorkerOptions.workerSrc = '';
      pdf = await lib.getDocument({ data: buf, disableAutoFetch: true, isEvalSupported: false }).promise;
    } else {
      throw err;
    }
  }
  const numPages = pdf.numPages || 1;
  const pages = [];
  for (let p = 1; p <= numPages; p++) {
    onProgress(p, numPages);
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    const lines = groupIntoLines(tc.items).map((l) => ({ ...l, page: p }));
    pages.push(lines);
  }
  const allLines = pages.flat();
  // keep only non-empty lines; rebuild text from them so doc.lines and doc.text
  // stay aligned one-line-per-row for the grid parser
  const kept = allLines.filter((l) => l.text);
  const text = kept.map((l) => l.text).join('\n');
  return {
    kind: 'pdf',
    pages: numPages,
    lines: kept,
    text,
    hasTextLayer: text.replace(/\s/g, '').length > 20,
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
  const { value: html } = await lib.convertToHtml({ arrayBuffer });
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
