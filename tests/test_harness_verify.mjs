import { verifyQRedSeals } from '/tmp/QRed/frontend/src/qredVerifier.js';

const seals = {seals_json};
const publicKey = '{public_key}';

const result = await verifyQRedSeals(seals, publicKey);

if (result.status === 'VALID') {
  console.log('VERIFIED:Seal validation passed');
  console.log('VERIFIED:document_id=' + result.document_id);
  console.log('VERIFIED:content=' + (result.content || ''));
  console.log('ALL_PASSED');
} else if (result.status === 'INCOMPLETE') {
  console.log('INCOMPLETE:' + result.error_message);
  console.log('ALL_PASSED');
} else {
  console.log('ERROR:Unexpected status:' + result.status);
  console.log('ERROR:message:' + (result.error_message || 'none'));
  process.exit(1);
}