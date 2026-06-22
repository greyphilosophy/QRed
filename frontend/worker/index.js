function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...(init.headers || {}),
    },
  });
}

function buildProxyRequest(request, apiOrigin) {
  const sourceUrl = new URL(request.url);
  const targetUrl = new URL(apiOrigin);
  targetUrl.pathname = sourceUrl.pathname;
  targetUrl.search = sourceUrl.search;

  const headers = new Headers(request.headers);
  headers.set("Host", targetUrl.host);
  headers.set("X-Forwarded-Host", sourceUrl.host);
  headers.set("X-Forwarded-Proto", sourceUrl.protocol.replace(":", ""));

  return new Request(targetUrl, {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      if (!env.QRED_API_ORIGIN) {
        return jsonResponse(
          {
            error: "QRED_API_ORIGIN is not configured for this Worker.",
            message: "The static verifier is available, but API-backed demo endpoints require a separate QRed backend origin.",
          },
          { status: 503 },
        );
      }

      return fetch(buildProxyRequest(request, env.QRED_API_ORIGIN));
    }

    return env.ASSETS.fetch(request);
  },
};
