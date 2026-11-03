import "./pageScanGuide.css";

// Fixed US Letter corners for manual alignment. Detection must never move them.
// Decoding and retained photographs always use the entire original frame.
// Keep the guide inside the actual object-fit: contain image, not its letterbox.
export function observePageScanGuide(video, area, guide) {
  function update() {
    const view = video.getBoundingClientRect(), available = area.getBoundingClientRect();
    if (!video.videoWidth || !video.videoHeight || !view.width || !view.height) {
      guide.hidden = true;
      return;
    }
    const scale = Math.min(view.width / video.videoWidth, view.height / video.videoHeight);
    const imageWidth = video.videoWidth * scale, imageHeight = video.videoHeight * scale;
    const imageLeft = view.left + (view.width - imageWidth) / 2;
    const imageTop = view.top + (view.height - imageHeight) / 2;
    // Leave some visible background around the paper for edge detection.
    const margin = Math.min(imageWidth, imageHeight) * 0.04;
    const left = Math.max(available.left, imageLeft + margin), top = Math.max(available.top, imageTop + margin);
    const right = Math.min(available.right, imageLeft + imageWidth - margin);
    const bottom = Math.min(available.bottom, imageTop + imageHeight - margin);
    const ratio = 8.5 / 11;
    const width = Math.max(0, Math.min(right - left, (bottom - top) * ratio));
    const height = width / ratio;
    guide.hidden = !width || !height;
    Object.assign(guide.style, {
      left: `${left - available.left + (right - left - width) / 2}px`,
      top: `${top - available.top + (bottom - top - height) / 2}px`,
      width: `${width}px`, height: `${height}px`,
    });
  }
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
  observer?.observe(video);
  observer?.observe(area);
  video.addEventListener("loadedmetadata", update);
  video.addEventListener("resize", update);
  window.addEventListener("resize", update);
  update();
  const stop = () => {
    observer?.disconnect();
    video.removeEventListener("loadedmetadata", update);
    video.removeEventListener("resize", update);
    window.removeEventListener("resize", update);
  };
  return stop;
}
