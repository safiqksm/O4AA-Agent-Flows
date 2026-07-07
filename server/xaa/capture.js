import { decodeJwt } from '../util/jwt.js';
import { logStep } from '../util/debugLog.js';

// Build a copy/pasteable curl snippet for a form-urlencoded POST.
function toCurl(url, headers, bodyParams) {
  const lines = [`curl -X POST '${url}' \\`];
  for (const [k, v] of Object.entries(headers)) {
    lines.push(`  -H '${k}: ${v}' \\`);
  }
  const data = Object.entries(bodyParams)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  lines.push(`  -d '${data}'`);
  return lines.join('\n');
}

function headersToObject(h) {
  const out = {};
  for (const [k, v] of h.entries()) out[k] = v;
  return out;
}

// Mask the credential in an Authorization header for display (keep the scheme).
function maskAuth(headers) {
  const out = { ...headers };
  const auth = out.Authorization || out.authorization;
  if (auth) {
    const [scheme, val = ''] = auth.split(' ');
    const masked = val.length > 16 ? `${val.slice(0, 8)}…${val.slice(-4)}` : '••••';
    if (out.Authorization) out.Authorization = `${scheme} ${masked}`;
    else out.authorization = `${scheme} ${masked}`;
  }
  return out;
}

/**
 * Perform an instrumented application/x-www-form-urlencoded POST and return a
 * fully-captured step object for the visualization UI.
 *
 * @param {object} step  { id, title, badge, from, to, tokenField }
 * @param {string} url
 * @param {object} headers       extra headers (Content-Type is added automatically)
 * @param {object} bodyParams    flat key/value map; values are sent verbatim
 */
export async function captureFormPost(step, url, headers, bodyParams) {
  const reqHeaders = { 'Content-Type': 'application/x-www-form-urlencoded', ...headers };
  const body = new URLSearchParams(bodyParams).toString();

  let res;
  let responseBody;
  let responseHeaders = {};
  let status = 0;
  let networkError = null;
  const t0 = Date.now();

  try {
    res = await fetch(url, { method: 'POST', headers: reqHeaders, body });
    status = res.status;
    responseHeaders = headersToObject(res.headers);
    const text = await res.text();
    try {
      responseBody = JSON.parse(text);
    } catch {
      responseBody = text;
    }
  } catch (err) {
    networkError = err.message;
  }

  logStep(step, { method: 'POST', url, params: bodyParams }, { status, ms: Date.now() - t0, networkError, responseBody });

  // Decode the token of interest from the response (id-JAG, access token, …)
  let token = null;
  if (step.tokenField && responseBody && typeof responseBody === 'object') {
    const raw = responseBody[step.tokenField];
    if (raw) token = decodeJwt(raw);
  }

  const captured = {
    id: step.id,
    title: step.title,
    badge: step.badge,
    from: step.from,
    to: step.to,
    ok: status >= 200 && status < 300 && !networkError,
    request: { method: 'POST', url, headers: reqHeaders, body },
    response: networkError
      ? { status: 0, headers: {}, body: { error: 'network_error', error_description: networkError } }
      : { status, headers: responseHeaders, body: responseBody },
    token,
    code: toCurl(url, reqHeaders, bodyParams),
  };

  return { captured, responseBody, ok: captured.ok };
}

/**
 * Perform an instrumented GET (e.g. reading GitHub pull requests) and return a
 * captured step. The Authorization header is masked in the display.
 */
export async function captureGet(step, url, headers) {
  const reqHeaders = { Accept: 'application/json', ...headers };

  let status = 0;
  let responseBody;
  let responseHeaders = {};
  let networkError = null;
  const t0 = Date.now();

  try {
    const res = await fetch(url, { method: 'GET', headers: reqHeaders });
    status = res.status;
    responseHeaders = headersToObject(res.headers);
    const text = await res.text();
    try {
      responseBody = JSON.parse(text);
    } catch {
      responseBody = text;
    }
  } catch (err) {
    networkError = err.message;
  }

  logStep(step, { method: 'GET', url }, { status, ms: Date.now() - t0, networkError, responseBody });

  const displayHeaders = maskAuth(reqHeaders);
  const ok = status >= 200 && status < 300 && !networkError;
  const captured = {
    id: step.id,
    title: step.title,
    badge: step.badge,
    from: step.from,
    to: step.to,
    ok,
    request: { method: 'GET', url, headers: displayHeaders, body: '' },
    response: networkError
      ? { status: 0, headers: {}, body: { error: 'network_error', error_description: networkError } }
      : { status, headers: responseHeaders, body: responseBody },
    token: null,
    code: `curl '${url}' \\\n  -H 'Authorization: ${displayHeaders.Authorization || displayHeaders.authorization}' \\\n  -H 'Accept: application/vnd.github+json'`,
  };

  return { captured, responseBody, ok };
}

/**
 * Perform an instrumented application/json POST (e.g. the GitHub PR call) and
 * return a captured step. The Authorization header is masked in the display.
 */
export async function captureJsonPost(step, url, headers, jsonBody) {
  const reqHeaders = { 'Content-Type': 'application/json', Accept: 'application/json', ...headers };

  let status = 0;
  let responseBody;
  let responseHeaders = {};
  let networkError = null;
  const t0 = Date.now();

  try {
    const res = await fetch(url, { method: 'POST', headers: reqHeaders, body: JSON.stringify(jsonBody) });
    status = res.status;
    responseHeaders = headersToObject(res.headers);
    const text = await res.text();
    try {
      responseBody = JSON.parse(text);
    } catch {
      responseBody = text;
    }
  } catch (err) {
    networkError = err.message;
  }

  logStep(step, { method: 'POST', url, params: jsonBody }, { status, ms: Date.now() - t0, networkError, responseBody });

  const displayHeaders = maskAuth(reqHeaders);
  const ok = status >= 200 && status < 300 && !networkError;
  const captured = {
    id: step.id,
    title: step.title,
    badge: step.badge,
    from: step.from,
    to: step.to,
    ok,
    request: { method: 'POST', url, headers: displayHeaders, body: JSON.stringify(jsonBody, null, 2) },
    response: networkError
      ? { status: 0, headers: {}, body: { error: 'network_error', error_description: networkError } }
      : { status, headers: responseHeaders, body: responseBody },
    token: null,
    code: `curl -X POST '${url}' \\\n  -H 'Authorization: ${displayHeaders.Authorization || displayHeaders.authorization}' \\\n  -H 'Content-Type: application/json' \\\n  -d '${JSON.stringify(jsonBody)}'`,
  };

  return { captured, responseBody, ok };
}
