export function AppIcon({ name }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {name === "camera" && <><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z" /><circle cx="12" cy="13" r="4" /></>}
    {name === "file" && <path d="M3 7V5a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v2M3 7h7l2 3h8a2 2 0 0 1 2 2l-2 7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2L1 10a2 2 0 0 1 2-3z" />}
    {name === "info" && <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></>}
    {name === "back" && <path d="m12 5-7 7 7 7M5 12h15" />}
  </svg>;
}
