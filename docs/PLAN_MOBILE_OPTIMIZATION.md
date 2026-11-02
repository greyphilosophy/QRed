# QRed Mobile Optimization Plan

## Current State
Current payload recovery reads ordinary QR byte segments. Retired hidden-padding
images require re-sealing; references to hidden recovery in the historical audit
below do not describe supported transport.

As of November 2026, both scanner pages prefer the rear main camera at 1× with a 1920×1080 ideal frame. Unknown camera labels retain the browser's environment-camera choice. The flashlight control has been removed. Full-page watermarks need the entire frame; the older center-crop and lower-resolution proposals below should not be applied to manual page captures.

Both live camera views decode in a background worker with one frame in flight and no queued frames. The submitted canvas stays unchanged until every recovered seal has been collected with its original photo. Closing the scanner terminates the worker; capturing a still photo first discards any pending live result. The public worker code is prepared for offline use through the existing service worker; photographs stay on the device. Physical lens selection still needs testing on supported phones because camera labels and controls vary by browser.

The **Capture photo** button and selected images use a separate worker for exhaustive recovery. The page shows a reading status. **Cancel and resume camera** discards the still-photo result and resumes live scanning on the same camera stream; selected images retain their cancel button. Still-photo workers terminate on completion or cancellation.

Photo recovery now tries the existing watermark filter once at a maximum of 2.5 MP before exhaustive page alignment. Only a complete single-code QRed seal can finish this first attempt; navigation codes and multipart pages continue through full page recovery. The original-resolution pixels remain available to the existing fallbacks, and the normal verification session still checks the signature.

Both live camera views show a steady, page-shaped guide with corner and glare advice. The guide fits inside the visible camera image, adapts to phone rotation, and does not crop the scanned frame or saved photo. Live attempts explicitly disable exhaustive alignment refinement; selected images and an explicit Capture photo action retain that longer, cancellable recovery path.

The audit and phases below are historical, not a current feature inventory or
implementation checklist. Do not restore retired hidden-padding recovery.

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
