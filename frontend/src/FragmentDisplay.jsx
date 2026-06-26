import React, { useEffect, useState } from "react";

/**
 * FragmentDisplay - React component that displays document data from
 * QRed URL fragments (e.g., #QRED1?...) or plain text fragments.
 * Only renders when the URL hash contains a QRED1? fragment or plain text.
 */
export function FragmentDisplay() {
  const [data, setData] = useState(null);

  useEffect(() => {
    function handleHash() {
      const rawHash = window.location.hash.slice(1);
      if (!rawHash.startsWith("QRED1?") && rawHash.length > 0) {
        setData({ type: "text", text: decodeURIComponent(rawHash) });
        return;
      }
      if (rawHash.startsWith("QRED1?")) {
        const params = new URLSearchParams(rawHash.slice(6));
        setData({
          type: "qred1",
          text: params.get("txt") || "",
          issuer: params.get("iss") || "",
          documentId: params.get("doc") || "",
          timestamp: params.get("ts") || "",
          keyId: params.get("kid") || "",
          signature: params.get("sig") || "",
          partIndex: params.get("i") || "",
          totalParts: params.get("n") || "",
        });
        return;
      }
      setData(null);
    }

    handleHash();
    window.addEventListener("hashchange", handleHash);
    return () => window.removeEventListener("hashchange", handleHash);
  }, []);

  if (!data) return null;

  return React.createElement(FragmentResult, { data: data });
}

function FragmentResult({ data }) {
  if (data.type === "qred1") {
    return React.createElement("div", { className: "card fragment-display" },
      React.createElement("div", { className: "fragment-notice" },
        React.createElement("p", null,
          "QRed URL fragment detected — displaying embedded data."
        ),
        React.createElement("p", { style: { marginTop: "0.5rem" }},
          React.createElement("span", null,
            "This page shows the data from the QR code fragment. To verify the signature and bindings, open the "
          ),
          React.createElement("a", { href: "/verify.htm" }, "QRed Verifier")
        )
      ),
      React.createElement("div", null,
        React.createElement("h2", null, "Document Content"),
        React.createElement("div", { className: "doc-text" }, data.text)
      ),
      (data.issuer || data.documentId)
        ? React.createElement("div", { className: "fragment-meta" },
          data.issuer && React.createElement("div", { className: "meta-row" },
            React.createElement("span", { className: "meta-label" }, "Issuer:"),
            React.createElement("span", null, data.issuer)
          ),
          data.documentId && React.createElement("div", { className: "meta-row" },
            React.createElement("span", { className: "meta-label" }, "Document ID:"),
            React.createElement("span", null, data.documentId)
          ),
          data.keyId && React.createElement("div", { className: "meta-row" },
            React.createElement("span", { className: "meta-label" }, "Key ID:"),
            React.createElement("span", null, data.keyId)
          ),
          data.timestamp && React.createElement("div", { className: "meta-row" },
            React.createElement("span", { className: "meta-label" }, "Timestamp:"),
            React.createElement("span", null, data.timestamp)
          )
        )
        : null,
      data.totalParts && Number(data.totalParts) > 1
        ? React.createElement("div", { className: "fragment-multi" },
          "This QR code is part " + (Number(data.partIndex || 0) + 1) + " of " + data.totalParts + ". Scan all QR codes for the full sealed content."
        )
        : null
    );
  }

  // Plain text fragment (e.g., #HelloWorld)
  return React.createElement("div", { className: "card fragment-display" },
    React.createElement("div", { className: "fragment-notice" },
      React.createElement("p", null, "Plain text fragment detected.")
    ),
    React.createElement("div", null,
      React.createElement("h2", null, "Fragment Content"),
      React.createElement("div", { className: "doc-text" }, data.text)
    ),
    React.createElement("div", { className: "fragment-info" },
      "To verify a sealed QRed document, use the ",
      React.createElement("a", { href: "/verify.htm" }, "QRed Verifier")
    )
  );
}
