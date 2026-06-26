// One place to describe every request parameter used across the flows.
// Keyed by the form-urlencoded parameter name.
export const PARAM_GLOSSARY = {
  grant_type:
    'Identifies the OAuth flow. client_credentials authenticates a service app; token-exchange (RFC 8693) trades one token for another; jwt-bearer (RFC 7523) redeems a JWT grant (the id-JAG) for an access token.',
  subject_token:
    'The token being exchanged — the user’s OIDC ID token (user flows) or the service app’s access token (client-credentials flow).',
  subject_token_type:
    'Tells the authorization server what kind of token subject_token is — urn:…:token-type:id_token for an ID token, or :access_token for a service token.',
  requested_token_type:
    'The kind of token you want back: id-jag (Identity Assertion Authorization Grant), vaulted-secret, or service-account.',
  audience:
    'The intended recipient of the issued token — the resource’s authorization server that will accept the id-JAG.',
  resource:
    'The specific protected resource the token is for: an API URI, or an Okta PAM secret / service-account ORN.',
  scope: 'The OAuth scopes being requested for the resulting token.',
  client_assertion_type:
    'Declares that the client authenticates with a JWT assertion — always urn:…:client-assertion-type:jwt-bearer for private_key_jwt.',
  client_assertion:
    'A short-lived JWT signed by the agent’s private key, proving the client’s identity to the authorization server (private_key_jwt authentication).',
  assertion:
    'The authorization grant being redeemed — here the id-JAG returned by the previous token-exchange step (T2).',
  client_id: 'The OAuth client identifier authenticating the request.',
};

// Return the described params present in a form-urlencoded request body, in order.
export function describedParamsFromBody(body, headers) {
  const ct = headers?.['Content-Type'] || headers?.['content-type'] || '';
  if (typeof body !== 'string' || !ct.includes('x-www-form-urlencoded')) return [];
  const out = [];
  for (const pair of body.split('&')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const name = decodeURIComponent(pair.slice(0, idx));
    if (PARAM_GLOSSARY[name] && !out.some((o) => o.name === name)) {
      out.push({ name, description: PARAM_GLOSSARY[name] });
    }
  }
  return out;
}
