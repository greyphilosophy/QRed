// Run from frontend with node --input-type=module -e <this source> <output dir>.
// Synthetic renders only: this does not claim physical printer/camera coverage.
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { PNG } from 'pngjs';

const directory = process.argv[1];
const text = 'Invoice 1042\nAccount 123456\nApproved total 123.45\nPayment due Friday';
const publicKey = 'eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=';
const server = await createServer({ logLevel: 'error', server: { middlewareMode: true } });
try {
  const { createQRedSeals } = await server.ssrLoadModule('/src/qredSealer.js');
  const { qrPayloadBytes, sealString } = await server.ssrLoadModule('/src/sealFormat.js');
  const { planNonoverlapErasure, drawNonoverlapErasurePlan } = await server.ssrLoadModule('/src/pdf/nonoverlapErasurePlan.js');
  const { drawQrSymbol } = await server.ssrLoadModule('/src/pdf/qrDrawing.js');
  const { renderPdfPage, withPdfDocument } = await server.ssrLoadModule('/src/pdf/readPdfText.js');
  const { scanErasureSeals } = await server.ssrLoadModule('/src/qr/scanErasureSeals.js');
  const { verifySealCollection } = await server.ssrLoadModule('/src/sealCollection.js');
  const render = bytes => withPdfDocument(new Blob([bytes]), pdf => renderPdfPage(pdf, 1, 2, { reference: true }));
  async function document(variant = 'unchanged') {
    const pdf = await PDFDocument.create(), page = pdf.addPage([612, 792]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    text.split('\n').forEach((line, index) => {
      if (variant === 'deleted-line' && index === 3) return;
      page.drawText(variant === 'changed-amount' ? line.replace('123.45', '923.45') : line,
        { x: 72, y: 700 - index * 60, size: 24, font });
    });
    // This remains in the ordinary text area, not inside a code or its quiet zone.
    if (variant === 'added-text') page.drawText('Paid', { x: 72, y: 490, size: 24, font });
    return pdf;
  }
  const source = await (await document()).save(), original = await render(source);
  const signed = await createQRedSeals({ content: text, publicKey,
    privateKey: 'txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=',
    timestamp: '2026-11-04T07:00:00Z',
    pageContext: { pageNumber: 1, pageCount: 1, documentRoot: 'ef'.repeat(32) } });
  assert.equal(signed.seals.length, 1);
  const plan = await planNonoverlapErasure(original, qrPayloadBytes(signed.seals[0]));
  assert.equal(plan.status, 'available');
  assert.equal(plan.total, 16);
  assert.equal(plan.required, 12);
  const seals = plan.shards.map(bytes => sealString(bytes));
  const manifest = { text, publicKey, width: original.width, height: original.height, seals, variants: {} };
  await mkdir(directory, { recursive: true });
  for (const variant of ['unchanged', 'changed-amount', 'deleted-line', 'added-text', 'four-missing']) {
    const sourceBytes = await (await document(variant)).save();
    const before = await render(sourceBytes);
    const pdf = await PDFDocument.load(sourceBytes), page = pdf.getPage(0);
    const omit = variant === 'four-missing' ? [0, 5, 10, 15] : [];
    if (omit.length) plan.symbols.forEach((symbol, index) => {
      if (!omit.includes(index)) drawQrSymbol(page, symbol, plan.boxes[index], .85, false);
    });
    else drawNonoverlapErasurePlan(page, plan);
    const image = await render(await pdf.save());
    let ink = 0;
    for (let at = 0; at < before.data.length; at += 4) {
      if (before.data.subarray(at, at + 4).every(value => value === 255)) continue;
      assert.deepEqual(image.data.subarray(at, at + 4), before.data.subarray(at, at + 4),
        `${variant}: a code changed original text pixels`);
      ink++;
    }
    assert.ok(ink > 1000);
    const expected = seals.filter((_, index) => !omit.includes(index));
    const recovered = await scanErasureSeals(image);
    assert.deepEqual(new Set(recovered), new Set(expected), `${variant}: fixture optical preflight`);
    const [verified] = await verifySealCollection(recovered, publicKey);
    assert.equal(verified.status, 'VALID');
    assert.equal(verified.signature_valid, true);
    assert.equal(verified.content, text);
    const png = new PNG({ width: image.width, height: image.height });
    png.data = Buffer.from(image.data);
    const filename = `${variant}.png`;
    await writeFile(join(directory, filename), PNG.sync.write(png));
    manifest.variants[variant] = { filename, missing: omit, recovered: expected.length,
      rgbaSha256: createHash('sha256').update(image.data).digest('hex') };
  }
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  console.log(JSON.stringify({ variants: Object.keys(manifest.variants), width: original.width, height: original.height }));
} finally {
  await server.close();
}
