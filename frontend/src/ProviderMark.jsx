// Artwork is bundled as inline SVG, so choosing private-key/offline mode
// never makes an image request to an identity provider.
export function ProviderMark({ provider }) {
  if (provider === "google") {
    return <svg viewBox="0 0 48 48" width="23" height="23" aria-hidden="true" focusable="false">
      <path fill="#4285F4" d="M43.6 24.5c0-1.4-.1-2.8-.4-4H24v7.6h11a9.4 9.4 0 0 1-4.1 6.2v5h6.6c3.9-3.6 6.1-8.9 6.1-14.8z"/>
      <path fill="#34A853" d="M24 44c5.5 0 10.1-1.8 13.5-4.9l-6.6-5c-1.8 1.2-4.1 1.9-6.9 1.9-5.3 0-9.8-3.6-11.4-8.4H5.9v5.2C9.3 39.5 16.2 44 24 44z"/>
      <path fill="#FBBC05" d="M12.6 27.6a12.1 12.1 0 0 1 0-7.2v-5.2H5.9A20 20 0 0 0 3.8 24c0 3.2.8 6.2 2.1 8.8l6.7-5.2z"/>
      <path fill="#EA4335" d="M24 12c3 0 5.6 1 7.6 3l5.8-5.8C34.1 6 29.5 4 24 4 16.2 4 9.3 8.5 5.9 15.2l6.7 5.2C14.2 15.6 18.7 12 24 12z"/>
    </svg>;
  }
  if (provider === "microsoft") {
    return <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      <path fill="#F25022" d="M1 1h10v10H1z"/><path fill="#7FBA00" d="M13 1h10v10H13z"/>
      <path fill="#00A4EF" d="M1 13h10v10H1z"/><path fill="#FFB900" d="M13 13h10v10H13z"/>
    </svg>;
  }
  if (provider === "amazon") {
    return <svg viewBox="0 0 26 26" width="24" height="24" aria-hidden="true" focusable="false">
      <path fill="#172338" d="M15.5 5.4c-5.6-1.1-9.3.9-9.9 4l3.5.7c.4-1.4 1.7-2 3.5-2 1.9 0 2.8.7 2.8 2v.8c-5.5.1-9.9 1.2-9.9 5.6 0 3.1 2.5 4.7 5.6 4.7 1.9 0 3.4-.7 4.6-1.9l.5 1.5h3.1v-9.9c0-3.3-1.9-4.6-5.2-4.8zm-.1 9.7c0 1.9-1.7 3.5-3.6 3.5-1.2 0-1.9-.6-1.9-1.6 0-1.6 2.3-2.3 5.5-2.4z"/>
      <path fill="none" stroke="#FF9900" strokeWidth="1.7" strokeLinecap="round" d="M4.4 22c4.5 2.7 11.2 2.6 16.4-1.4m-1.2-.1 2.2-.3-.5 2.1"/>
    </svg>;
  }
  return null;
}
