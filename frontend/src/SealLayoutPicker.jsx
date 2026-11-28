import { useEffect, useId, useRef, useState } from "react";
import "./sealLayoutPicker.css";

const LAYOUTS = [
  {
    value: "watermark-sheets", title: "Watermarks", recommended: true,
    summary: "Extra seal pages if needed.",
    description: "Add pale seals to the pages, with extra seal pages if needed.",
  },
  {
    value: "seal-sheets", title: "Separate seal pages",
    summary: "Original pages stay unmarked.",
    description: "Keep the original pages unmarked. Add seals at the end.",
  },
  {
    value: "automatic", title: "Watermarks with footer fallback",
    summary: "Page or content size may change.",
    description: "If needed, add seals below the content. Page or content size may change.",
  },
  {
    value: "legal-footer", title: "Larger pages",
    summary: "Keeps content size on larger paper.",
    description: "Add seals below the content. Use larger paper to keep the text size.",
  },
  {
    value: "shrink-footer", title: "Smaller content",
    summary: "Same paper size, with seals below.",
    description: "Keep the paper size. Shrink the content to fit seals below it.",
  },
];

// The legacy watermark choice has the same placement and fallback behavior
// as automatic. Keep that engine value valid without showing duplicate UI.
const displayedValue = value => value === "watermark" ? "automatic" : value;

function Paper({ type = "", marks = false }) {
  return <span className={`seal-layout-paper ${type}`}>
    {marks && <span className="seal-layout-paper-marks">
      <span>▣</span><span>▣</span>{!type.includes("footer") && <><span>▣</span><span>▣</span></>}
    </span>}
  </span>;
}

export function SealLayoutDiagram({ value }) {
  const layout = displayedValue(value);
  return <span className={`seal-layout-diagram${layout === "automatic" ? " seal-layout-alternatives" : ""}`} aria-hidden="true">
    {layout === "watermark-sheets" && <>
      <Paper type="seal-layout-watermarked" marks />
      <Paper type="seal-layout-sheet seal-layout-optional" marks />
    </>}
    {layout === "seal-sheets" && <><Paper /><Paper type="seal-layout-sheet" marks /></>}
    {layout === "automatic" && <>
      <Paper type="seal-layout-watermarked" marks />
      <span className="seal-layout-or">or</span>
      <Paper type="seal-layout-footer" marks />
    </>}
    {layout === "legal-footer" && <Paper type="seal-layout-tall seal-layout-footer" marks />}
    {layout === "shrink-footer" && <Paper type="seal-layout-footer seal-layout-shrunken" marks />}
  </span>;
}

export function SealLayoutPicker({ value, onChange, disabled = false }) {
  const id = useId();
  const changeButton = useRef(null);
  const firstChoice = useRef(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(displayedValue(value));
  const [moreOpen, setMoreOpen] = useState(false);
  const selected = LAYOUTS.find(layout => layout.value === displayedValue(value)) || LAYOUTS[0];

  useEffect(() => {
    if (editing) firstChoice.current?.focus({ preventScroll: true });
  }, [editing]);

  function open() {
    setDraft(selected.value);
    setMoreOpen(!LAYOUTS.slice(0, 2).some(layout => layout.value === selected.value));
    setEditing(true);
  }

  function close(apply) {
    if (apply && !disabled && draft !== displayedValue(value)) onChange(draft);
    setEditing(false);
    // The summary stays mounted so focus can return without a timed callback.
    changeButton.current?.focus();
  }

  function option(layout) {
    const labelId = `${id}-${layout.value}-label`;
    const descriptionId = `${id}-${layout.value}-description`;
    return <label key={layout.value} className="seal-layout-option">
      <input type="radio" name={`${id}-page-layout`} value={layout.value}
        checked={draft === layout.value} onChange={() => setDraft(layout.value)}
        disabled={disabled} aria-labelledby={labelId} aria-describedby={descriptionId}
        ref={layout.value === selected.value ? firstChoice : undefined} />
      <SealLayoutDiagram value={layout.value} />
      <span className="seal-layout-choice-copy">
        {layout.recommended && <small className="seal-layout-recommended">Recommended</small>}
        <strong id={labelId}>{layout.title}</strong>
        <small id={descriptionId}>{layout.description}</small>
      </span>
    </label>;
  }

  return <section className="seal-layout-picker" aria-labelledby={`${id}-heading`}>
    <h3 id={`${id}-heading`}>Seal layout</h3>
    <div className="seal-layout-summary">
      <SealLayoutDiagram value={selected.value} />
      <div>
        <div aria-live="polite" aria-atomic="true">
          <strong>{selected.title}</strong>
          <p>{selected.summary}</p>
        </div>
        <button ref={changeButton} type="button" className="seal-inline-action"
          disabled={disabled} aria-expanded={editing} aria-controls={`${id}-choices`}
          onClick={() => editing ? close(false) : open()}>
          {editing ? "Cancel layout change" : "Change layout"}
          <span aria-hidden="true">{editing ? "−" : "›"}</span>
        </button>
      </div>
    </div>
    <p className="seal-layout-caption">Layout illustration</p>
    {editing && <div className="seal-layout-editor" id={`${id}-choices`}>
      <fieldset className="seal-layout-options" disabled={disabled}>
        <legend>Where should the seals go?</legend>
        {LAYOUTS.slice(0, 2).map(option)}
        <details className="seal-more-layouts" open={moreOpen}
          onToggle={event => setMoreOpen(event.currentTarget.open)}>
          <summary>More layouts</summary>
          {LAYOUTS.slice(2).map(option)}
          <p className="seal-layout-footnote">Footer layouts flatten form fields into the saved page.</p>
        </details>
      </fieldset>
      <div className="seal-layout-actions">
        <button type="button" className="seal-secondary-action" onClick={() => close(false)}>Cancel</button>
        <button type="button" className="seal-primary-action" disabled={disabled} onClick={() => close(true)}>Use this layout</button>
      </div>
    </div>}
  </section>;
}
