(() => {
  return new Promise(async (resolve) => {
    try {
      const pkInput = document.getElementById("publicKeyInput");
      if (pkInput) {
        pkInput.value = PUBLIC_KEY_PLACEHOLDER;
        pkInput.dispatchEvent(new Event("input", { bubbles: true }));
        pkInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const sealText = String(SEAL_PAYLOAD_PLACEHOLDER);
      const lines = sealText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      lines.forEach(line => {
        if (typeof processScannedSeal === "function") {
          processScannedSeal(line);
        }
      });
      const docIds = Object.keys(state && state.sealsByDocument ? state.sealsByDocument : {});
      if (docIds.length === 0) {
        resolve({ error: "No seals were processed." });
        return;
      }
      if (typeof reconstructAndShow === "function") {
        reconstructAndShow(docIds[0])
          .then(r => resolve(r))
          .catch(e => resolve({ error: e.message }));
        return;
      }
      resolve({ error: "reconstructAndShow not found" });
    } catch (e) {
      resolve({ error: e.message });
    }
  });
})()