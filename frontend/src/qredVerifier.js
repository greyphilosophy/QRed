import { verifyAsync as verifyEd25519 } from "@noble/ed25519";
import pako from "pako";

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function sealFragment(sealString) {
  const hashIndex = sealString.indexOf("#");
  return hashIndex >= 0 ? sealString.slice(hashIndex + 1) : sealString;
}

export function extractSealsFromFragment(hash = window.location.hash) {
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!fragment) return [];
  const decodedFragment = decodeURIComponent(fragment);
  if (decodedFragment.startsWith("QRED1?")) return [decodedFragment];
  return decodedFragment.split(/\r?\n/).map((item) => item.trim()).filter((item) => item.startsWith("QRED"));
}

function decodePlaintextFragment(fragment) {
  if (!fragment.startsWith("QRED1?")) return null;
  const params = new URLSearchParams(fragment.slice("QRED1?".length));
  const chunkNumber = Number.parseInt(params.get("i") || "", 10);
  const totalChunks = Number.parseInt(params.get("n") || "", 10);
  const documentId = params.get("doc") || "";
  if (!documentId || !Number.isInteger(chunkNumber) || !Number.isInteger(totalChunks)) return null;

  return {
    format_id: "QRED1",
    document_id: documentId,
    chunk_number: chunkNumber,
    total_chunks: totalChunks,
    data: params.get("txt") || "",
    plaintext: true,
    algorithm: params.get("alg") || "Ed25519",
    issuer: params.get("iss") || "",
    key_id: params.get("kid") || "",
    signature: params.get("sig") || "",
    timestamp: params.get("ts") || "",
    version: params.get("v") || "1",
  };
}

export function decodeSeal(sealString) {
  const fragment = sealFragment(sealString);
  const plaintext = decodePlaintextFragment(fragment);
  if (plaintext) return plaintext;

  const parts = fragment.split("|");
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
  const context = { chunks: {}, document_id: "", total_chunks: 0, errors: [], plaintext: false, metadata: {} };

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
    if (decoded.plaintext) {
      context.plaintext = true;
      context.metadata = { ...context.metadata, ...Object.fromEntries(
        Object.entries({
          algorithm: decoded.algorithm,
          issuer: decoded.issuer,
          key_id: decoded.key_id,
          signature: decoded.signature,
          timestamp: decoded.timestamp,
          version: decoded.version,
        }).filter(([, value]) => value)
      ) };
    }
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
    if (context.plaintext) {
      payload = {
        algorithm: context.metadata.algorithm || "Ed25519",
        content: rawData,
        document_id: context.document_id,
        issuer: context.metadata.issuer || "",
        key_id: context.metadata.key_id || "",
        signature: context.metadata.signature || "",
        timestamp: context.metadata.timestamp || "",
        version: context.metadata.version || "1",
      };
    } else {
      const compressed = decodeBase64Url(rawData);
      const payloadJson = pako.ungzip(compressed, { to: "string" });
      payload = JSON.parse(payloadJson);
    }
  } catch (error) {
    return { status: "ERROR", error_message: `Payload decoding failed: ${error.message}` };
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


export function tokenizeDocumentText(text) {
  return (text || "").match(/\S+|\s+/g) || [];
}

function comparableToken(token) {
  return token.trim().toLocaleLowerCase().replace(/^\p{P}+|\p{P}+$/gu, "");
}

export function compareDocumentText(qrText, pageText) {
  const qrTokens = tokenizeDocumentText(qrText);
  const pageTokens = tokenizeDocumentText(pageText);
  const qrWords = qrTokens.map((token, index) => ({ token, index, key: comparableToken(token) })).filter((item) => item.key);
  const pageWords = pageTokens.map((token, index) => ({ token, index, key: comparableToken(token) })).filter((item) => item.key);

  const table = Array.from({ length: qrWords.length + 1 }, () => Array(pageWords.length + 1).fill(0));
  for (let i = qrWords.length - 1; i >= 0; i -= 1) {
    for (let j = pageWords.length - 1; j >= 0; j -= 1) {
      table[i][j] = qrWords[i].key === pageWords[j].key
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const matchedQr = new Set();
  const matchedPage = new Set();
  let i = 0;
  let j = 0;
  while (i < qrWords.length && j < pageWords.length) {
    if (qrWords[i].key === pageWords[j].key) {
      matchedQr.add(qrWords[i].index);
      matchedPage.add(pageWords[j].index);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }

  return {
    qrTokens: qrTokens.map((token, index) => ({ token, status: comparableToken(token) ? (matchedQr.has(index) ? "matched" : "missing") : "space" })),
    pageTokens: pageTokens.map((token, index) => ({ token, status: comparableToken(token) ? (matchedPage.has(index) ? "matched" : "extra") : "space" })),
    matchedWords: matchedQr.size,
    missingWords: qrWords.length - matchedQr.size,
    extraWords: pageWords.length - matchedPage.size,
  };
}
