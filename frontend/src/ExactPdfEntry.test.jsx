/* @vitest-environment jsdom */
/* eslint-disable no-unused-vars */
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "./App.jsx";

vi.mock("./QrScanner.jsx", () => ({ QrScanner: ({ onOpenPdfStampTool }) => <div><h1>Existing printed-page scanner</h1><button onClick={onOpenPdfStampTool}>Open PDF stamping tool</button></div> }));
vi.mock("./PdfSealForm.jsx", () => ({ PdfSealForm: () => <p>Existing PDF sealing form</p> }));
vi.mock("./SealVerification.jsx", () => ({ useSealVerification: () => ({}), SealVerification: () => <p>Existing text verification</p> }));
vi.mock("./ExactPdfExperiment.jsx", () => ({ default: ({ onClose }) => <section><h2>Exact rendered appearance</h2><button onClick={onClose}>Close exact PDF experiment</button></section> }));
afterEach(cleanup);

it("keeps the exact tool closed by default alongside unchanged existing tools", () => {
  render(<App />);
  expect(screen.getByText("Existing printed-page scanner")).toBeTruthy();
  expect(screen.getByText("Existing text verification")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Exact rendered appearance" })).toBeNull();
  expect(screen.getByRole("button", { name: "Open experimental exact PDF tool" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open PDF stamping tool" }));
  expect(screen.getByText("Existing PDF sealing form")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Exact rendered appearance" })).toBeNull();
});

it("requires opt-in, closes independently, restores focus and can reopen", async () => {
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "Open experimental exact PDF tool" }));
  await screen.findByRole("heading", { name: "Exact rendered appearance" });
  expect(screen.queryByText("Existing PDF sealing form")).toBeNull();
  expect(screen.getByText("Existing text verification")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close exact PDF experiment" }));
  expect(screen.queryByRole("heading", { name: "Exact rendered appearance" })).toBeNull();
  const entry = screen.getByRole("button", { name: "Open experimental exact PDF tool" });
  await waitFor(() => expect(document.activeElement).toBe(entry));
  fireEvent.click(entry);
  await screen.findByRole("heading", { name: "Exact rendered appearance" });
});
