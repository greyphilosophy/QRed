import React, { useEffect, useState } from "react";
import { decodeFragment } from "./qredFragment.js";

/**
 * FragmentDisplay — React component that displays document data from
 * URL hash fragments. Always triggers for any fragment on the page.
 *
 * For QRED1? fragments: shows structured document content with metadata.
 * For plain text fragments (e.g., #HelloWorld): shows the text directly.
 */
export function FragmentDisplay() {
  const [parsed, setParsed] = useState(null);

  useEffect(() => {
    function handleHash() {
      const raw = window.location.hash;
      if (raw.length > 1) {
        const result = decodeFragment(raw);
        setParsed(result);
      } else {
        setParsed(null);
      }
    }

    handleHash();
    window.addEventListener("hashchange", handleHash);
    return () => window.removeEventListener("hashchange", handleHash);
  }, []);

  if (!parsed) return null;

  if (parsed.type === "qred1") {
    return QRed1Display({ data: parsed.data });
  }

  // Plain text fragment
  return React.createElement("div", { className: "card fragment-display" },
    React.createElement("div", null,
      React.createElement("h2", null, "QR Code Content"),
      React.createElement("div", { className: "doc-text" }, parsed.text)
    )
  );
}

function QRed1Display({ data }) {
  const isMultiPart = data.totalParts && Number(data.totalParts) > 1;

  return React.createElement("div", { className: "card fragment-display" },
    React.createElement("div", { className: "fragment-notice" },
      React.createElement("p", null,
        "QRed document fragment — displaying embedded data."
      ),
      React.createElement("p", { style: { marginTop: "0.5rem" }},
        React.createElement("span", null,
          "To verify the signature and bindings, open the "
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
    isMultiPart
      ? React.createElement("div", { className: "fragment-multi" },
        "This QR code is part " + (Number(data.partIndex || 0) + 1) + " of " + data.totalParts + ". Scan all QR codes for the full sealed content."
      )
      : null
  );
}
