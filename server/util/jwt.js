// Lightweight JWT helpers for the demo. decodeJwt is display-only (no signature
// verification) so the UI can show the header/payload of every token in the chain.

function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(b64, 'base64').toString('utf8');
}

/**
 * Decode a JWT into { raw, header, payload } without verifying the signature.
 * Returns null if the value is not a 3-part JWT (e.g. an opaque token).
 */
export function decodeJwt(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return { raw: token, header: null, payload: null, opaque: true };
  try {
    return {
      raw: token,
      header: JSON.parse(b64urlDecode(parts[0])),
      payload: JSON.parse(b64urlDecode(parts[1])),
    };
  } catch {
    return { raw: token, header: null, payload: null, opaque: true };
  }
}
