/* eslint-disable no-unused-vars */
import React from "react";
import { createRoot } from "react-dom/client";
import { PhotoTextVerification } from "./PhotoTextVerification.jsx";

export function mountPhotoTextVerification(element) {
  const root = createRoot(element);
  return {
    update(results, session, scanImages = {}, collecting = false) {
      root.render(<PhotoTextVerification results={results} session={session}
        scanPhotos={scanImages.photos} captureNotice={scanImages.notice} collecting={collecting} />);
    },
    destroy() { root.unmount(); },
  };
}
