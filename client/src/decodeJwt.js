// Browser-side, display-only JWT decode (no signature verification).
function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + pad;
  // handle UTF-8 payloads
  return decodeURIComponent(
    atob(b64)
      .split('')
      .map((c) => `%${`00${c.charCodeAt(0).toString(16)}`.slice(-2)}`)
      .join('')
  );
}

const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function looksLikeJwt(value) {
  return typeof value === 'string' && JWT_RE.test(value);
}

export function decodeJwt(token) {
  if (!looksLikeJwt(token)) return null;
  const [h, p] = token.split('.');
  try {
    return { header: JSON.parse(b64urlDecode(h)), payload: JSON.parse(b64urlDecode(p)) };
  } catch {
    return null;
  }
}

// Extract JWT-valued params from a form-urlencoded request body, preserving order.
export function jwtParamsFromBody(body) {
  if (typeof body !== 'string' || !body.includes('=')) return [];
  const out = [];
  for (const pair of body.split('&')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const name = decodeURIComponent(pair.slice(0, idx));
    const rawVal = decodeURIComponent(pair.slice(idx + 1));
    const decoded = decodeJwt(rawVal);
    if (decoded) out.push({ name, decoded });
  }
  return out;
}
