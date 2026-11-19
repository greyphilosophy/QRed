function capabilities(track) {
  try { return track?.getCapabilities?.() || {}; } catch { return {}; }
}

// Capability lists can arrive only after the camera starts streaming. Use a
// muted, detached video to let the driver start, without displaying a different
// lens or asking it to turn on a light. The caller continues to own the stream.
export async function inspectCameraCapabilities(stream, signal, timeoutMs = 500) {
  signal?.throwIfAborted();
  const track = stream?.getVideoTracks?.()[0];
  const initial = capabilities(track);
  if (track?.kind !== "video" || typeof track.getCapabilities !== "function" ||
      !globalThis.document?.createElement || timeoutMs <= 0) return initial;
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  let timer, finish;
  try {
    await new Promise(resolve => {
      finish = resolve;
      video.addEventListener("loadeddata", finish, { once: true });
      video.addEventListener("error", finish, { once: true });
      signal?.addEventListener("abort", finish, { once: true });
      timer = setTimeout(finish, timeoutMs);
      video.srcObject = stream;
      try { video.play()?.catch(finish); } catch { finish(); }
      if (video.readyState >= 2 || signal?.aborted) finish();
    });
    signal?.throwIfAborted();
    return { ...initial, ...capabilities(track) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", finish);
    video.removeEventListener("loadeddata", finish);
    video.removeEventListener("error", finish);
    video.pause();
    video.srcObject = null;
  }
}

// An optional lens must not hold startup indefinitely. getUserMedia itself
// cannot be cancelled, so stop any stream granted after timeout or close.
export function requestInspectionStream(request, signal, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    let settled = false, timer;
    const abort = () => finish(signal.reason);
    function finish(error, stream) {
      if (settled) { stream?.getTracks().forEach(track => track.stop()); return; }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(stream);
    }
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => finish(new DOMException("Camera inspection timed out", "TimeoutError")), timeoutMs);
    try { Promise.resolve(request()).then(stream => finish(null, stream), error => finish(error)); }
    catch (error) { finish(error); }
  });
}
