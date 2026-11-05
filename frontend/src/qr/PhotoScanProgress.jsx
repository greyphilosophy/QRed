import { useEffect, useState, useSyncExternalStore } from "react";
import { createPhotoScanProgress, photoScanTiming } from "./photoScanProgress.js";
import "./photoScanProgress.css";

export function usePhotoScanProgress() {
  const [progress] = useState(createPhotoScanProgress);
  useEffect(() => () => progress.clear(), [progress]);
  return progress;
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
