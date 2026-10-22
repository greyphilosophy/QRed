(async () => {
  try {
    const seals = String("SEAL_PAYLOAD_PLACEHOLDER").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const result = await window.__qredTestVerify(seals, "PUBLIC_KEY_PLACEHOLDER");
    return result.status;
  } catch (error) {
    return { error: error.message };
  }
})()
