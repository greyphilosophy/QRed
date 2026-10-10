import { signAsync as signEd25519, getPublicKeyAsync } from "@noble/ed25519";
import { createQRedQrData } from "./qredQr.js";
import { validateSimpleEnglish } from "./textRecipes.js";
import { computeKeyId, decodeBase64Url, sealSignatureMessage } from "./sealSignature.js";

export { computeKeyId } from "./sealSignature.js";

export const DEFAULT_BOOTSTRAP_URL = "https://qred.org/";

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fragmentBase(bootstrapUrl) {
  const base = bootstrapUrl || DEFAULT_BOOTSTRAP_URL;
  return base.includes("#") ? base.slice(0, base.indexOf("#")) : base;
}

function buildFragmentData({ payload, chunkText, chunkNumber, totalChunks, recipeId = "plaintext" }) {
  const params = new URLSearchParams();
  params.set("v", payload.version);
  params.set("alg", payload.algorithm);
  params.set("doc", payload.document_id);
  params.set("i", String(chunkNumber));
  params.set("n", String(totalChunks));
  params.set("iss", payload.issuer);
  params.set("kid", payload.key_id);
  params.set("ts", payload.timestamp);
  if (recipeId && recipeId !== "plaintext") params.set("rc", recipeId);
  else if (payload.recipe && payload.recipe !== "plaintext") params.set("rc", payload.recipe);
  if (chunkNumber === 0) params.set("sig", payload.signature);
  params.set("txt", chunkText);
  return `QRED1?${params.toString()}`;
}

function buildFragmentUrl(bootstrapUrl, fragmentData) {
  return `${fragmentBase(bootstrapUrl)}#${fragmentData}`;
}

function fragmentFitsQr(bootstrapUrl, fragmentData) {
  try {
    createQRedQrData(buildFragmentUrl(bootstrapUrl, fragmentData));
    return true;
  } catch {
    return false;
  }
}

function splitTextForQrUrls(text, payload, bootstrapUrl, recipeId = "plaintext") {
  if (!text) {
    return [""];
  }

  let totalChunks = 1;
  // Split on Unicode code points; cutting a surrogate pair changes the signed
  // text when URLSearchParams replaces each lone surrogate with U+FFFD.
  const characters = Array.from(text);
  let chunks = [];
  let stable = false;

  while (!stable) {
    chunks = [];
    let offset = 0;
    while (offset < characters.length) {
      let low = 1;
      let high = characters.length - offset;
      let best = 0;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const chunkText = characters.slice(offset, offset + mid).join("");
        const fragmentData = buildFragmentData({
          payload,
          chunkText,
          chunkNumber: chunks.length,
          totalChunks,
          recipeId,
        });
        if (fragmentFitsQr(bootstrapUrl, fragmentData)) {
          best = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      if (best === 0) {
        throw new Error("QRed metadata and signature exceed the QR code capacity before adding document text");
      }
      chunks.push(characters.slice(offset, offset + best).join(""));
      if (chunks.length > 4096) throw new Error("Document exceeds the 4096-seal limit");
      offset += best;
    }
    stable = chunks.length === totalChunks;
    totalChunks = chunks.length;
  }

  return chunks.map((chunkText, index) => buildFragmentUrl(
    bootstrapUrl,
    buildFragmentData({ payload, chunkText, chunkNumber: index, totalChunks: chunks.length, recipeId }),
  ));
}

export function canonicalizeText(text) {
  const collapsed = [];
  let previousEmpty = false;
  for (const line of text.split("\n").map((item) => item.trimEnd())) {
    if (!line) {
      if (!previousEmpty) collapsed.push(line);
      previousEmpty = true;
    } else {
      collapsed.push(line);
      previousEmpty = false;
    }
  }
  while (collapsed.length > 0 && !collapsed[0]) collapsed.shift();
  while (collapsed.length > 0 && !collapsed[collapsed.length - 1]) collapsed.pop();
  return collapsed.join("\n");
}

export function generateDocumentId() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `DOC-${bytesToHex(bytes).toUpperCase()}`;
}

function buildPayload(baseFields, content, recipe = "plaintext") {
  return { ...baseFields, content, recipe };
}

function candidateReport(encoding, qrCount, reversible, diagnostics, recipeId = "") {
  return { encoding, qr_count: qrCount, reversible, diagnostics, recipe_id: recipeId };
}

