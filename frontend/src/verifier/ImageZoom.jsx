export function ImageZoom({ value, onChange, label = "Image zoom" }) {
  return <div className="image-zoom" role="group" aria-label={label}>
    <span aria-hidden="true">Zoom</span>
    {[1, 2, 3].map(zoom => <button type="button" key={zoom} aria-pressed={value === zoom}
      onClick={() => onChange(zoom)}>{zoom === 1 ? "Fit" : `${zoom * 100}%`}</button>)}
  </div>;
}
