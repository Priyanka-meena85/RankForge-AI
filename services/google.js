const crypto = require("node:crypto");

const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/analytics.readonly"
];

function createGoogleAuthorizationUrl({ clientId, redirectUri, state, codeChallenge }) {
  if (!clientId) throw new Error("Google OAuth is not configured.");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

function createGoogleOAuthState() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const state = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { state, verifier, challenge };
}

async function googleTokenRequest(values, fetchImpl = globalThis.fetch) {
  let response;
  try {
    response = await fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(15000),
      body: new URLSearchParams(values)
    });
  } catch {
    throw new Error("Google OAuth could not be reached.");
  }
  const result = await response.json().catch(() => null);
  if (!response.ok || !result || typeof result.access_token !== "string") {
    throw new Error("Google OAuth rejected the authorization request.");
  }
  return result;
}

async function exchangeGoogleCode({ clientId, clientSecret, code, redirectUri, verifier }, fetchImpl) {
  if (!clientId || !clientSecret) throw new Error("Google OAuth is not configured.");
  return googleTokenRequest({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri
  }, fetchImpl);
}

async function refreshGoogleAccessToken({ clientId, clientSecret, refreshToken }, fetchImpl) {
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Google Analytics connection is incomplete.");
  const result = await googleTokenRequest({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token"
  }, fetchImpl);
  return result.access_token;
}

async function googleApiRequest(url, accessToken, body, fetchImpl = globalThis.fetch) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify(body)
    });
  } catch {
    throw new Error("Google reporting APIs could not be reached.");
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error("Google access was denied. Reconnect the workspace or verify property access.");
  }
  if (!response.ok) throw new Error(`Google reporting API failed (${response.status}).`);
  return response.json();
}

module.exports = {
  createGoogleAuthorizationUrl,
  createGoogleOAuthState,
  exchangeGoogleCode,
  googleApiRequest,
  refreshGoogleAccessToken
};
