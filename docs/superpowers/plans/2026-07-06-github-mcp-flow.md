# MCP Broker (GitHub) Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a seventh flow card, **MCP Broker (GitHub)** (`flow=mcp-github`): Okta STS token exchange (MCP-server resource connection) → MCP protocol (JSON-RPC over Streamable HTTP) against a GitHub Enterprise MCP server.

**Architecture:** Duplicate-and-adapt, fully self-contained. One new server module (`server/xaa/mcpGithubBroker.js`) holds the T2 STS exchange, an MCP-aware capture helper, three MCP calls (initialize, tools/list, tools/call get_me), and revoke. `ask.js`, `config.js`, and the three client files get strictly additive edits. No existing flow file is modified.

**Tech Stack:** Node ESM (Express), native `fetch`, React 18 + Vite. No new dependencies. No test suite exists — each task verifies with `node --check`, targeted `node -e` smoke checks, and `npm run build`.

**Spec:** `docs/superpowers/specs/2026-07-06-github-mcp-flow-design.md`

## Global Constraints

- Strictly additive: `git diff` for `server/xaa/stsBroker.js`, `server/xaa/azureStsBroker.js`, `server/xaa/capture.js`, `server/mcp/inventoryServer.js` must stay **empty** at every commit; existing branches in `server/routes/ask.js` and existing entries in the client files stay byte-identical.
- Flow id is exactly `mcp-github`; session key is exactly `req.session.mcpGithubStsToken`.
- Env var names exactly: `MCP_GITHUB_RESOURCE`, `MCP_GITHUB_URL`, `MCP_GITHUB_SCOPES`. None added to `REQUIRED` in `config.js`.
- Unconfigured answer exactly: `MCP GitHub flow is not configured — set MCP_GITHUB_RESOURCE and MCP_GITHUB_URL.`
- MCP protocol version string exactly `2025-06-18`.
- Step ids/titles exactly: T2 `MCP Token Exchange` (badge `STS`), T3 `MCP Initialize` (badge `MCP`), T4 `List MCP Tools` / `Call get_me Tool` (badge `MCP`), R1 `Revoke MCP GitHub Token` (badge `Revoke`). `to` for MCP steps is `GitHub MCP Server`.
- Card copy: name `MCP Broker (GitHub)`, accent `#8957e5`, suggestions `List MCP tools` / `Who am I on GitHub`.
- Curly quotes (`“ ”`) in user-facing revoke/greeting strings, matching the existing code style.
- No new npm dependencies.
- Commits go on branch `feature/mcp-github` (Task 0 creates it).

---

### Task 0: Branch

**Files:** none

- [ ] **Step 1: Create the feature branch**

```bash
cd /Users/shafiqksm/claude/O4AA-Agent-Flows
git checkout -b feature/mcp-github
```

Expected: `Switched to a new branch 'feature/mcp-github'`

---

### Task 1: Config block + env sample

**Files:**
- Modify: `server/config.js` (insert after the `graph:` block, before `// Secrets flow (T2)`)
- Modify: `.env-sample` (append after the Azure block)

**Interfaces:**
- Produces: `config.mcpGithub` = `{ tokenUrl, revokeUrl, assertionAudience, revokeAssertionAudience, resource, scopes, url }` — consumed by Task 2.

- [ ] **Step 1: Add the `mcpGithub` config block**

In `server/config.js`, directly after the closing `},` of the `graph:` block (currently `apiBaseUrl: process.env.GRAPH_API_BASE_URL || 'https://graph.microsoft.com/v1.0',` / `},`) and before the `// Secrets flow (T2)` comment, insert:

```js
  // MCP broker flow (GitHub) — same STS mechanics as the GitHub/Azure STS flows,
  // but the brokered token is used to speak MCP (JSON-RPC) to a GitHub MCP server.
  mcpGithub: {
    tokenUrl: ORG_TOKEN_URL,
    revokeUrl: ORG_REVOKE_URL,
    assertionAudience: ORG_TOKEN_URL,
    revokeAssertionAudience: process.env.STS_REVOKE_AUDIENCE || ORG_REVOKE_URL,
    resource: process.env.MCP_GITHUB_RESOURCE,
    // Optional 'scope' on the STS token-exchange (omitted if blank). The brokered
    // token's actual scopes are governed by the Okta MCP-server connection.
    scopes: process.env.MCP_GITHUB_SCOPES || undefined,
    // Base URL registered in Okta Directory → MCP Servers.
    url: process.env.MCP_GITHUB_URL,
  },
```

