// Opt-in console logging for the token flows.
//
//   DEBUG_FLOWS=1        one line per captured step (method, URL, status, ms);
//                        failing steps also print their redacted response body
//   DEBUG_FLOWS=verbose  additionally prints redacted request params and
//                        response bodies for every step
//
// Tokens, assertions, secrets, and codes are always masked — a masked value
// shows its first 8 / last 4 characters and its length, enough to correlate
// with the UI step cards without ever logging a usable credential.

const level = (process.env.DEBUG_FLOWS || '').trim().toLowerCase();
export const DEBUG = ['1', 'true', 'yes', 'verbose'].includes(level);
export const VERBOSE = level === 'verbose';

const SENSITIVE_KEY = /token|assertion|secret|password|authorization|code$/i;

export function mask(value) {
  const s = String(value ?? '');
  if (s.length <= 12) return '••••';
  return `${s.slice(0, 8)}…${s.slice(-4)}(${s.length})`;
}

export function redact(value, depth = 0) {
  if (value == null || depth > 4) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = v && typeof v === 'object' ? redact(v, depth + 1) : SENSITIVE_KEY.test(k) ? mask(v) : v;
    }
    return out;
  }
  return value;
}

function short(obj, max = 1500) {
  let s;
  try {
    s = typeof obj === 'string' ? obj : JSON.stringify(obj);
  } catch {
    s = String(obj);
  }
  return s && s.length > max ? `${s.slice(0, max)}… (${s.length} chars)` : s;
}

/**
 * One log block per captured step. Called from the capture helpers after the
 * HTTP round-trip completes.
 */
export function logStep(step, { method, url, params }, { status, ms, networkError, responseBody }) {
  if (!DEBUG) return;
  const outcome = networkError ? `network_error: ${networkError}` : `HTTP ${status}`;
  console.log(`[flow] ${step.id} ${step.title} | ${method} ${url} → ${outcome} (${ms}ms)`);
  if (VERBOSE && params) console.log(`[flow]   request: ${short(redact(params))}`);
  // Errors are always worth the body, even at level 1.
  if (VERBOSE || networkError || !(status >= 200 && status < 300)) {
    console.log(`[flow]   response: ${short(redact(responseBody))}`);
  }
}
