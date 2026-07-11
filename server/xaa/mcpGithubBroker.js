import { config } from '../config.js';
import { captureFormPost } from './capture.js';
import { buildClientAssertion } from './clientAssertion.js';
import { logStep } from '../util/debugLog.js';

const GRANT_TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const TOKEN_TYPE_ID_TOKEN = 'urn:ietf:params:oauth:token-type:id_token';
const TOKEN_TYPE_OAUTH_STS = 'urn:okta:params:oauth:token-type:oauth-sts';
const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const MCP_PROTOCOL_VERSION = '2025-06-18';

function headersToObject(h) {
  const out = {};
  for (const [k, v] of h.entries()) out[k] = v;
  return out;
}

// Mask the bearer credential in the displayed request headers (keep the scheme).
function maskBearer(headers) {
  const out = { ...headers };
  const auth = out.Authorization;
  if (auth) {
    const [scheme, val = ''] = auth.split(' ');
    const masked = val.length > 16 ? `${val.slice(0, 8)}…${val.slice(-4)}` : '••••';
    out.Authorization = `${scheme} ${masked}`;
  }
  return out;
}

// Streamable HTTP responses may arrive as text/event-stream; the JSON-RPC
// response is the last `data:` payload in the stream.
function parseSseBody(text) {
  const dataLines = text.split(/\r?\n/).filter((l) => l.startsWith('data:'));
  if (!dataLines.length) return text;
  const last = dataLines[dataLines.length - 1].slice(5).trim();
  try {
    return JSON.parse(last);
  } catch {
    return text;
  }
}

/**
 * Instrumented MCP (JSON-RPC over Streamable HTTP) POST. Adapted from
 * capture.js#captureJsonPost, which stays untouched: this variant sends the
 * MCP headers, echoes the Mcp-Session-Id, and parses SSE-framed responses.
 */
async function captureMcpPost(step, url, accessToken, sessionId, jsonBody) {
  const reqHeaders = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
    Authorization: `Bearer ${accessToken}`,
  };
  if (sessionId) reqHeaders['Mcp-Session-Id'] = sessionId;

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
    if ((responseHeaders['content-type'] || '').includes('text/event-stream')) {
      responseBody = parseSseBody(text);
    } else {
      try {
        responseBody = JSON.parse(text);
      } catch {
        responseBody = text;
      }
    }
  } catch (err) {
    networkError = err.message;
  }

  logStep(step, { method: 'POST', url, params: jsonBody }, { status, ms: Date.now() - t0, networkError, responseBody });

  const displayHeaders = maskBearer(reqHeaders);
  // JSON-RPC-level errors arrive as HTTP 200 with an `error` member — still a failure.
  const rpcError = !!(responseBody && typeof responseBody === 'object' && responseBody.error);
  const ok = status >= 200 && status < 300 && !networkError && !rpcError;
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
    code: `curl -X POST '${url}' \\\n  -H 'Authorization: ${displayHeaders.Authorization}' \\\n  -H 'Content-Type: application/json' \\\n  -H 'Accept: application/json, text/event-stream' \\\n  -H 'MCP-Protocol-Version: ${MCP_PROTOCOL_VERSION}'${sessionId ? ` \\\n  -H 'Mcp-Session-Id: ${sessionId}'` : ''} \\\n  -d '${JSON.stringify(jsonBody)}'`,
  };

  return { captured, responseBody, responseHeaders, ok };
}

/**
 * T2 — STS broker token exchange for the MCP-server resource connection.
 * Exchanges the user's id_token for a brokered token at the org token endpoint.
 * First run may return HTTP 400 interaction_required + interaction_uri; after
 * the user consents, the identical retry succeeds.
 */
