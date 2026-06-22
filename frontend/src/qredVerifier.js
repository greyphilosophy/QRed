import { verifyAsync as verifyEd25519 } from "@noble/ed25519";
import pako from "pako";

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function decodeSeal(sealString) {
  const parts = sealString.split("|");
  if (parts.length < 5) return null;
  const [formatId, documentId, chunkNumberText, totalChunksText] = parts;
  const data = parts.slice(4).join("|");
  if (!formatId.startsWith("QRED")) return null;

  const chunkNumber = Number.parseInt(chunkNumberText, 10);
  const totalChunks = Number.parseInt(totalChunksText, 10);
  if (!Number.isInteger(chunkNumber) || !Number.isInteger(totalChunks)) return null;

  return {
    format_id: formatId,
    document_id: documentId,
    chunk_number: chunkNumber,
    total_chunks: totalChunks,
    data,
  };
}

export async function verifyQRedSeals(seals, publicKey) {
  const context = { chunks: {}, document_id: "", total_chunks: 0, errors: [] };

  for (const seal of seals) {
    const decoded = decodeSeal(seal);
    if (!decoded) {
      context.errors.push(`Malformed seal: ${seal.slice(0, 50)}`);
      continue;
    }

    if (context.document_id && decoded.document_id !== context.document_id) {
      return {
        status: "INVALID",
        document_id: context.document_id,
        error_message: "Mixed document IDs",
      };
    }

    if (!context.document_id) context.document_id = decoded.document_id;
    context.total_chunks = decoded.total_chunks;
    context.chunks[decoded.chunk_number] = decoded.data;
  }

  const chunkNumbers = Object.keys(context.chunks).map(Number);
  if (chunkNumbers.length === 0) {
    return { status: "ERROR", error_message: "No valid chunks found" };
  }

  const missing = [];
  for (let i = 0; i < context.total_chunks; i += 1) {
    if (!(i in context.chunks)) missing.push(i);
  }
  if (missing.length > 0) {
    return {
      status: "INCOMPLETE",
      document_id: context.document_id,
      error_message: `Missing chunks: [${missing.join(", ")}]`,
    };
  }

  let payload;
  try {
    const rawData = Array.from({ length: context.total_chunks }, (_, i) => context.chunks[i]).join("");
    const compressed = decodeBase64Url(rawData);
    const payloadJson = pako.ungzip(compressed, { to: "string" });
    payload = JSON.parse(payloadJson);
  } catch (error) {
    return { status: "ERROR", error_message: `Decompression failed: ${error.message}` };
  }

  const content = payload.content || "";
  const signature = payload.signature || "";
  const issuer = payload.issuer || "";
  const documentId = payload.document_id || "";
  const timestamp = payload.timestamp || "";
  const keyId = payload.key_id || "";

  if (!publicKey) {
    return {
      status: "ERROR",
      document_id: documentId,
      issuer,
      key_id: keyId,
      error_message: "No trusted public key available for verification",
    };
  }

  let isValid;
  try {
    const message = new TextEncoder().encode(content);
    isValid = await verifyEd25519(decodeBase64Url(signature), message, decodeBase64Url(publicKey));
  } catch {
    isValid = false;
  }

  if (isValid) {
    return {
      status: "VALID",
      issuer,
      document_id: documentId,
      timestamp,
      content,
      key_id: keyId,
    };
  }

  return {
    status: "INVALID",
    issuer,
    document_id: documentId,
    error_message: "Digital signature verification failed",
    content,
    key_id: keyId,
  };
}
