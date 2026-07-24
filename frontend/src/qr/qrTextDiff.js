// Text comparison utilities — tokenization + LCS for OCR overlay diff highlighting

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
