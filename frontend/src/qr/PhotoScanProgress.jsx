import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { CAMERA_CAPTURED_NOTICE, createPhotoScanProgress, photoScanTiming } from "./photoScanProgress.js";
import "./photoScanProgress.css";

export function usePhotoScanProgress() {
  const [progress] = useState(createPhotoScanProgress);
  useEffect(() => () => progress.clear(), [progress]);
  return progress;
}

export function CameraCaptureNotice({ progress }) {
  const notice = useRef(null);
  const getPhase = () => progress.getSnapshot()?.phase;
  const phase = useSyncExternalStore(progress.subscribe, getPhase, getPhase);
  const captured = phase === "captured";
  useEffect(() => {
    if (captured) notice.current?.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: "instant" });
  }, [captured]);
  return <p ref={notice} className="camera-capture-notice" role="status" aria-atomic="true"
    data-hide-guide={phase && phase !== "capturing" ? "" : undefined}>{captured ? CAMERA_CAPTURED_NOTICE : ""}</p>;
}

export function PhotoScanProgress({ progress }) {
  const snapshot = useSyncExternalStore(progress.subscribe, progress.getSnapshot);
  if (!snapshot) return null;
  return <div className="photo-scan-progress">
    <p className="photo-scan-step" role="status" aria-live="polite">{snapshot.label}</p>
    <p className="photo-scan-timing" role="timer" aria-live="off">{photoScanTiming(snapshot)}</p>
    <progress aria-label="Photo seal scan" />
  </div>;
}
