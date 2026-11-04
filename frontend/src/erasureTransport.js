// Experimental QRE3/QRE4 transport, version 1, scheme 1. The signed QRS
// envelope is unchanged. Transport fields are not independently authenticated:
// a full SHA-256 check and the ordinary envelope signature are still required.
export const ERASURE_HEADER_BYTES = 48;
export const MAX_ERASURE_SHARDS = 16;
const MAX_PAYLOAD = 2953;
const MAX_SHARD_BYTES = MAX_PAYLOAD - ERASURE_HEADER_BYTES;
const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const digest = async bytes => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
export const isErasureBytes = bytes => bytes[0] === 81 && bytes[1] === 82 && bytes[2] === 69 && [51, 52].includes(bytes[3]);

function parameters(k, n, length, size) {
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 2 || n <= k || n > MAX_ERASURE_SHARDS ||
      !Number.isInteger(length) || length < 86 || length > k * MAX_SHARD_BYTES ||
      size !== Math.ceil(length / k)) throw new Error("Invalid erasure transport parameters");
}
export function decodeErasureChunk(bytes) {
  if (!isErasureBytes(bytes) || bytes.length <= ERASURE_HEADER_BYTES || bytes.length > MAX_PAYLOAD)
    throw new Error("Invalid erasure transport length");
  if (bytes[4] !== 1 || bytes[5] !== 1 || bytes[9] !== 0) throw new Error("Unsupported erasure transport scheme");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const k = bytes[6], n = bytes[7], index = bytes[8], length = view.getUint32(10), size = view.getUint16(14);
  parameters(k, n, length, size);
  if (index >= n || bytes.length !== ERASURE_HEADER_BYTES + size) throw new Error("Invalid erasure shard index or size");
  const hash = bytes.slice(16, 48), version = String.fromCharCode(bytes[3]);
  return { format_id: `QRED${version}`, version, multipart: true, erasure: true,
    transport_version: 1, erasure_scheme: 1, required_chunks: k, total_chunks: n, chunk_number: index,
    record_length: length, shard_length: size, digest: hash,
    document_id: `E1-${version}-${k}-${n}-${length}-${hex(hash)}`, data: bytes.slice(48), bytes };
}

// GF(256), primitive polynomial x^8+x^4+x^3+x^2+1 (0x11d).
function multiply(a, b) {
  let result = 0;
  while (b) { if (b & 1) result ^= a; a <<= 1; if (a & 256) a ^= 0x11d; b >>= 1; }
  return result;
}
function power(a, n) { let result = 1; while (n--) result = multiply(result, a); return result; }
function inverse(a) { if (!a) throw new Error("Singular erasure matrix"); return power(a, 254); }
function invert(matrix) {
  const n = matrix.length, rows = matrix.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => Number(i === j))]);
  for (let i = 0; i < n; i++) {
    let pivot = i;
    while (pivot < n && !rows[pivot][i]) pivot++;
    if (pivot === n) throw new Error("Singular erasure matrix");
    [rows[pivot], rows[i]] = [rows[i], rows[pivot]];
    const scale = inverse(rows[i][i]);
    rows[i] = rows[i].map(value => multiply(value, scale));
    for (let j = 0; j < n; j++) if (j !== i) {
      const factor = rows[j][i];
      rows[j] = rows[j].map((value, c) => value ^ multiply(factor, rows[i][c]));
    }
  }
  return rows.map(row => row.slice(n));
}
function shardData(record, k, size, index) {
  const data = new Uint8Array(size), x = index + 1;
  for (let column = 0, coefficient = 1; column < k; column++, coefficient = multiply(coefficient, x)) {
    for (let j = 0; j < size; j++) data[j] ^= multiply(coefficient, record[column * size + j] || 0);
  }
  return data;
}
export async function encodeErasureChunks(record, { required = 12, total = 16 } = {}) {
  const size = Math.ceil(record.length / required);
  parameters(required, total, record.length, size);
  if (record[0] !== 81 || record[1] !== 82 || record[2] !== 83 || ![51, 52].includes(record[3]))
    throw new Error("Erasure transport requires a signed envelope");
  const hash = await digest(record);
  return Array.from({ length: total }, (_, index) => {
    const bytes = new Uint8Array(ERASURE_HEADER_BYTES + size), view = new DataView(bytes.buffer);
    bytes.set([81, 82, 69, record[3], 1, 1, required, total, index, 0]);
    view.setUint32(10, record.length); view.setUint16(14, size); bytes.set(hash, 16);
    bytes.set(shardData(record, required, size, index), ERASURE_HEADER_BYTES);
    return bytes;
  });
}
export async function recoverErasureRecord(chunks) {
  // Accept raw bytes only, revalidate at this trust boundary, and bound input
  // before parsing/allocating. Callers deduplicate exact repeated observations.
  if (!Array.isArray(chunks) || !chunks.length || chunks.length > MAX_ERASURE_SHARDS)
    throw new Error("Invalid erasure shard collection size");
  const records = chunks.map(decodeErasureChunk), first = records[0], indexes = new Set();
  for (const record of records) {
    if (record.document_id !== first.document_id || indexes.has(record.chunk_number))
      throw new Error("Mixed or duplicate erasure shards");
    indexes.add(record.chunk_number);
  }
  const k = first.required_chunks, size = first.shard_length;
  if (records.length < k) throw new Error("Insufficient erasure shards");
  records.sort((a, b) => a.chunk_number - b.chunk_number);
  const selected = records.slice(0, k), matrix = invert(selected.map(r => Array.from({ length: k }, (_, c) => power(r.chunk_number + 1, c))));
  const padded = new Uint8Array(size * k);
  for (let c = 0; c < k; c++) for (let j = 0; j < size; j++) for (let i = 0; i < k; i++)
    padded[c * size + j] ^= multiply(matrix[c][i], selected[i].data[j]);
  if (padded.subarray(first.record_length).some(Boolean)) throw new Error("Invalid erasure padding");
  const record = padded.slice(0, first.record_length);
  if (!equal(await digest(record), first.digest)) throw new Error("Erasure envelope digest mismatch");
  // Never silently ignore a corrupt extra observation or search exponentially
  // for a favorable subset. Missing shards are tolerated, conflicting ink is not.
  for (const received of records) if (!equal(received.data, shardData(record, k, size, received.chunk_number)))
    throw new Error("Conflicting erasure parity");
  if (record[0] !== 81 || record[1] !== 82 || record[2] !== 83 || record[3] !== Number(first.version) + 48) throw new Error("Erasure envelope version mismatch");
  return record;
}
