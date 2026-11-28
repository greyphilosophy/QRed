/* @vitest-environment jsdom */
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SealLayoutPicker } from "./SealLayoutPicker.jsx";

afterEach(cleanup);

function Picker({ initial = "watermark-sheets", onChange = () => {}, disabled = false }) {
  const [value, setValue] = useState(initial);
  return <SealLayoutPicker value={value} disabled={disabled} onChange={next => {
    onChange(next);
    setValue(next);
  }} />;
}

it("keeps the current layout until a choice is applied and discards a cancelled draft", () => {
  const change = vi.fn();
  render(<Picker onChange={change} />);
  expect(screen.getByText("Extra seal pages if needed.")).toBeTruthy();
  expect(screen.queryByRole("radio")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Change layout" }));
  const watermark = screen.getByRole("radio", { name: "Watermarks", exact: true });
  expect(watermark.checked).toBe(true);
  expect(document.activeElement).toBe(watermark);
  expect(screen.getByText("More layouts").closest("details").open).toBe(false);
  fireEvent.click(screen.getByRole("radio", { name: "Separate seal pages" }));
  expect(change).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel", exact: true }));
  expect(change).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Change layout" }));
  fireEvent.click(screen.getByRole("button", { name: "Change layout" }));
  expect(screen.getByRole("radio", { name: "Watermarks", exact: true }).checked).toBe(true);
});

it.each([
  ["Separate seal pages", "seal-sheets", "Original pages stay unmarked.", false],
  ["Watermarks with footer fallback", "automatic", "Page or content size may change.", true],
  ["Larger pages", "legal-footer", "Keeps content size on larger paper.", true],
  ["Smaller content", "shrink-footer", "Same paper size, with seals below.", true],
])("applies %s and restores that selection when reopened", (name, value, summary, advanced) => {
  const change = vi.fn();
  render(<Picker onChange={change} />);
  fireEvent.click(screen.getByRole("button", { name: "Change layout" }));
  if (advanced) fireEvent.click(screen.getByText("More layouts"));
  fireEvent.click(screen.getByRole("radio", { name, exact: true }));
  expect(change).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Use this layout" }));
  expect(change).toHaveBeenCalledTimes(1);
  expect(change).toHaveBeenCalledWith(value);
  expect(screen.getByText(summary)).toBeTruthy();
  expect(screen.queryByRole("radio")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Change layout" }));
  expect(screen.getByRole("radio", { name, exact: true }).checked).toBe(true);
  expect(screen.getByText("More layouts").closest("details").open).toBe(advanced);
});

it("shows a legacy watermark value through the single equivalent fallback option without rewriting it", () => {
  const change = vi.fn();
  render(<Picker initial="watermark" onChange={change} />);
  fireEvent.click(screen.getByRole("button", { name: "Change layout" }));
  expect(screen.getByRole("radio", { name: "Watermarks with footer fallback" }).checked).toBe(true);
  expect(screen.getAllByRole("radio")).toHaveLength(5);
  fireEvent.click(screen.getByRole("button", { name: "Use this layout" }));
  expect(change).not.toHaveBeenCalled();
});

it("does not apply a draft after sealing disables layout changes", () => {
  const change = vi.fn();
  const { rerender } = render(<Picker onChange={change} />);
  fireEvent.click(screen.getByRole("button", { name: "Change layout" }));
  fireEvent.click(screen.getByRole("radio", { name: "Separate seal pages" }));
  rerender(<Picker onChange={change} disabled />);
  expect(screen.getByRole("button", { name: "Use this layout" }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Use this layout" }));
  expect(change).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel", exact: true }));
  expect(screen.queryByRole("radio")).toBeNull();
  expect(screen.getByRole("button", { name: "Change layout" }).disabled).toBe(true);
});