Do NOT touch the `REQUIRED` array.

- [ ] **Step 2: Append to `.env-sample`**

Append at the end of `.env-sample`:

```env

# ── MCP Broker flow (GitHub): token-exchange → brokered token → GitHub MCP server ──
# Resource indicator (ORN) from the MCP-server Resource Connection on the AI Agent.
MCP_GITHUB_RESOURCE=<orn of the MCP server resource connection>
# Base URL registered in Okta Directory → MCP Servers.
MCP_GITHUB_URL=<https://your-mcp-server/mcp>
# Optional 'scope' on the STS token-exchange (omitted if blank).
MCP_GITHUB_SCOPES=
```

- [ ] **Step 3: Verify**

```bash
node --check server/config.js
node -e "import('./server/config.js').then(m => { const c = m.config.mcpGithub; if (!c || !c.tokenUrl || !('resource' in c) || !('url' in c)) { console.error('mcpGithub block wrong:', c); process.exit(1);} console.log('mcpGithub OK:', JSON.stringify(c)); })"
grep -c "MCP_GITHUB" .env-sample
```

Expected: syntax check silent; `mcpGithub OK: {...}` with `tokenUrl` ending `/oauth2/v1/token`; grep prints `3`.

- [ ] **Step 4: Verify no secrets in `.env-sample`**

```bash
grep -E "MDByK|wlp10|0oa10|ntrsoiesys|octocorp|rsc110" .env-sample || echo CLEAN
```

Expected: `CLEAN`

- [ ] **Step 5: Commit**

```bash
git add server/config.js .env-sample
git commit -m "feat(mcp-github): add mcpGithub config block and env sample entries"
```

---

### Task 2: `server/xaa/mcpGithubBroker.js`

**Files:**
- Create: `server/xaa/mcpGithubBroker.js`

**Interfaces:**
- Consumes: `config.mcpGithub` (Task 1), `captureFormPost` from `./capture.js`, `buildClientAssertion` from `./clientAssertion.js` (both existing — import only, never edit).
- Produces (consumed by Task 3):
  - `requestMcpGithubToken(idToken)` → `{ step, accessToken, ok, interactionUri }`
  - `mcpInitialize(accessToken)` → `{ step, ok, sessionId, serverInfo }`
  - `mcpListTools(accessToken, sessionId)` → `{ step, ok, tools }`
  - `mcpCallGetMe(accessToken, sessionId)` → `{ step, ok, result }`
  - `revokeMcpGithubToken(token)` → `{ step, ok }`

- [ ] **Step 1: Create the file with this exact content**

```js
import { config } from '../config.js';
import { captureFormPost } from './capture.js';
import { buildClientAssertion } from './clientAssertion.js';

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
```

- [ ] **Step 2: Syntax + export check**

```bash
node --check server/xaa/mcpGithubBroker.js
node -e "import('./server/xaa/mcpGithubBroker.js').then(m => { const need = ['requestMcpGithubToken','mcpInitialize','mcpListTools','mcpCallGetMe','revokeMcpGithubToken']; const missing = need.filter(n => typeof m[n] !== 'function'); if (missing.length) { console.error('missing exports:', missing); process.exit(1);} console.log('exports OK'); })"
```

Expected: `exports OK`

- [ ] **Step 3: SSE parser smoke check**

```bash
node -e "
const text = 'event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}\n\n';
const dataLines = text.split(/\r?\n/).filter((l) => l.startsWith('data:'));
const last = dataLines[dataLines.length - 1].slice(5).trim();
const parsed = JSON.parse(last);
if (!parsed.result || parsed.result.ok !== true) { console.error('SSE parse failed'); process.exit(1); }
console.log('SSE parse OK');
"
```

Expected: `SSE parse OK` (validates the parsing approach used by `parseSseBody`).

- [ ] **Step 4: Verify existing files untouched**

```bash
git diff --stat server/xaa/stsBroker.js server/xaa/azureStsBroker.js server/xaa/capture.js
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add server/xaa/mcpGithubBroker.js
git commit -m "feat(mcp-github): add MCP GitHub broker module (STS T2, MCP T3/T4, revoke)"
```

---

### Task 3: Route the flow in `ask.js`

