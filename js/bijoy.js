/* bijoy.js — encoding detection + Bijoy→Unicode conversion wrapper.
 * Conversion engine: vendor/bijoy2unicode.esm.js (MIT, © Md. Jehad / JehadurRE). */

import {
  convertBijoyToUnicode,
  hasBengaliUnicode,
  looksLikeBijoy,
  scanUnmapped,
} from '../vendor/bijoy2unicode.esm.js';

export { convertBijoyToUnicode, hasBengaliUnicode, looksLikeBijoy };

/** Characters that only (or overwhelmingly) appear in legacy Bijoy/SutonnyMJ output. */
const BIJOY_CHARS = /[\u0080-\u00FF\u0192\u02C6\u02DC\u201A\u201E\u2020\u2021\u2030\u2039\u203A\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u00AD]/g;

export function analyseEncoding(text) {
  const total = text.replace(/\s/g, '').length || 1;
  let bengali = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c >= 0x0980 && c <= 0x09FF) bengali += 1;
  }
  const bijoyHits = (text.match(BIJOY_CHARS) || []).length;
  const asciiLetters = (text.match(/[A-Za-z]/g) || []).length;

  let encoding = 'latin';
  let label = 'Latin / plain text';
  if (bengali / total > 0.03) {
    encoding = 'unicode';
    label = 'Unicode বাংলা';
  } else if (bijoyHits >= 3 || (bijoyHits > 0 && looksLikeBijoy(text))) {
    encoding = 'bijoy';
    label = 'বিজয় (SutonnyMJ legacy)';
  }
  return {
    encoding,
    label,
    bengaliChars: bengali,
    bijoyHits,
    asciiLetters,
    totalChars: total,
  };
}

/** Convert text if it looks like Bijoy. Returns { text, converted, unmapped }. */
export function normalizeText(text, encoding) {
  if (encoding !== 'bijoy') return { text, converted: false, unmapped: 0 };
  const convertedText = convertBijoyToUnicode(text);
  const leftover = scanUnmapped(convertedText);
  const unmapped = Object.values(leftover).reduce((a, b) => a + b, 0);
  return { text: convertedText, converted: true, unmapped };
}

/** Bengali digits → ASCII, common dashes unified, commas inside numbers kept for the parser. */
export function foldDigits(text) {
  const bn = '০১২৩৪৫৬৭৮৯';
  return text.replace(/[০-৯]/g, (d) => String(bn.indexOf(d)))
             .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212\u2015]/g, '-')
             .replace(/\u00A0/g, ' ');
}
