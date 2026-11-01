# QRed Mobile Optimization Plan

## Current State
As of November 2026, both scanner pages prefer the rear main camera at 1× with a 1920×1080 ideal frame. Unknown camera labels retain the browser's environment-camera choice. The flashlight control has been removed. Full-page watermarks need the entire frame; the older center-crop and lower-resolution proposals below should not be applied to manual page captures.

Manual camera photos and selected images use a background worker for exhaustive recovery. The page shows a reading status and supports cancellation (close the camera or cancel the selected photo). The worker receives transferred pixels, preserves all recovered page chunks, and terminates on completion or cancellation. Its public code is prepared for offline use through the existing service worker; photographs stay on the device. Live scanning retains bounded attempts between frames. Physical lens selection still needs testing on supported phones because camera labels and controls vary by browser.

Photo recovery now tries the existing watermark filter once at a maximum of 2.5 MP before exhaustive page alignment. Only a complete single-code QRed seal can finish this first attempt; navigation codes and multipart pages continue through full page recovery. The original-resolution pixels remain available to the existing fallbacks, and the normal verification session still checks the signature.

The audit and phases below record the earlier optimization plan, not a current inventory of missing features.

## Findings from Codebase Audit

### Already Good
- Camera-based QR scanner with hidden payload recovery ✅
- Rear main camera selection at 1× ✅
- Responsive, cancellable photo recovery ✅
- Browser-side Ed25519 verification ✅
- Multiple encoding strategies (plaintext and gzip) ✅
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
- Camera quality controls (1× zoom, continuous focus, exposure and white balance) — already implemented
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
