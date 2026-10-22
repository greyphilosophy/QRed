/* eslint-disable no-unused-vars */
import React from "react";
import { createRoot } from "react-dom/client";
import { PhotoTextVerification } from "./PhotoTextVerification.jsx";

export function mountPhotoTextVerification(element) {
  const root = createRoot(element);
  return {
    update(results, session) { root.render(<PhotoTextVerification results={results} session={session} />); },
    destroy() { root.unmount(); },
  };
}