function selectCandidate(candidates, preferred = "automatic") {
  const selectable = candidates.filter((candidate) => candidate.reversible);
  if (selectable.length === 0) return candidates[0];

  const aliases = {
    base45ish: "b45",
    b45: "b45",
    recipe1: "b45",
    simple_english: "b45",
  };
  const normalizedPreferred = aliases[preferred] || preferred;

  const preferredCandidate = candidates.find((candidate) => candidate.encoding === normalizedPreferred || candidate.recipe === normalizedPreferred);
  if (preferredCandidate && preferredCandidate.reversible) return preferredCandidate;

  if (preferred === "plaintext") {
    return candidates.find((candidate) => candidate.encoding === "plaintext");
  }
  return selectable
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => (a.candidate.qr_count - b.candidate.qr_count) || (a.index - b.index))[0].candidate;
}

export async function createQRedSeals({
  content,
  issuer,
  privateKey,
  publicKey,
  documentId = generateDocumentId(),
  bootstrapUrl = DEFAULT_BOOTSTRAP_URL,
  encodingStrategy = "automatic",
}) {
  const canonical = canonicalizeText(content);
  if (!canonical.trim()) throw new Error("Cannot seal empty document text");
  if (!issuer?.trim()) throw new Error("An issuer is required");
  if (!["automatic", "plaintext", "b45", "base45ish", "recipe1", "simple_english"].includes(encodingStrategy)) {
    throw new Error(`Unsupported encoding strategy: ${encodingStrategy}`);
  }
  if (!documentId) documentId = generateDocumentId();
  const privateBytes = decodeBase64Url(privateKey);
  const publicBytes = decodeBase64Url(publicKey);
  const derivedPublicKey = await getPublicKeyAsync(privateBytes);
  if (publicBytes.length !== derivedPublicKey.length || publicBytes.some((byte, index) => byte !== derivedPublicKey[index])) {
    throw new Error("The public key does not match the private key");
  }
  const keyId = await computeKeyId(publicKey);
  const baseFields = {
    algorithm: "Ed25519",
    document_id: documentId,
    issuer,
    key_id: keyId,
    timestamp: new Date().toISOString(),
    version: "2",
  };
  baseFields.signature = encodeBase64Url(await signEd25519(sealSignatureMessage(baseFields, canonical), privateBytes));

  const plaintextPayload = buildPayload(baseFields, canonical, "plaintext");
  const plaintextJson = JSON.stringify(plaintextPayload, Object.keys(plaintextPayload).sort());
  const plaintextUrls = splitTextForQrUrls(canonical, plaintextPayload, bootstrapUrl, "plaintext");
  const plaintextReport = candidateReport("plaintext", plaintextUrls.length, true, []);

  const recipeResult = validateSimpleEnglish(canonical);
  const recipeReport = candidateReport("b45", 0, recipeResult.reversible, recipeResult.diagnostics, recipeResult.recipe_id);
  let recipeUrls = [];
  let recipeJson = "";
  if (recipeResult.reversible) {
    const recipePayload = buildPayload(baseFields, recipeResult.compact, recipeResult.recipe_id);
    recipeUrls = splitTextForQrUrls(recipeResult.compact, recipePayload, bootstrapUrl, recipeResult.recipe_id);
    recipeReport.qr_count = recipeUrls.length;
    recipeJson = JSON.stringify(recipePayload, Object.keys(recipePayload).sort());
  }

  const candidates = [
    { encoding: "plaintext", strings: plaintextUrls, payload_json: plaintextJson, recipe: "plaintext", ...plaintextReport },
  ];
  if (recipeResult.reversible) {
    candidates.splice(1, 0, { encoding: "b45", strings: recipeUrls, payload_json: recipeJson, recipe: recipeResult.recipe_id, ...recipeReport });
  }
  const selected = selectCandidate(candidates, encodingStrategy);
  const seals = selected.strings;

  return {
    bootstrap_url: fragmentBase(bootstrapUrl),
    document_id: documentId,
    issuer,
    key_id: keyId,
    payload_json: selected.payload_json,
    seals,
    total_seals: seals.length,
    encoding: selected.encoding,
    encoding_strategy: encodingStrategy,
    selected_recipe: selected.recipe,
    estimated_qr_count: selected.qr_count,
    compression_savings_pct: plaintextUrls.length > selected.qr_count ? Math.round(((plaintextUrls.length - selected.qr_count) / plaintextUrls.length) * 100) : 0,
    candidate_reports: candidates.map(({ encoding, qr_count, reversible, diagnostics, recipe_id }) => ({ encoding, qr_count, reversible, diagnostics, recipe_id })),
  };
}
