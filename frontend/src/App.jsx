import React, { useState } from "react";

const API_BASE = "/api";

function VerifyForm() {
  const [sealInput, setSealInput] = useState("");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  function handleSubmit() {
    const seals = sealInput.trim().split("\n").map(s => s.trim()).filter(s => s.length > 0);
    if (seals.length > 0) {
      verify(seals);
    }
  }

  function verify(seals) {
    setLoading(true);
    setError(null);
    fetch(API_BASE + "/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seals }),
    })
      .then((r) => r.json())
      .then((data) => {
        setResult(data);
        setLoading(false);
      })
      .catch((e) => {
        setError(e.message);
        setLoading(false);
      });
  }

  function renderResult() {
    if (!result) return null;
    if (result.status === "VALID") {
      return React.createElement("div", { style: { background: "#ecfdf5", border: "1px solid #10b981", borderRadius: "8px", padding: "1.5rem" } },
        React.createElement("span", { style: { display: "inline-block", padding: "0.25rem 0.75rem", borderRadius: "999px", fontSize: "0.85rem", fontWeight: 600, background: "#10b981", color: "white", marginBottom: "1rem" }}, "VALID"),
        React.createElement("p", { style: { marginBottom: "0.5rem" }},
          React.createElement("strong", null, "Issuer: "), result.issuer),
        React.createElement("p", { style: { marginBottom: "0.5rem" }},
          React.createElement("strong", null, "Document ID: "), result.document_id),
        React.createElement("p", { style: { marginBottom: "0.5rem" }},
          React.createElement("strong", null, "Timestamp: "), new Date(result.timestamp).toLocaleString()),
        React.createElement("div", { style: { background: "#f1f5f9", borderRadius: "8px", padding: "1rem", marginTop: "1rem", whiteSpace: "pre-wrap" }}, result.content)
      );
    }
    if (result.status === "INCOMPLETE") {
      return React.createElement("div", { style: { background: "#fffbeb", border: "1px solid #f59e0b", borderRadius: "8px", padding: "1.5rem" }},
        React.createElement("span", { style: { display: "inline-block", padding: "0.25rem 0.75rem", borderRadius: "999px", fontSize: "0.85rem", fontWeight: 600, background: "#f59e0b", color: "white", marginBottom: "1rem" }}, "INCOMPLETE"),
        React.createElement("p", null, result.error_message)
      );
    }
    return React.createElement("div", { style: { background: "#fef2f2", border: "1px solid #ef4444", borderRadius: "8px", padding: "1.5rem" }},
      React.createElement("span", { style: { display: "inline-block", padding: "0.25rem 0.75rem", borderRadius: "999px", fontSize: "0.85rem", fontWeight: 600, background: "#ef4444", color: "white", marginBottom: "1rem" }}, result.status),
      React.createElement("p", null, result.error_message || "Verification failed")
    );
  }

  return React.createElement("div", { className: "card" },
    React.createElement("h2", null, "Verify QRed Document"),
    React.createElement("p", { style: { color: "#64748b", marginBottom: "1rem" }},
      "Enter QRed seal strings (one per line) to verify a document:"),
    React.createElement("textarea", {
      value: sealInput,
      onChange: (e) => setSealInput(e.target.value),
      placeholder: "Paste QRed seal strings here...\nOne per line.",
    }),
    React.createElement("button", { onClick: handleSubmit, disabled: loading },
      loading ? "Verifying..." : "Verify Document"),
    error && React.createElement("p", { style: { color: "#ef4444", marginTop: "1rem" }}, error),
    renderResult()
  );
}

function GenerateForm() {
  const [content, setContent] = useState("");
  const [issuer, setIssuer] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [seals, setSeals] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  function handleGenerate() {
    if (content && issuer && privateKey && publicKey) {
      generate(content, issuer, privateKey, publicKey);
    }
  }

  function generate(content, issuer, private_key, public_key) {
    setLoading(true);
    setError(null);
    fetch(API_BASE + "/seals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, issuer, private_key, public_key }),
    })
      .then((r) => r.json())
      .then((data) => {
        setSeals(data);
        setLoading(false);
      })
      .catch((e) => {
        setError(e.message);
        setLoading(false);
      });
  }

  function handleReset() {
    setSeals(null);
    setContent("");
    setIssuer("");
    setPrivateKey("");
    setPublicKey("");
  }

  if (seals) {
    return React.createElement("div", { className: "card" },
      React.createElement("h2", null, "Seals Generated"),
      React.createElement("p", null,
        React.createElement("strong", null, "Document ID: "), seals.document_id),
      React.createElement("p", null,
        React.createElement("strong", null, "Bootstrap URL: "),
        React.createElement("a", { href: seals.bootstrap_url, target: "_blank", rel: "noopener" }, seals.bootstrap_url)),
      React.createElement("p", null,
        React.createElement("strong", null, "Total Seals: "), seals.total_seals),
      React.createElement("p", { style: { marginBottom: "1rem" }},
        "Copy these seal strings for printing as QR codes:"),
      React.createElement("textarea", {
        readOnly: true,
        value: seals.seals.join("\n"),
        style: { marginBottom: "1rem" },
      }),
      React.createElement("div", null,
        React.createElement("button", {
          onClick: () => {
            navigator.clipboard?.writeText(seals.seals.join("\n"));
          }
        }, "Copy Seals"),
        React.createElement("button", {
          onClick: handleReset,
          style: { marginLeft: "1rem" }
        }, "Generate Another")
      )
    );
  }

  return React.createElement("div", { className: "card" },
    React.createElement("h2", null, "Generate QRed Seals"),
    React.createElement("p", { style: { color: "#64748b", marginBottom: "1rem" }},
      "Create tamper-evident seals for a document:"),
    React.createElement("div", { className: "demo-grid" },
      React.createElement("div", { className: "demo-input" },
        React.createElement("label", null, "Document Content"),
        React.createElement("textarea", {
          value: content,
          onChange: (e) => setContent(e.target.value),
          placeholder: "Paste document text here...",
          rows: 4,
        })
      ),
      React.createElement("div", { className: "demo-input" },
        React.createElement("label", null, "Issuer"),
        React.createElement("input", {
          value: issuer,
          onChange: (e) => setIssuer(e.target.value),
          placeholder: "QRed Authority",
        })
      ),
      React.createElement("div", { className: "demo-input" },
        React.createElement("label", null, "Private Key"),
        React.createElement("input", {
          value: privateKey,
          onChange: (e) => setPrivateKey(e.target.value),
          placeholder: "Issuer's private key",
        })
      ),
      React.createElement("div", { className: "demo-input" },
        React.createElement("label", null, "Public Key"),
        React.createElement("input", {
          value: publicKey,
          onChange: (e) => setPublicKey(e.target.value),
          placeholder: "Issuer's public key",
        })
      )
    ),
    React.createElement("button", { onClick: handleGenerate, disabled: loading, style: { marginTop: "1rem" }},
      loading ? "Generating..." : "Generate Seals"),
    error && React.createElement("p", { style: { color: "#ef4444", marginTop: "0.5rem" }}, error)
  );
}
