// One owner for a camera stream and its decode loop. Stop is safe while
// permissions, camera controls or video playback are still pending.
export function startCameraSession({ video, requestStream, prepareStream, onStream,
  onFrame, onError, waitForMetadata = false, interval = 125 }) {
  let stopped = false;
  let stream = null;
  let animation = null;
  let started = false;
  let lastScanAt = -Infinity;

  function stop() {
    if (stopped) return;
    stopped = true;
    if (animation !== null) cancelAnimationFrame(animation);
    if (video.onloadedmetadata === startFrames) video.onloadedmetadata = null;
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      if (video.srcObject === stream) video.srcObject = null;
      stream = null;
      onStream?.(null);
    }
  }

  function fail(error, stage) {
    if (stopped) return;
    stop();
    onError(error, stage);
  }

  function tick() {
    if (stopped) return;
    if (performance.now() - lastScanAt >= interval) {
      try { onFrame(); } catch (error) { fail(error, "frame"); return; }
      // Count from completion so expensive decoding still yields to input.
      lastScanAt = performance.now();
    }
    if (!stopped) animation = requestAnimationFrame(tick);
  }

  function startFrames() {
    if (stopped || started) return;
    started = true;
    tick();
  }

  Promise.resolve().then(requestStream).then(async acquired => {
    if (stopped) { acquired.getTracks().forEach(track => track.stop()); return; }
    stream = acquired;
    onStream?.(stream);
    await prepareStream?.(stream);
    if (stopped) return;
    if (waitForMetadata) video.onloadedmetadata = startFrames;
    video.srcObject = stream;
    try {
      const playing = video.play();
      playing?.catch(error => fail(error, "play"));
    } catch (error) { fail(error, "play"); return; }
    if (!waitForMetadata || video.readyState >= 1) startFrames();
  }).catch(error => fail(error, "access"));

  return { stop };
}
