export function AboutQRed({ onPrepareOffline }) {
  return <article className="qred-about-content">
    <h1>What is QRed?</h1>
    <p className="qred-intro">QRed helps you spot changes to a document’s text—even after it’s printed.</p>
    <section>
      <h2>A record that travels with the document</h2>
      <p>Before sharing a PDF, the sender uses QRed to add square QR codes. These codes carry a record of the document’s text and information that lets QRed check whether that record has been altered. We call these codes <strong>seals</strong>.</p>
    </section>
    <section>
      <h2>Something to compare a copy against</h2>
      <p>Anyone who receives a document with these codes can use QRed to compare its text with the recorded version. This can help reveal a changed date, name, or amount.</p>
    </section>
    <div className="qred-about-details">
      <details><summary>Understanding the result</summary>
        <p>QRed may ask you to review differences because reading text from a photograph is not always accurate.</p>
        <p>A successful check does not prove that the original document’s claims are true, or guarantee that every visible detail is unchanged.</p>
      </details>
      <details><summary>What happens to my files?</summary>
        <p>Your PDF and scan photos are processed on your device. Creating seals with an online account sends your account details and digital identifiers calculated from the pages to QRed, but not the PDF itself.</p>
      </details>
      <details><summary>Can I use it offline?</summary>
        <p>You can check documents offline after loading the needed resources. Creating seals with an online account requires an internet connection.</p>
        <button type="button" className="qred-secondary-action" onClick={onPrepareOffline}>Prepare for offline checking</button>
      </details>
    </div>
    <footer className="qred-policy-links" aria-label="QRed policies and project documentation">
      <nav aria-label="Policies and security information">
        <a href="/privacy.html" target="_blank" rel="noopener noreferrer">Privacy</a>
        <a href="/data-deletion.html" target="_blank" rel="noopener noreferrer">Data deletion</a>
        <a href="/terms.html" target="_blank" rel="noopener noreferrer">Terms</a>
        <a href="/security.html" target="_blank" rel="noopener noreferrer">Security &amp; architecture</a>
      </nav>
    </footer>
  </article>;
}
