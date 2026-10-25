/* eslint-disable no-unused-vars */
import React from "react";
import { createRoot } from "react-dom/client";
import { PdfSealInput } from "./PdfSealInput.jsx";

export function mountPdfSealInput(element, onSeal) {
  const root = createRoot(element);
  const update = session => root.render(<PdfSealInput onSeal={onSeal} session={session} />);
  update(0);
  return { update, destroy: () => root.unmount() };
}