export async function requestMcpGithubToken(idToken) {
  const clientAssertion = await buildClientAssertion({
    clientId: config.agent.clientId,
    audience: config.mcpGithub.assertionAudience,
    kid: config.agent.kid,
    privateKeyFile: config.agent.privateKeyFile,
    privateKey: config.agent.privateKey,
  });

  const bodyParams = {
    grant_type: GRANT_TOKEN_EXCHANGE,
    requested_token_type: TOKEN_TYPE_OAUTH_STS,
    subject_token: idToken,
    subject_token_type: TOKEN_TYPE_ID_TOKEN,
    resource: config.mcpGithub.resource,
    client_assertion_type: CLIENT_ASSERTION_TYPE,
    client_assertion: clientAssertion,
  };
  if (config.mcpGithub.scopes) bodyParams.scope = config.mcpGithub.scopes;

  const { captured, responseBody, ok } = await captureFormPost(
    { id: 'T2', title: 'MCP Token Exchange', badge: 'STS', from: 'Agent', to: 'Okta Org Server', tokenField: 'access_token' },
    config.mcpGithub.tokenUrl,
    {},
    bodyParams
  );

  let interactionUri = null;
  if (!ok && responseBody && typeof responseBody === 'object' && responseBody.error === 'interaction_required') {
    interactionUri = responseBody.interaction_uri || null;
  }

  return {
    step: captured,
    accessToken: ok && responseBody ? responseBody.access_token : null,
    ok,
    interactionUri,
  };
}

/**
 * T3 — MCP initialize handshake. Captures the Mcp-Session-Id response header
 * (echoed on subsequent calls) and fires the spec-required
 * notifications/initialized notification (not rendered as a step).
 */
export async function mcpInitialize(accessToken) {
  const initBody = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'okta-xaa-demo', version: '1.0.0' },
    },
  };

  const { captured, responseBody, responseHeaders, ok } = await captureMcpPost(
    { id: 'T3', title: 'MCP Initialize', badge: 'MCP', from: 'Agent', to: 'GitHub MCP Server' },
    config.mcpGithub.url,
    accessToken,
    null,
    initBody
  );

  const sessionId = responseHeaders['mcp-session-id'] || undefined;

  if (ok) {
    try {
      await fetch(config.mcpGithub.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
          Authorization: `Bearer ${accessToken}`,
          ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
    } catch {
      // Non-fatal: some servers accept requests without the notification.
    }
  }

  return {
    step: captured,
    ok,
    sessionId,
    serverInfo: ok && responseBody && typeof responseBody === 'object' ? responseBody.result?.serverInfo ?? null : null,
  };
}

/**
 * T4 — tools/list: the MCP server's tool catalog.
 */
export async function mcpListTools(accessToken, sessionId) {
  const body = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

  const { captured, responseBody, ok } = await captureMcpPost(
    { id: 'T4', title: 'List MCP Tools', badge: 'MCP', from: 'Agent', to: 'GitHub MCP Server' },
    config.mcpGithub.url,
    accessToken,
    sessionId,
    body
  );

  return {
    step: captured,
    ok,
    tools: ok && responseBody && typeof responseBody === 'object' ? responseBody.result?.tools ?? [] : null,
  };
}

/**
 * T4 — tools/call get_me: the GitHub identity behind the brokered token.
 */
export async function mcpCallGetMe(accessToken, sessionId) {
  const body = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_me', arguments: {} } };

  const { captured, responseBody, ok } = await captureMcpPost(
    { id: 'T4', title: 'Call get_me Tool', badge: 'MCP', from: 'Agent', to: 'GitHub MCP Server' },
    config.mcpGithub.url,
    accessToken,
    sessionId,
    body
  );

  return {
    step: captured,
    ok,
    result: ok && responseBody && typeof responseBody === 'object' ? responseBody.result ?? null : null,
  };
}

/**
 * Revoke the brokered MCP GitHub token stored in Okta (so the next exchange
 * re-prompts for consent). Authenticated as the agent via private_key_jwt
 * (RFC 7009 revoke).
 */
export async function revokeMcpGithubToken(token) {
  const clientAssertion = await buildClientAssertion({
    clientId: config.agent.clientId,
    audience: config.mcpGithub.revokeAssertionAudience,
    kid: config.agent.kid,
    privateKeyFile: config.agent.privateKeyFile,
    privateKey: config.agent.privateKey,
  });

  const bodyParams = {
    token,
    token_type_hint: 'oauth_sts',
    client_assertion_type: CLIENT_ASSERTION_TYPE,
    client_assertion: clientAssertion,
  };

  const { captured, ok } = await captureFormPost(
    { id: 'R1', title: 'Revoke MCP GitHub Token', badge: 'Revoke', from: 'Agent', to: 'Okta Org Server' },
    config.mcpGithub.revokeUrl,
    {},
    bodyParams
  );

  return { step: captured, ok };
}
