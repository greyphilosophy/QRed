import { verifyAsync as verifyEd25519 } from "@noble/ed25519";
import { decodeB45ish } from "./textRecipes.js";

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
    recipe: params.get("rc") || "plaintext",
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

  return null;
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
    if (decoded.recipe !== undefined) {
      context.plaintext = true;
      context.metadata = { ...context.metadata, recipe: decoded.recipe };
    }
    if (decoded.recipe !== undefined || decoded.algorithm) {
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
        recipe: context.metadata.recipe || "plaintext",
      };
    } else {
      return { status: "ERROR", error_message: "Unsupported seal format" };
    }
  } catch (error) {
    return { status: "ERROR", error_message: `Payload decoding failed: ${error.message}` };
  }

  const content = payload.content || "";
  const recipe = payload.recipe || "plaintext";
  const recipeDecoders = {
    b45: decodeB45ish,
    base45ish: decodeB45ish,
    recipe1: decodeB45ish,
    simple_english: decodeB45ish,
  };
  const restoredContent = (recipeDecoders[recipe] || ((value) => value))(content);
  const signature = payload.signature || "";
  const issuer = payload.issuer || "";
  const documentId = payload.document_id || "";
  const timestamp = payload.timestamp || "";
  const keyId = payload.key_id || "";

  if (!publicKey) {
    return {
      status: "UNVERIFIED",
      document_id: documentId,
      issuer,
      timestamp,
      content: restoredContent,
      recipe,
      key_id: keyId,
      error_message: "No trusted public key available for signature verification",
    };
  }

  let isValid;
  try {
    const message = new TextEncoder().encode(restoredContent);
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
      content: restoredContent,
      recipe,
      key_id: keyId,
    };
  }

  return {
    status: "INVALID",
    issuer,
    document_id: documentId,
    error_message: "Digital signature verification failed",
    content: restoredContent,
    recipe,
    key_id: keyId,
  };
}

export function tokenizeDocumentText(text) {
  return (text || "").match(/\S+|\s+/g) || [];
}

function comparableToken(token) {
  return token.trim().toLocaleLowerCase().replace(/^\p{P}+|\p{P}+$/gu, "");
}

export function compareWordSequences(qrWords, pageWords) {
  const qrItems = qrWords.map((word, index) => ({ word, index, key: comparableToken(word) })).filter((item) => item.key);
  const pageItems = pageWords.map((word, index) => ({ word, index, key: comparableToken(word) })).filter((item) => item.key);

  const table = Array.from({ length: qrItems.length + 1 }, () => Array(pageItems.length + 1).fill(0));
  for (let i = qrItems.length - 1; i >= 0; i -= 1) {
    for (let j = pageItems.length - 1; j >= 0; j -= 1) {
      table[i][j] = qrItems[i].key === pageItems[j].key
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const matchedQr = new Set();
  const matchedPage = new Set();
  let i = 0;
  let j = 0;
  while (i < qrItems.length && j < pageItems.length) {
    if (qrItems[i].key === pageItems[j].key) {
      matchedQr.add(qrItems[i].index);
      matchedPage.add(pageItems[j].index);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }

  return {
    matchedQr,
    matchedPage,
    matchedWords: matchedQr.size,
    missingWords: qrItems.length - matchedQr.size,
    extraWords: pageItems.length - matchedPage.size,
    missingQrWords: qrItems.filter((item) => !matchedQr.has(item.index)).map((item) => item.word),
  };
}

export function compareDocumentText(qrText, pageText) {
  const qrTokens = tokenizeDocumentText(qrText);
  const pageTokens = tokenizeDocumentText(pageText);
  const comparison = compareWordSequences(qrTokens, pageTokens);

  return {
    qrTokens: qrTokens.map((token, index) => ({ token, status: comparableToken(token) ? (comparison.matchedQr.has(index) ? "matched" : "missing") : "space" })),
    pageTokens: pageTokens.map((token, index) => ({ token, status: comparableToken(token) ? (comparison.matchedPage.has(index) ? "matched" : "extra") : "space" })),
    matchedWords: comparison.matchedWords,
    missingWords: comparison.missingWords,
    extraWords: comparison.extraWords,
  };
}
