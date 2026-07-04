# QRed Mobile Optimization Plan

## Current State
The QRed scanner is already production-grade with camera controls, hidden payload recovery, and browser-side Ed25519 verification. This plan targets **concrete mobile bottlenecks** identified through codebase audit.

## Findings from Codebase Audit

### Already Good
- Camera-based QR scanner with hidden payload recovery ✅
- Zoom/telephoto camera selection on mobile ✅
- Torch (flashlight) toggle ✅
- Browser-side Ed25519 verification ✅
- Multiple encoding strategies (plaintext, b45, brotli) ✅
- Responsive layout with CSS clamp() ✅

### Mobile Bottlenecks Found

1. **Full-frame decode on every camera frame** — `ctx.getImageData` + `jsQR` on the entire 1920×1080 video frame at 30fps drains mobile battery and CPU. No region-of-interest (ROI) cropping.

2. **No adaptive frame rate** — `requestAnimationFrame` fires every ~16ms regardless of whether a QR code was just found. No "cooldown" period after detection.

3. **Canvas resizes every frame** — `canvas.width !== video.videoWidth` check fires on every frame, triggering costly `drawImage` + `getImageData`.

4. **No service worker caching** — First scan on mobile loads ~120KB (React + jsQR + Ed25519) fresh each time. No offline-first strategy.

5. **No PWA manifest** — `standalone` mode on iOS/Android still has browser chrome.

6. **Camera always requests 1920×1080** — On mobile, the environment camera often only needs 720p for reliable QR decoding.

## Action Plan (In Priority Order)

### Phase 1: Scan Performance (Backend: QrScanner.jsx)
1. **Add ROI cropping** — Sample only center 50% of the frame for jsQR decode (QR codes are typically centered on mobile). Reduces `getImageData` cost by ~75%.
2. **Adaptive frame rate** — After a successful decode, pause scanning for 300ms (debounce). Reduce frame polling from 30fps to 15fps when idle.
3. **Cache canvas dimensions** — Only resize when video dimensions actually change (ref-based tracking).
4. **Lower ideal camera resolution** — Change `{ ideal: 1920 }` to `{ ideal: 1280, max: 1920 }` for better battery life on mobile.

### Phase 2: Bundle Size & Offline (frontend/)
5. **Add Web App Manifest** — `manifest.json` with icons and theme color for PWA install.
6. **Service worker with cache-first strategy** — Cache `index.html`, main bundle, jsQR, Ed25519. Offline scanner works after first visit.

### Phase 3: UX Polish
7. **Haptic feedback** — `navigator.vibrate(80)` on successful decode.
8. **Scan animation** — Subtle "found" pulse on the reticle when jsQR detects a code.

## Out of Scope (Already Covered)
- Camera quality controls (zoom, focus, torch) — already implemented
- Hidden payload recovery — already implemented
- Browser-side verification — already implemented
- Multiple encoding/compression strategies — already implemented
- Dark mode — already implemented

## Files to Modify
- `frontend/src/QrScanner.jsx` (Phase 1)
- `frontend/manifest.json` (new, Phase 2)
- `frontend/index.html` (add manifest link, Phase 2)
- `frontend/src/sw.js` (new, Phase 2)
- `frontend/vite.config.js` (SW registration, Phase 2)
