// OCR capture + AR overlay canvas drawing helpers
// These are shared building blocks so both verifier.html and React can use
// the same efficient, offline-capable implementation.

export function captureDocumentFrameForOcr({
  facingMode = "environment",
  widthIdeal = 1600,
  heightIdeal = 1200,
  waitMs = 800,
  getUserMedia = typeof navigator !== "undefined"?.mediaDevices?.getUserMedia
    ? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    : null,
} = {}) {
  if (typeof document === "undefined") {
    return Promise.reject(new Error("captureDocumentFrameForOcr: document is not available"));
  }
  if (!getUserMedia) {
    return Promise.reject(new Error("captureDocumentFrameForOcr: navigator.mediaDevices.getUserMedia not available"));
  }

  return getUserMedia({
    video: {
      facingMode,
      width: { ideal: widthIdeal },
      height: { ideal: heightIdeal },
    },
  }).then((mediaStream) => {
    return new Promise((resolve, reject) => {
      const video = document.createElement("video");
      video.playsInline = true;
      video.muted = true;
      video.srcObject = mediaStream;
      video.onloadedmetadata = () => {
        video
          .play()
          .then(() => {
            window.setTimeout(() => {
              try {
                const canvas = document.createElement("canvas");
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                const ctx = canvas.getContext("2d");
                if (!ctx) throw new Error("No 2D canvas context");
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                mediaStream.getTracks().forEach((track) => track.stop());
                resolve(canvas);
              } catch (e) {
                mediaStream.getTracks().forEach((track) => track.stop());
                reject(e);
              }
            }, waitMs);
          })
          .catch(reject);
      };

      video.onerror = () => {
        try {
          mediaStream.getTracks().forEach((track) => track.stop());
        } catch {
          // ignore
        }
        reject(new Error("Unable to read camera frame for OCR."));
      };
    }).catch((error) => {
      try {
        mediaStream.getTracks().forEach((track) => track.stop());
      } catch {
        // ignore
      }
      throw error;
    });
  });
}

export function drawArOverlay(canvas, classified) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const words = classified?.words || [];
  words.forEach((item) => {
    const bbox = item?.word?.bbox;
    if (!bbox) return;

    const color = item.status === "matched" ? "rgba(187, 247, 208, 0.55)" : "rgba(254, 202, 202, 0.6)";
    ctx.fillStyle = color;
    ctx.strokeStyle =
      item.status === "matched" ? "rgba(22, 163, 74, 0.95)" : "rgba(220, 38, 38, 0.95)";
    ctx.lineWidth = 2;
    ctx.fillRect(bbox.x0, bbox.y0, bbox.x1 - bbox.x0, bbox.y1 - bbox.y0);
    ctx.strokeRect(bbox.x0, bbox.y0, bbox.x1 - bbox.x0, bbox.y1 - bbox.y0);
  });

  const missing = classified?.missing || [];
  if (missing.length > 0) {
    const missingText =
      "Missing from page: " +
      missing.slice(0, 12).join(" ") +
      (missing.length > 12 ? " ..." : "");

    ctx.font = "24px sans-serif";
    ctx.textBaseline = "top";
    const metrics = ctx.measureText(missingText);
    ctx.fillStyle = "rgba(15, 23, 42, 0.82)";
    ctx.fillRect(12, 12, metrics.width + 24, 44);
    ctx.fillStyle = "#ef4444";
    ctx.fillText(missingText, 24, 22);
  }
}
