// Run from frontend: node node_modules/vite-node/vite-node.mjs scripts/generateCompactFixtures.mjs
// Synthetic, reproducible PDF raster fixtures for the current seal format.
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { PNG } from 'pngjs';
import ECCode from 'qrcode/lib/core/error-correction-code.js';
import { sealPdfInBrowser, qrPngBytes } from '../src/pdfClientSeal.js';
import { createQRedQrSymbol, qredHiddenPayloadByteOffset } from '../src/qredQr.js';
import { scanQrImage } from '../src/qr/scanQrImage.js';
import { qredPayloadFromPhotoScanResult, verifyQRedSeals } from '../src/qredVerifier.js';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const out = join(root, 'tests/fixtures/compact-qr'); mkdirSync(out, { recursive: true });
const temp = mkdtempSync(join(tmpdir(), 'qred-compact-fixtures-'));
const NativeDate = Date;
const fixedTime = '2026-10-20T17:55:14.123Z';
globalThis.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [fixedTime])); } static now() { return NativeDate.parse(fixedTime); } };
const keys = { privateKey: 'txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=', publicKey: 'eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=' };
function render(bytes, name) {
  const path = join(temp, name); writeFileSync(path + '.pdf', Buffer.from(bytes));
  execFileSync('pdftoppm', ['-png', '-r', '300', '-singlefile', path + '.pdf', path]);
  return PNG.sync.read(readFileSync(path + '.png'));
}
function crop(image, x, y, width, height) {
  const part = new PNG({ width, height }); PNG.bitblt(image, part, x, y, width, height, 0, 0); return part;
}
function save(image, name) { writeFileSync(join(out, name + '.png'), PNG.sync.write(image, { colorType: 2, deflateLevel: 9, deflateStrategy: 0 })); }
async function readSeal(image) {
  const data = new Uint8ClampedArray(image.data);
  const code = scanQrImage(data, image.width, image.height);
  if (code?.data !== 'QRED.ORG') throw new Error('Unable to scan generated fixture');
  return qredPayloadFromPhotoScanResult(data, image.width, image.height, code);
}
async function seal(bytes, strategy = 'automatic') {
  return sealPdfInBrowser({ file: new File([bytes], 'fixture.pdf', { type: 'application/pdf' }), ...keys, encodingStrategy: strategy });
}
try {
  const invoice = await seal(readFileSync(join(root, 'tests/fixtures/live-qa-invoice.pdf')));
  const full = render(await invoice.blob.arrayBuffer(), 'invoice');
  const footer = crop(full, 0, full.height - 900, full.width, 900);
  save(full, 'invoice-full-300dpi'); save(footer, 'invoice-footer-300dpi');
  if ((await verifyQRedSeals([await readSeal(footer)], keys.publicKey)).status !== 'VALID') throw new Error('Invoice signature failed');
  const qr = createQRedQrSymbol(invoice.stampedQrValues[0]);
  const target = qredHiddenPayloadByteOffset(qr.version) * ECCode.getBlocksCount(qr.version, qr.errorCorrectionLevel) * 8;
  let bit = 0, upward = true, position;
  for (let right = qr.modules.size - 1; right > 0 && !position; right -= 2) {
    if (right === 6) right -= 1;
    for (let vertical = 0; vertical < qr.modules.size && !position; vertical += 1) {
      const row = upward ? qr.modules.size - 1 - vertical : vertical;
      for (const col of [right, right - 1]) if (!qr.modules.isReserved(row, col) && bit++ === target) { position = { row, col }; break; }
    }
    upward = !upward;
  }
  const tile = 825 / (qr.modules.size + 8), { row, col } = position;
  writeFileSync(join(out, 'invoice-damage.json'), JSON.stringify({ version: qr.version, row, col,
    box: [Math.ceil(75 + (col + 4) * tile), Math.ceil((row + 4) * tile), Math.floor(75 + (col + 5) * tile), Math.floor((row + 5) * tile)],
    value: qr.modules.get(row, col) ? 255 : 0,
  }, null, 2) + '\n');
  const inventoryDoc = await PDFDocument.create();
  for (let i = 0; i < 2; i += 1) {
    const page = inventoryDoc.addPage([612, 792]);
    page.drawText(`Inventory dispatch QA-1042 | Page ${i + 1} of 2`, { x: 40, y: 740, size: 12 });
    for (let j = 0; j < 24; j += 1) page.drawText(`Line ${j + 1}: quantity ${j * 3 + i}; checked and approved for dispatch.`, { x: 40, y: 710 - j * 22, size: 10 });
  }
  const inventory = await seal(await inventoryDoc.save());
  const fourInch = await PDFDocument.create();
  const image = await fourInch.embedPng(await qrPngBytes(inventory.stampedQrValues[0]));
  fourInch.addPage([288, 288]).drawImage(image, { x: 0, y: 0, width: 288, height: 288 });
  const large = render(await fourInch.save(), 'inventory'); save(large, 'inventory-four-inch-300dpi');
  if ((await verifyQRedSeals([await readSeal(large)], keys.publicKey)).status !== 'VALID') throw new Error('Inventory signature failed');
  const manifestDoc = await PDFDocument.create(); const page = manifestDoc.addPage([612, 792]);
  for (let i = 0; i < 56; i += 1) page.drawText(`Item ${i + 1}: Received and inspected; quantity ${i * 7 + 3}; approved for delivery.`, { x: 40, y: 750 - i * 12, size: 9 });
  page.drawText('END OF MANIFEST - 56 synthetic line items.', { x: 40, y: 55, size: 9 });
  const manifest = await seal(await manifestDoc.save(), 'plaintext');
  if (manifest.stampedQrValues.length !== 2) throw new Error('Expected two manifest codes');
  const printed = render(await manifest.blob.arrayBuffer(), 'manifest');
  const scanned = [];
  for (let i = 0; i < 2; i += 1) {
    const image = crop(printed, Math.round((18 + i * 208) * 300 / 72), 3300, 825, 825);
    save(image, `manifest-seal-${i + 1}-300dpi`); scanned.push(await readSeal(image));
  }
  if ((await verifyQRedSeals(scanned.toReversed(), keys.publicKey)).status !== 'VALID') throw new Error('Manifest signature failed');
  console.log(JSON.stringify({ invoice: { payloadBytes: invoice.sealResult.payload_bytes, version: qr.version }, fixtures: out }));
} finally { globalThis.Date = NativeDate; rmSync(temp, { recursive: true, force: true }); }
