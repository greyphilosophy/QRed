/* eslint-disable no-unused-vars */
import React from "react";
import { createRoot } from "react-dom/client";
import { PhotoTextVerification } from "./PhotoTextVerification.jsx";
import { createPageTextChecks } from "./pageTextChecks.js";

export function mountPhotoTextVerification(element) {
  const root = createRoot(element);
  const checks = createPageTextChecks();
  let lastSession = 0;
  return {
    prepare: () => checks.prepare(),
    clear: () => checks.clear(),
    update(results, session, scanImages = {}, scanning = false, options = {}) {
      if (session !== lastSession) { checks.clear(); lastSession = session; }
      root.render(<PhotoTextVerification results={results} session={session} checks={checks}
        scanPhotos={scanImages.photos} captureNotice={scanImages.notice} scanning={scanning} {...options} />);
    },
    destroy() { root.unmount(); checks.dispose(); },
  };
}
