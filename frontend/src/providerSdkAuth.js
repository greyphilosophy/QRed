// Provider-supported popup APIs. SDKs load only when the user has chosen
// to use account sealing, never during QRed's offline private-key workflow.
// None of the SDKs receive a PDF, its text, or its page fingerprints.
const GOOGLE_SRC = "https://accounts.google.com/gsi/client";
const MICROSOFT_SRC = "https://alcdn.msauth.net/browser/2.35.0/js/msal-browser.min.js";
const AMAZON_SRC = "https://assets.loginwithamazon.com/sdk/na/login1.js";
const imports = new Map();

function loadScript(src, isReady, { integrity, prepare } = {}) {
  if (isReady()) return Promise.resolve();
  if (imports.has(src)) return imports.get(src);
  const promise = new Promise((resolve, reject) => {
    prepare?.();
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    if (integrity) { script.integrity = integrity; script.crossOrigin = "anonymous"; }
    script.onload = () => isReady() ? resolve() : reject(new Error("Provider SDK did not initialize"));
    script.onerror = () => reject(new Error("Could not load the provider sign-in service"));
    document.head.appendChild(script);
  }).catch(error => { imports.delete(src); throw error; });
  imports.set(src, promise);
  return promise;
}

export function createSdkNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function loadGoogleSdk() {
  await loadScript(GOOGLE_SRC, () => Boolean(window.google?.accounts?.id?.renderButton));
}

export async function renderGoogleButton(container, { clientId, nonce, onCredential, onClick }) {
  await loadGoogleSdk();
  if (!container.isConnected) return;
  window.google.accounts.id.initialize({
    client_id: clientId, nonce, ux_mode: "popup", auto_select: false,
    callback: response => {
      if (typeof response?.credential === "string") onCredential({ id_token: response.credential });
    },
  });
  container.replaceChildren();
  window.google.accounts.id.renderButton(container, {
    type: "standard", theme: "outline", size: "large", text: "signin_with",
    shape: "rectangular", logo_alignment: "left", width: Math.max(200, Math.min(330, container.clientWidth || 300)),
    click_listener: onClick,
  });
}

export async function loadMicrosoftSdk() {
  await loadScript(MICROSOFT_SRC, () => Boolean(window.msal?.PublicClientApplication), {
    integrity: "sha384-PARf28kmic36Ve+O3DnUerRXFtOQ7ZDqRDGpLcbljly5/N39T2OV3kt3QsWOKeAX",
  });
}

let microsoftApp, microsoftClientId;
export async function prepareMicrosoft(clientId) {
  await loadMicrosoftSdk();
  if (microsoftApp && microsoftClientId === clientId) return microsoftApp;
  microsoftClientId = clientId;
  microsoftApp = new window.msal.PublicClientApplication({
    auth: {
      clientId,
      authority: "https://login.microsoftonline.com/common",
      redirectUri: location.origin + "/api/auth/microsoft/callback",
      navigateToLoginRequestUrl: false,
    },
    cache: { cacheLocation: "memoryStorage", storeAuthStateInCookie: false },
  });
  return microsoftApp;
}

export async function microsoftPopup(app, nonce) {
  const result = await app.loginPopup({
    scopes: ["openid", "profile", "email"],
    prompt: "select_account",
    nonce,
  });
  if (!result?.idToken) throw new Error("Microsoft did not return an identity token");
  return { id_token: result.idToken };
}

export async function loadAmazonSdk() {
  await loadScript(AMAZON_SRC, () => Boolean(window.amazon?.Login?.authorize), {
    prepare: () => {
      document.getElementById("amazon-root") || document.body.appendChild(
        Object.assign(document.createElement("div"), { id: "amazon-root" }));
      window.onAmazonLoginReady = () => {};
    },
  });
}

export async function prepareAmazon(clientId) {
  await loadAmazonSdk();
  window.amazon.Login.setClientId(clientId);
}

export function amazonPopup(nonce) {
  return new Promise((resolve, reject) => {
    const options = {
      scope: "profile",
      response_type: "code",
      pkce: true,
      state: nonce,
      interactive: "always",
      popup: true,
    };
    try {
      window.amazon.Login.authorize(options, response => {
        if (response?.error || !response?.code || response.state !== nonce) {
          reject(new Error("Amazon sign-in was cancelled or did not match this request"));
          return;
        }
        window.amazon.Login.retrieveToken(response.code, tokenResult => {
          if (!tokenResult?.success || typeof tokenResult.access_token !== "string") {
            reject(new Error("Amazon could not complete its authorization code exchange"));
            return;
          }
          resolve({ access_token: tokenResult.access_token, state: nonce });
        });
      });
    } catch {
      reject(new Error("Amazon could not open its sign-in popup"));
    }
  });
}
