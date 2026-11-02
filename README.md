# Daily Report Pipeline

**দৈনিক প্রতিবেদন পাইপলাইন** — an installable, fully offline PWA that turns a daily
return (PDF / DOCX / pasted text, in **Unicode Bengali or legacy Bijoy/SutonnyMJ**)
into a validated data grid, a set of arithmetic consistency checks, and a dashboard.

Built for the daily DAE (Department of Agricultural Extension) field-return workflow:
upload the day's document → the pipeline reads, detects the encoding, converts Bijoy
to Unicode, parses the number grid, re-computes every printed total, and flags the
cells that don't add up — before the numbers travel further up the reporting chain.

Everything runs **client-side in the browser**. No server, no build step, no data
leaves the device.

---

## Features

- **Dashboard-first** — the app opens straight onto the verdict banner (health-score
  ring + one-line verdict), KPI strip, interactive charts and ranked auto-insights.
  The intake is a tiny **📥 ইনবক্স** widget in the header (drop a file anywhere on the
  page and it opens automatically); the first visit auto-loads the demo return.
- **Interactive charts** (hand-rolled canvas — no chart library, offline-safe):
  section-level target-vs-achievement grouped bars, a zero-centred **variance chart**
  of every printed-total discrepancy, a per-crop **চলতি লক্ষ্য vs গত অর্জন %** mover
  chart, check-outcome donut and column fill bars. Hover for exact numbers; click a
  bar to jump to that row in the grid.
- **Auto-insights** — a rules engine ranks what a static report cannot show: printed
  totals that don't match their row sums (with computed-vs-printed values), same-year
  target/achievement blowups, partially-unreported columns, notable movers — each
  card links straight to the offending grid row.
- **Input box** — `.pdf` / `.docx` / `.txt` or pasted text.
- **Encoding detection** — Unicode Bengali (U+0980–U+09FF) vs legacy Bijoy
  (SutonnyMJ-era high-ASCII) is detected automatically; Bijoy text is converted to
  Unicode using the [bijoy2unicode](https://github.com/JehadurRE/Bijoy2Unicode) engine (MIT).
- **Extraction** — text-layer PDFs via [pdf.js](https://mozilla.github.io/pdf.js/) (line
  reconstruction from glyph positions), DOCX via [mammoth.js](https://github.com/mwilliamson/mammoth.js)
  (paragraphs **and** tables), TXT directly. Bengali numerals (০-৯) are normalized.
- **Grid parser** — `label number number …` lines become rows; section headings,
  repeated মোট rows and header keywords are recognized; the grid is fully
  **editable in place** (click any cell), with a *Run checks* button to re-validate.
- **Validation engine** — section-scoped arithmetic checks:
  1. printed **total rows** vs sums of their section's data rows,
  2. in-row **total columns** (yield/percentage columns excluded),
  3. **yield consistency** — area × yield ≈ production (±5 % pass, ±8 % warn),
  4. **target–achievement %** consistency,
  5. **stock math** — opening + receipts − sales = closing,
  6. sanity checks — negative values, duplicate labels in one section.
  Each check reports pass / fail / warn with the computed vs printed values, and
  failing cells are outlined red (warnings amber) directly in the grid.
- **Exports** — pipeline result as JSON, grid as CSV (UTF-8 BOM), and a clean
  print/PDF layout.
- **PWA** — web app manifest, generated icons, service worker pre-caching the whole
  app shell: install it from the browser and it works with the network off.

## Run it

Any static file server works — a server (not `file://`) is required for ES modules
and the service worker:

```bash
cd daily-report-pipeline
python3 -m http.server 8080
# → http://localhost:8080
```

or `npx serve .`, or deploy to GitHub Pages / Netlify / any static host. On HTTPS
(or localhost) the browser will offer **Install app**; afterwards it launches
standalone and works offline.

## Try it in 10 seconds

Click **"স্যাম্পল লোড করুন"** — the bundled sample is the condensed 02-Nov-2026
Kurigram daily return, seeded with the arithmetic discrepancies actually found in
that document (রোপা আমন printed totals, বোরো গত-বছর লক্ষ্য, আলু চলতি লক্ষ্য). The
engine runs 16 checks and flags exactly those cells. Test fixtures used in
development live in `tests/fixtures/` (Unicode DOCX, Bijoy DOCX, text-layer PDF).

## Limitations & roadmap

- **Scanned/photo PDFs (no text layer) are detected but not OCR-ed** — the app says
  so and offers the paste path. OCR (tesseract.js, `ben`) is the top roadmap item.
- Legacy **binary `.doc`** (pre-DOCX) is not readable in the browser — re-save as
  `.docx` in Word, or copy-paste the text.
- The grid parser is a best-effort line heuristic for `label + numbers` returns;
  anything unusual is correctable directly in the editable grid before re-checking.

## Repository layout

```
index.html              app shell (dashboard-first)
manifest.webmanifest    PWA manifest
sw.js                   service worker (pre-cache + stale-while-revalidate)
css/style.css           styles (print layout included)
js/app.js               pipeline orchestrator + UI wiring
js/bijoy.js             encoding detection + Bijoy→Unicode wrapper
js/extract.js           PDF/DOCX/TXT readers + grid parser
js/validate.js          validation rules engine
js/charts.js            dependency-free canvas charts (grouped + diverging bars)
js/insights.js          verdict, ranked auto-insights, chart data shaping
js/dashboard.js         grid / issues / dashboard rendering + exports
js/sample-data.js       built-in 02-Nov-2026 sample
vendor/                 pdf.js, mammoth.js, bijoy2unicode (vendored, offline)
icons/                  generated PWA icons
tests/fixtures/         dev fixtures (Unicode DOCX, Bijoy DOCX, text PDF)
```

## Credits & licenses

- [bijoy2unicode](https://github.com/JehadurRE/Bijoy2Unicode) — MIT — Bijoy/SutonnyMJ →
  Unicode Bengali mapping and conversion.
- [pdf.js](https://mozilla.github.io/pdf.js/) — Apache-2.0 — PDF text extraction.
- [mammoth.js](https://github.com/mwilliamson/mammoth.js) — BSD-2-Clause — DOCX extraction.

## Releasing updates

Bump `VERSION` in `sw.js` when you change any cached file, so installed clients
pick up the new shell on their next visit.

## License

MIT — see [LICENSE](LICENSE).
