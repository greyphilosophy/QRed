import { decodeSeal } from '{repo_root}/frontend/src/qredVerifier.js';

const seal = '{seal}';
const result = decodeSeal(seal);

if (!result) {
  console.log('ERROR:decodeSeal returned null');
  process.exit(1);
}

const checks = [
  ['format_id', result.format_id === 'QRED1'],
  ['document_id', result.document_id === '{document_id}'],
  ['chunk_number', result.chunk_number === {chunk_number}],
  ['total_chunks', result.total_chunks === {total_chunks}],
  ['data', result.data === '{data}'],
  ['algorithm', result.algorithm === 'Ed25519'],
  ['issuer', result.issuer === '{issuer}'],
  ['key_id', result.key_id === '{key_id}'],
  ['signature', result.signature === '{signature}'],
  ['timestamp', result.timestamp === '{timestamp}'],
  ['version', result.version === '{version}'],
];

let all_passed = true;
for (const [name, passed] of checks) {
  console.log('CHECK:' + name + ':' + (passed ? 'PASS' : 'FAIL'));
  if (!passed) all_passed = false;
}

if (all_passed) {
  console.log('ALL_PASSED');
} else {
  console.log('SOME_FAILED');
  process.exit(1);
}