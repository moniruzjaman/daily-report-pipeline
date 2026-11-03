/* Node smoke test: exercises the real PDF + DOCX readers (js/extract.js) and the
 * grid parser (js/parse pipeline in js/app.js logic mirrored here) against fixtures.
 * Run: node tests/node-smoke.mjs   */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

// ---- browser-ish globals --------------------------------------------------
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = globalThis.window || dom.window;
globalThis.DOMParser = dom.window.DOMParser;
// pdf.js references bare `document`/`navigator` on some paths even when running
// headless — mirror jsdom's globals onto globalThis like a real browser would.
if (typeof globalThis.document === 'undefined') globalThis.document = dom.window.document;
if (typeof globalThis.navigator === 'undefined') globalThis.navigator = dom.window.navigator;

// Simulate a sandboxed iframe (the common "can't parse PDF" environment):
// Worker construction THROWS, so extract.js must fall back to the main-thread
// fake worker loaded from vendor/pdf.worker.min.js via dynamic import().
globalThis.Worker = class {
  constructor() { throw new Error("Failed to construct 'Worker': The URL scheme is not supported."); }
};

// Load the REAL vendored UMD build the same way a browser <script> would.
const { readFileSync: _read } = await import('node:fs');
(0, eval)(_read('/workspace/vendor/pdf.min.js', 'utf8'));
const pdfjs = globalThis['pdfjs-dist/build/pdf']?.pdfjsLib ?? globalThis.pdfjsLib;
if (!pdfjs || typeof pdfjs.getDocument !== 'function') throw new Error('vendored pdf.min.js did not expose a usable pdfjsLib global');
globalThis.pdfjsLib = pdfjs;
console.log('✓ vendored pdf.min.js exposes a usable pdfjsLib (version', pdfjs.version + ')');

// Route the absolute asset URLs extract.js builds (vendor/*, cmaps, fonts) to disk.
const origFetch = globalThis.fetch;
globalThis.fetch = async (input, ...rest) => {
  const u = String(input?.url ?? input);
  let m = u.match(/vendor\/(cmaps|standard_fonts)\/(.*)$/);
  if (m) return origFetch(`file:///workspace/node_modules/pdfjs-dist/${m[1]}/${m[2]}`, ...rest);
  m = u.match(/\/vendor\/(.+)$/);
  if (m) return origFetch(`file:///workspace/vendor/${m[1]}`, ...rest);
  return origFetch(input, ...rest);
};

// Load the REAL vendored browser mammoth exactly like index.html does (<script>).
(0, eval)(_read('/workspace/vendor/mammoth.browser.min.js', 'utf8'));
globalThis.mammoth = globalThis.mammoth || dom.window.mammoth;
if (!globalThis.mammoth || typeof globalThis.mammoth.convertToHtml !== 'function') {
  throw new Error('vendored mammoth.browser.min.js did not expose window.mammoth');
}
console.log('✓ vendored mammoth.browser.min.js exposes window.mammoth');

const { readFileAny, parseGrid } = await import('../js/extract.js');
const { analyseEncoding, normalizeText } = await import('../js/bijoy.js');

function asFile(path, name) {
  const buf = readFileSync(path);
  return { name, size: buf.length, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), slice: (s, e) => ({ arrayBuffer: async () => buf.subarray(s, e).buffer }), text: async () => buf.toString('utf8') };
}

async function runOne(label, path, expectKind) {
  const file = asFile(path, path.split('/').pop());
  const progress = [];
  const doc = await readFileAny(file, (p, t) => progress.push(`${p}/${t}`));
  if (doc.kind !== expectKind) throw new Error(`${label}: kind=${doc.kind} expected ${expectKind}`);
  const enc = analyseEncoding(doc.text);
  const norm = normalizeText(doc.text, enc.encoding);
  const lines = String(norm.text).split('\n').map((t) => ({ text: t }));
  const grid = parseGrid(lines);
  console.log(`✓ ${label}: kind=${doc.kind} pages=${doc.pages} chars=${doc.text.length} enc=${enc.encoding} converted=${norm.converted} rows=${grid.rows.length} cols=${grid.nCols} progress=[${progress}]`);
  if (!grid.rows.length) throw new Error(`${label}: no rows parsed`);
  if (!doc.hasTextLayer) throw new Error(`${label}: expected text layer/content`);
  return { doc, grid, norm };
}

const results = {};
results.pdf = await runOne('PDF fixture', 'tests/fixtures/text.pdf', 'pdf');
results.unicodeDocx = await runOne('Unicode DOCX', 'tests/fixtures/unicode.docx', 'docx');
results.bijoyDocx = await runOne('Bijoy DOCX', 'tests/fixtures/bijoy.docx', 'docx');

// sanity: pdf fixture totals should be numeric
const totalRow = results.pdf.grid.rows.find((r) => r.isTotal);
console.log('PDF total row:', JSON.stringify(totalRow?.cells?.map((c) => c.val)));

// txt fallback + magic-byte sniffing
const txt = await readFileAny(asFile('package.json', 'note.txt'), () => {});
if (txt.kind !== 'txt') throw new Error('txt fallback failed');
console.log('✓ TXT fallback');

// mislabeled: docx named .bin should still be sniffed as zip→docx
const mis = await readFileAny(asFile('tests/fixtures/unicode.docx', 'report.bin'), () => {});
if (mis.kind !== 'docx') throw new Error('magic-byte sniffing failed');
console.log('✓ magic-byte sniffing (.docx renamed to .bin → docx reader)');

console.log('ALL OK');
