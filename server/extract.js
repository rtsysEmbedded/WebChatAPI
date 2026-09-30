'use strict';

// Text extraction for document attachments. Extracted text is sent to the
// model as plain text, so documents work with every model of every provider.

const mammoth = require('mammoth');
const { config } = require('./config');

const X = config.attachments;
let pdfjsPromise = null;

function loadPdfjs() {
  // pdfjs-dist is ESM-only; the legacy build is the one intended for Node.js.
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

async function pdfText(buffer) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  const doc = await task.promise;
  const pages = Math.min(doc.numPages, X.maxPdfPages);
  const out = [];
  for (let i = 1; i <= pages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let text = '';
    for (const item of content.items) {
      if (typeof item.str !== 'string') continue;
      text += item.str + (item.hasEOL ? '\n' : '');
    }
    out.push(text.trim());
    page.cleanup();
  }
  await task.destroy();
  return { text: out.join('\n\n'), pagesRead: pages, pagesTotal: doc.numPages };
}

// Returns { text, truncated, pagesRead?, pagesTotal? } for document kinds,
// or null for media kinds (image/video) that are sent as binary.
async function extractText(kind, buffer) {
  let result;
  if (kind === 'text') result = { text: buffer.toString('utf8').replace(/^\uFEFF/, '') };
  else if (kind === 'pdf') result = await pdfText(buffer);
  else if (kind === 'docx') result = { text: (await mammoth.extractRawText({ buffer })).value };
  else return null;
  result.truncated = result.text.length > X.maxTextChars;
  if (result.truncated) result.text = result.text.slice(0, X.maxTextChars);
  if (result.pagesRead < result.pagesTotal) result.truncated = true;
  return result;
}

module.exports = { extractText };