**Files:**
- Modify: `server/routes/ask.js` — four additive edits: one import (after line 7's azureStsBroker import), one flow function (after `runStsAzureFlow`, before `router.post('/ask'…)`), one router branch (after the `sts-azure` branch, before the final `else`), one endpoint (after the `/sts/azure/revoke` handler, before `export default router;`).

**Interfaces:**
- Consumes (Task 2): `requestMcpGithubToken(idToken)` → `{ step, accessToken, ok, interactionUri }`; `mcpInitialize(accessToken)` → `{ step, ok, sessionId, serverInfo }`; `mcpListTools(accessToken, sessionId)` → `{ step, ok, tools }`; `mcpCallGetMe(accessToken, sessionId)` → `{ step, ok, result }`; `revokeMcpGithubToken(token)` → `{ step, ok }`.
- Produces: `POST /api/ask` handles `flow: 'mcp-github'`; `POST /api/mcp/github/revoke` (consumed by Task 4's `revokeMcpGithub()`).

- [ ] **Step 1: Add the import**

After the existing line
`import { requestAzureResourceToken, getMyProfile, getMyGroups, revokeAzureStsToken } from '../xaa/azureStsBroker.js';`
add:

```js
import { requestMcpGithubToken, mcpInitialize, mcpListTools, mcpCallGetMe, revokeMcpGithubToken } from '../xaa/mcpGithubBroker.js';
```

- [ ] **Step 2: Add `runMcpGithubFlow`**

Insert after the closing `}` of `runStsAzureFlow` and before the `router.post('/ask', …)` line:

```js
// MCP broker (GitHub): resource token exchange (with consent loop) → MCP protocol calls.
async function runMcpGithubFlow(idToken, steps, action) {
  if (!config.mcpGithub.resource || !config.mcpGithub.url) {
    return { answer: 'MCP GitHub flow is not configured — set MCP_GITHUB_RESOURCE and MCP_GITHUB_URL.' };
  }

  const t2 = await requestMcpGithubToken(idToken);
  steps.push(t2.step);
  if (!t2.ok) {
    if (t2.interactionUri) {
      return {
        answer:
          'Consent required: authorize the GitHub MCP connection, then click Retry to re-run the request.',
        interaction: { uri: t2.interactionUri },
      };
    }
    return { answer: 'The resource token request failed — see step T2 for the error response.' };
  }

  const mcpGithubStsToken = t2.accessToken;

  const t3 = await mcpInitialize(mcpGithubStsToken);
  steps.push(t3.step);
  if (!t3.ok) {
    return { answer: 'The MCP initialize call failed — see step T3 for the response.', mcpGithubStsToken };
  }

  if (action === 'whoami') {
    const t4 = await mcpCallGetMe(mcpGithubStsToken, t3.sessionId);
    steps.push(t4.step);
    if (!t4.ok) {
      return { answer: 'The get_me tool call failed — see step T4 for the response.', mcpGithubStsToken };
    }
    const text = t4.result?.content?.find((c) => c.type === 'text')?.text;
    let me = null;
    if (text) {
      try {
        me = JSON.parse(text);
      } catch {
        // Keep the raw text if the tool returned non-JSON content.
      }
    }
    return {
      answer: me
        ? `You are ${me.login ?? 'unknown'}${me.name ? ` (${me.name})` : ''} on GitHub.`
        : `get_me returned:\n\n${text ?? JSON.stringify(t4.result, null, 2)}`,
      mcpGithubStsToken,
    };
  }

  const t4 = await mcpListTools(mcpGithubStsToken, t3.sessionId);
  steps.push(t4.step);
  if (!t4.ok) {
    return { answer: 'The tools/list call failed — see step T4 for the response.', mcpGithubStsToken };
  }
  const tools = t4.tools || [];
  return {
    answer: tools.length
      ? `The GitHub MCP server exposes ${tools.length} tool(s). First ${Math.min(10, tools.length)}:\n\n` +
        tools.slice(0, 10).map((t) => `• ${t.name}`).join('\n')
      : 'The MCP server returned no tools.',
    mcpGithubStsToken,
  };
}
```

- [ ] **Step 3: Add the router branch**

In `router.post('/ask', …)`, after the closing `}` of the `else if (flow === 'sts-azure') { … }` block and before the final `} else {`, insert:

```js
    } else if (flow === 'mcp-github') {
      const action = /\bwho\b|whoami|profile|\bme\b/i.test(question || '') ? 'whoami' : 'tools';
      const r = await runMcpGithubFlow(req.session.idToken, steps, action);
      answer = r.answer;
      interaction = r.interaction;
      if (r.mcpGithubStsToken) req.session.mcpGithubStsToken = r.mcpGithubStsToken;
```

(The final `} else {` line that follows already exists — do not duplicate it. The result reads `… } else if (flow === 'mcp-github') { … } else { answer = await runXaaFlow(…); }`.)

- [ ] **Step 4: Add the revoke endpoint**

After the closing `});` of the `/sts/azure/revoke` handler and before `export default router;`, insert:

```js
// Revoke the stored MCP GitHub token (agent-authenticated) so the next exchange re-prompts consent.
router.post('/mcp/github/revoke', async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'not_authenticated' });
  }
  const token = req.session.mcpGithubStsToken;
  if (!token) {
    return res.json({
      answer: 'No MCP GitHub token to revoke yet — run “List MCP tools” first to obtain one.',
      steps: [],
    });
  }
  try {
    const r = await revokeMcpGithubToken(token);
    if (r.ok) req.session.mcpGithubStsToken = undefined;
    res.json({
      answer: r.ok
        ? 'MCP GitHub token revoked. Run “List MCP tools” again to re-trigger consent.'
        : 'Revoke request failed — see the step for details.',
      steps: [r.step],
    });
  } catch (err) {
    console.error('[mcp/github/revoke] error:', err);
    res.json({ answer: `Revoke error: ${err.message}`, steps: [] });
  }
});
```

- [ ] **Step 5: Verify**

```bash
node --check server/routes/ask.js
git diff server/routes/ask.js | grep -c '^-[^-]'
```

Expected: syntax check silent; grep prints `0` (zero removed lines — pure insertions).

- [ ] **Step 6: Commit**

```bash
git add server/routes/ask.js
git commit -m "feat(mcp-github): route mcp-github flow and add /api/mcp/github/revoke"
```

---

### Task 4: Client card

**Files:**
- Modify: `client/src/flows.js` (new entry after `'sts-azure'`)
- Modify: `client/src/api.js` (new function after `revokeAzureSts`)
- Modify: `client/src/components/Chat.jsx` (import, greeting, revoke picker, placeholder, revoke-bar condition)

**Interfaces:**
- Consumes: `POST /api/mcp/github/revoke` (Task 3).
- Produces: flow card `mcp-github` selectable in the UI.

- [ ] **Step 1: Add the flow entry**

In `client/src/flows.js`, after the closing `},` of the `'sts-azure'` entry (before the final `};`), insert:

```js
  'mcp-github': {
    id: 'mcp-github',
    name: 'MCP Broker (GitHub)',
    tagline: 'token-exchange → MCP session → GitHub tools',
    description:
      'Exchange the user’s ID token for a brokered token via the MCP-server resource connection. If consent is needed, Okta returns interaction_required — authorize, then retry — and the agent speaks MCP (JSON-RPC) to the GitHub MCP server: initialize the session, list its tools, or call get_me.',
    accent: '#8957e5',
    suggestions: [
      { label: 'List MCP tools', text: 'List MCP tools' },
      { label: 'Who am I on GitHub', text: 'Who am I on GitHub' },
    ],
  },
```

- [ ] **Step 2: Add the revoke API helper**

In `client/src/api.js`, after the `revokeAzureSts` function, insert:

```js
export async function revokeMcpGithub() {
  const res = await fetch('/api/mcp/github/revoke', {
    method: 'POST',
    credentials: 'include',
  });
  return res.json();
}
```

- [ ] **Step 3: Update the Chat.jsx import**

Replace:

```js
import { ask, revokeSts, revokeAzureSts } from '../api.js';
```

with:

```js
import { ask, revokeSts, revokeAzureSts, revokeMcpGithub } from '../api.js';
```

- [ ] **Step 4: Extend the greeting ternary**

Replace:

```js
        flow.id === 'sts-github'
          ? 'Click “Read pull requests” or “Create a pull request” to start.'
          : flow.id === 'sts-azure'
            ? 'Click “Get my Azure profile” or “List my groups” to start.'
            : 'Ask me about inventory or recent shipments.'
```

with:

```js
        flow.id === 'sts-github'
          ? 'Click “Read pull requests” or “Create a pull request” to start.'
          : flow.id === 'sts-azure'
            ? 'Click “Get my Azure profile” or “List my groups” to start.'
            : flow.id === 'mcp-github'
              ? 'Click “List MCP tools” or “Who am I on GitHub” to start.'
              : 'Ask me about inventory or recent shipments.'
```

- [ ] **Step 5: Extend the revoke picker**

Replace:

```js
      const res = flow.id === 'sts-azure' ? await revokeAzureSts() : await revokeSts();
```

with:

```js
      const res =
        flow.id === 'sts-azure'
          ? await revokeAzureSts()
          : flow.id === 'mcp-github'
            ? await revokeMcpGithub()
            : await revokeSts();
```

- [ ] **Step 6: Extend the input placeholder**

Replace:

```js
              flow.id === 'sts-github'
                ? 'Ask the agent to read pull requests…'
                : flow.id === 'sts-azure'
                  ? 'Ask the agent for your Azure profile…'
                  : 'Ask about inventory or shipments…'
```

with:

```js
              flow.id === 'sts-github'
                ? 'Ask the agent to read pull requests…'
                : flow.id === 'sts-azure'
                  ? 'Ask the agent for your Azure profile…'
                  : flow.id === 'mcp-github'
                    ? 'Ask the agent to list MCP tools…'
                    : 'Ask about inventory or shipments…'
```

- [ ] **Step 7: Extend the revoke-bar condition**

Replace:

```js
        {(flow.id === 'sts-github' || flow.id === 'sts-azure') && (
```

with:

```js
        {(flow.id === 'sts-github' || flow.id === 'sts-azure' || flow.id === 'mcp-github') && (
```

- [ ] **Step 8: Build to verify**

```bash
npm run build
```

Expected: Vite build completes with no errors (`✓ built in …`).

- [ ] **Step 9: Commit**

```bash
git add client/src/flows.js client/src/api.js client/src/components/Chat.jsx
git commit -m "feat(mcp-github): add MCP Broker (GitHub) card with revoke support"
```

---

### Task 5: Documentation

**Files:**
- Modify: `OKTA_SETUP.md` (new section before `## Run the app`; update flow-count wording)
- Modify: `UNDERSTANDING.md` (new flow section; update flow-count wording)

- [ ] **Step 1: Add the OKTA_SETUP.md section**

Insert before the `## Run the app` heading:

````markdown
## GitHub MCP Server flow

This flow exchanges an Okta token for a brokered token via an **MCP-server resource
connection**, then speaks MCP protocol (JSON-RPC over Streamable HTTP) to the GitHub
MCP server: initialize, list tools, or call the `get_me` tool.

### Step A — Register the MCP server in Okta

1. In Okta Admin, go to **Directory → MCP Servers → Add MCP server**
2. Fill in:
   - **Name:** `GitHub MCP Server`
   - **Base URL:** your GitHub MCP endpoint (e.g. `https://copilot-api.<your-ghe-host>/mcp`) —
     it can't be changed later
3. Add a **client credential set**: the client ID and client secret of the GitHub OAuth
   app (the MCP server's preregistered confidential OAuth client — Dynamic Client
   Registration is not supported), plus any scopes
4. Save — the server shows as **ACTIVE** on the MCP Servers page

### Step B — Add the MCP server as a Resource Connection on the AI Agent

1. Go to **Directory → AI Agents** → open your **XAA AI Agent**
2. Click the **Resource Connections** tab → **Add resource connection**
3. Select resource type **MCP server** and pick the server from Step A —
   the Resource Indicator populates automatically
4. Click **Add**, then copy the **ORN** shown for this connection → `MCP_GITHUB_RESOURCE`

### Update `.env`:

```env
MCP_GITHUB_RESOURCE=orn:oktapreview:idp:<org-id>:client-auth-settings:<connection-id>
MCP_GITHUB_URL=<the base URL from Step A>
MCP_GITHUB_SCOPES=
```

### Troubleshooting

| Symptom | Likely cause |
|---|---|
| T2 `interaction_required` loops forever | The GitHub OAuth app's callback URL isn't `https://<okta-domain>/oauth2/v1/sts/callback`, or the credential set on the MCP server entry is wrong |
| T3 initialize returns 401 | The brokered token isn't accepted by the MCP server — check the client credential set in Directory → MCP Servers |
| T3 initialize returns 404/405 | `MCP_GITHUB_URL` isn't the MCP endpoint (must be the same base URL registered in Okta) |
| `MCP GitHub flow is not configured` | `MCP_GITHUB_RESOURCE` or `MCP_GITHUB_URL` is blank in `.env` |
````

- [ ] **Step 2: Update flow counts in OKTA_SETUP.md**

```bash
grep -n -i "six" OKTA_SETUP.md
```

For each hit that refers to the number of flows, change "six" to "seven" (leave any unrelated hits alone).

- [ ] **Step 3: Add the UNDERSTANDING.md section**

Find the `### 6. STS Broker (Azure)` section; after it (before whatever section follows), insert:

```markdown
### 7. MCP Broker (GitHub)

`flow=mcp-github` — token-exchange → brokered token → GitHub MCP server (MCP protocol).

- **T2 — MCP Token Exchange**: identical STS mechanics to the GitHub/Azure STS flows
  (org token endpoint, `requested_token_type=urn:okta:params:oauth:token-type:oauth-sts`),
  but `resource` is the ORN of the **MCP-server** resource connection on the AI Agent.
  First run returns `interaction_required` — the same consent loop described in the STS
  Broker (GitHub) section above.
- **T3 — MCP Initialize**: the agent starts an MCP session with a JSON-RPC `initialize`
  request (Streamable HTTP transport). The response carries an `Mcp-Session-Id` header
  echoed on every subsequent call, and the agent fires the `notifications/initialized`
  notification.
- **T4 — List MCP Tools / Call get_me Tool**: `tools/list` returns the server's tool
  catalog; `tools/call` with `name: "get_me"` returns the GitHub identity behind the
  brokered token. JSON-RPC errors (HTTP 200 with an `error` member) render as failed steps.
- **Revoke**: same RFC 7009 revoke (`token_type_hint=oauth_sts`) as the other STS flows —
  the next ask re-triggers consent.

Server code: `server/xaa/mcpGithubBroker.js` (self-contained, including its own
MCP-aware capture helper — `capture.js` is untouched).
```

- [ ] **Step 4: Update flow counts in UNDERSTANDING.md**

```bash
grep -n -i "six" UNDERSTANDING.md
```

Change "The six flows" to "The seven flows" and any other flow-count references from six to seven (leave unrelated hits alone).

- [ ] **Step 5: Commit**

```bash
git add OKTA_SETUP.md UNDERSTANDING.md
git commit -m "docs(mcp-github): setup steps and flow description; count to seven"
```

---

### Task 6: Whole-branch verification

**Files:** none (verification only)

- [ ] **Step 1: Isolation check — existing flow files byte-identical**

```bash
git diff master...HEAD --stat -- server/xaa/stsBroker.js server/xaa/azureStsBroker.js server/xaa/capture.js server/xaa/clientAssertion.js server/mcp/inventoryServer.js server/xaa/tokenExchange.js server/xaa/credentialExchange.js server/xaa/serviceFlow.js
```

Expected: no output.

- [ ] **Step 2: ask.js is pure insertions**

```bash
git diff master...HEAD -- server/routes/ask.js | grep -c '^-[^-]'
```

Expected: `0`

- [ ] **Step 3: Syntax + build**

```bash
node --check server/config.js && node --check server/routes/ask.js && node --check server/xaa/mcpGithubBroker.js
npm run build
```

Expected: silent checks; Vite build succeeds.

- [ ] **Step 4: Unconfigured-guard smoke check**

```bash
node -e "
process.env.MCP_GITHUB_RESOURCE = '';
process.env.MCP_GITHUB_URL = '';
import('./server/config.js').then(m => {
  const c = m.config.mcpGithub;
  if (c.resource || c.url) { console.error('expected blank resource/url'); process.exit(1); }
  console.log('unconfigured guard inputs OK');
});
"
```

Expected: `unconfigured guard inputs OK`

- [ ] **Step 5: Manual browser verification (requires the user's Okta/GHE setup)**

Run `npm run dev`, open `http://localhost:5173`, sign in, and check:

1. All six existing cards still render; spot-check **Cross-App Access** and **STS Broker (GitHub)** end-to-end.
2. Pick **MCP Broker (GitHub)** → greeting says `Click “List MCP tools” or “Who am I on GitHub” to start.`
3. Click **List MCP tools** → first run: T2 shows `interaction_required` + consent card → **Authorize connection ↗** in a new tab → **Retry** → T2 200 → T3 `MCP Initialize` 200 → T4 tool list renders.
4. Click **Who am I on GitHub** → T4 `Call get_me Tool` shows the GitHub login.
5. Click **Revoke STS token** → R1 renders → next ask re-triggers the consent card.

Report any failing step with its response body rather than marking this task complete.
