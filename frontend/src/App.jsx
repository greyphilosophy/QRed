import { useEffect, useRef, useState } from "react";
import { QrScanner } from "./QrScanner.jsx";
import { PdfSealForm } from "./PdfSealForm.jsx";
import { SealVerification, useSealVerification } from "./SealVerification.jsx";
import { AboutQRed } from "./AboutQRed.jsx";
import { AppIcon } from "./AppIcon.jsx";
import { isMobileDevice, useAppNavigation } from "./appNavigation.js";
import "./verification.css";
import "./app.css";

const titles = { home: "Document Verifier", check: "Document check", camera: "Camera", seal: "Seal PDF", about: "About QRed" };

function App() {
  const { route, navigate, back, review } = useAppNavigation();
  const [visitedSeal, setVisitedSeal] = useState(route === "seal");
  const [visitedCheck, setVisitedCheck] = useState(route === "check" || route === "camera");
  const [mobile] = useState(isMobileDevice);
  const app = useRef(null);
  const cameraWasScanning = useRef(false);
  const verification = useSealVerification();
  const hasCheck = Boolean(visitedCheck || verification.seals.length || verification.scanImages.photos.length || verification.busy);

  useEffect(() => { if (route === "seal") setVisitedSeal(true); }, [route]);
  useEffect(() => { if (route === "check" || route === "camera") setVisitedCheck(true); }, [route]);
  useEffect(() => {
    document.title = `QRed — ${titles[route]}`;
    const view = app.current?.querySelector(`[data-qred-view="${route}"]`);
    const heading = (route === "check" && view?.querySelector(".photo-finding-heading, .photo-result h3")) || view?.querySelector("h1, h2");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
      if (route !== "check") app.current?.scrollIntoView?.({ block: "start" });
    }
  }, [route]);
  useEffect(() => {
    if (route !== "camera") { cameraWasScanning.current = false; return; }
    if (verification.scanning) {
      if (!cameraWasScanning.current) {
        const camera = app.current?.querySelector(".ar-display-scanning");
        camera?.querySelector(".ar-button-primary")?.focus({ preventScroll: true });
        camera?.scrollIntoView?.({ block: "start" });
      }
      cameraWasScanning.current = true;
    }
    else cameraWasScanning.current = false;
  }, [route, verification.scanning]);

  function choosePhoto(browseFiles = true) {
    navigate("check");
    const picker = document.getElementById(browseFiles ? "qr-scan-file" : "qr-image");
    const details = picker?.closest("details");
    if (details) details.open = true;
    // Keep the native picker within the user's click, including on mobile.
    picker?.click();
  }

  function finishCheck() {
    verification.clear();
    setVisitedCheck(false);
    navigate("home", { replace: true });
  }

  function finishSealing() {
    setVisitedSeal(false);
    navigate("home", { replace: true });
  }

  function prepareOffline() {
    navigate("check");
    const details = app.current?.querySelector(".photo-check > details:last-of-type");
    if (details) details.open = true;
    verification.textChecks.prepare().catch(() => {});
  }

  return <main className={`homepage qred-app qred-view-${route}`} ref={app}>
    <div className="qred-shell">
      <header className="qred-app-header">
        <button type="button" className="qred-wordmark" aria-label="QRed home" onClick={() => navigate("home")}>QRed</button>
        <button type="button" className="qred-about-link" aria-current={route === "about" ? "page" : undefined}
          onClick={() => navigate("about")}><AppIcon name="info" />About QRed</button>
      </header>
      {route !== "home" && <button type="button" className="qred-back" onClick={back}><AppIcon name="back" />Back</button>}

      <section data-qred-view="home" hidden={route !== "home"} className="qred-home">
        <section className="qred-check-group" aria-labelledby="qred-check-title">
          <h1 id="qred-check-title">Check document</h1>
          {mobile && <p className="qred-mobile-security">Use airplane mode for extra security</p>}
          <div className="qred-check-methods">
            <button type="button" className="qred-method qred-method-primary" onClick={() => navigate("camera")}><AppIcon name="camera" /><span>Camera</span></button>
            <button type="button" className="qred-method" onClick={() => choosePhoto(true)}><AppIcon name="file" /><span>File</span></button>
          </div>
          {hasCheck && <button type="button" className="qred-resume" onClick={() => navigate("check")}>Continue document check</button>}
        </section>
        <button type="button" className="qred-seal-entry" onClick={() => navigate("seal")}><span className="stamp-icon" aria-hidden="true">▣</span>Seal PDF</button>
        <p className="qred-device-note">Files stay on this device.</p>
        {verification.notice === "Check cleared. Camera off." && <p className="qred-completion" role="status">{verification.notice}</p>}
      </section>

      {route === "camera" && <section data-qred-view="camera" className="qred-camera-view">
        <QrScanner key={verification.session} autoStart compact returnPayload collectSeals
          beforeScan={() => { verification.setNotice(""); return verification.textChecks.prepare(); }}
          onScanningChange={verification.setScanning} onChoosePhoto={choosePhoto}
          collectionProgress={verification.progress} onSealDetected={verification.addSeal}
          onClose={back} onReview={review}
          resultPanel={<div className="ar-result-panel"><h2>Pages captured</h2><p>{verification.progress?.message}</p><button onClick={review}>Review page checks</button></div>} />
      </section>}

      <section data-qred-view="check" hidden={route !== "check"} className="qred-check-view">
        <div className="qred-check-toolbar" aria-label="Add pages to the document check">
          <button type="button" onClick={() => navigate("camera")}><AppIcon name="camera" />Camera</button>
          <button type="button" onClick={() => choosePhoto(true)}><AppIcon name="file" />File</button>
        </div>
        <SealVerification verification={verification} active={route === "check"} onFinish={finishCheck}
          onActivity={() => navigate("check")} onScanMore={() => navigate("camera")}
          onChooseMore={() => choosePhoto(true)} />
      </section>

      {(visitedSeal || route === "seal") && <section data-qred-view="seal" hidden={route !== "seal"} className="pdf-stamp-tool" id="pdf-stamp-tool">
        <PdfSealForm active={route === "seal"} onUsePublicKey={verification.setPublicKey} onOpenAbout={() => navigate("about")} />
        <div className="qred-seal-session-actions"><button type="button" className="qred-secondary-action" onClick={finishSealing}>Finish &amp; clear</button></div>
      </section>}

      <section data-qred-view="about" hidden={route !== "about"}>
        <AboutQRed onPrepareOffline={prepareOffline} />
      </section>
    </div>
  </main>;
}

export default App;
