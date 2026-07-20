(() => {
  return new Promise(async (resolve) => {
    try {
      const pkInput = document.getElementById("publicKeyInput");
      if (pkInput) {
        pkInput.value = "PUBLIC_KEY_PLACEHOLDER";
        pkInput.dispatchEvent(new Event("input", { bubbles: true }));
        pkInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const sealText = String("SEAL_PAYLOAD_PLACEHOLDER");
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
        await reconstructAndShow(docIds[0]);
      }
      // Poll until #resultStatus has content
      for (let i = 0; i < 60 && i < 30000; i++) {
        const rs = document.getElementById("resultStatus");
        if (rs && rs.textContent && rs.textContent.trim()) {
          resolve(rs.textContent.trim());
          return;
        }
        await new Promise(r => setTimeout(r, 500));
      }
      resolve({ error: "Result status never populated" });
    } catch (e) {
      resolve({ error: e.message });
    }
  });
})()