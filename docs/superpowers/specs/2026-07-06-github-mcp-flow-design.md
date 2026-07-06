# MCP Broker (GitHub) Flow — Design

**Date:** 2026-07-06
**Status:** Approved (user: new card, additive-only, easy to revert)

## Goal

Add a seventh flow, **MCP Broker (GitHub)** (`flow=mcp-github`). The agent exchanges the
user's Okta `id_token` for a brokered GitHub token via Okta's STS (the MCP-server Resource
Connection on the AI Agent), then speaks **MCP protocol (JSON-RPC over Streamable HTTP)**
to the GitHub Enterprise-hosted MCP server. No existing flow, card, or shared server code
is modified — all integration edits are strictly additive.

## Okta-side configuration (already done by the user)

- **Directory → MCP Servers**: "GitHub MCP Server" registered with base URL
  `https://copilot-api.octocorp.ghe.com/mcp` and a client-credential set (the GitHub
  OAuth app's client ID/secret; confidential client, authorization-code flow).
- **AI Agent → Resource Connections → Add → type "MCP server"**: connection created,
  resource indicator `orn:oktapreview:idp:00o3m6magqT1j8efJ1d7:client-auth-settings:rsc11031i8gMCrWGt1d8`.

## Flow shape

```
T1  User logs in                               → id_token (existing, unchanged)
T2  STS token exchange (org token endpoint)    → brokered GitHub access token
     grant_type=…token-exchange, requested_token_type=urn:okta:params:oauth:token-type:oauth-sts,
     subject_token=id_token, resource=MCP_GITHUB_RESOURCE, client_assertion (agent key)
     ↳ interaction_required → consent card (Authorize ↗ / Retry), same contract as GitHub/Azure
T3a MCP initialize        → protocol handshake; capture Mcp-Session-Id response header
T3b tools/list            → tool catalog                      ("List MCP tools" chip)
T3c tools/call get_me     → the user's GitHub identity        ("Who am I on GitHub" chip)
R1  Revoke (RFC 7009, token_type_hint=oauth_sts) → re-triggers consent on next run
```

Per ask: T2 (or session-cached token) → T3a → then T3b **or** T3c depending on the chip.
A fresh MCP `initialize` runs on every ask so the step cards always show the full protocol
handshake.

## Approach

**Duplicate-and-adapt, fully self-contained module** (same pattern as the Azure STS flow,
per explicit user preference: "new card, new code integration so cleaner and easy to fix
and revert"). T3 uses **raw JSON-RPC POSTs**, not the `@modelcontextprotocol/sdk` client —
the SDK hides the HTTP exchange, and this demo's entire purpose is showing every request
on a step card.

## Server changes

### New file: `server/xaa/mcpGithubBroker.js` (only new server file)

Contains everything, including its own MCP-aware capture helper so `capture.js` is not
touched.

| Function | Behavior |
|---|---|
| `requestMcpGithubToken(idToken)` | Copy of the GitHub STS `requestResourceToken`, but `resource = config.mcpGithub.resource`, optional `scope = config.mcpGithub.scopes`. Returns `{ step, accessToken, ok, interactionUri }`. Step: `id: 'T2'`, title `MCP Token Exchange`, badge `STS`, from `Agent`, to `Okta Org Server`, tokenField `access_token`. Extracts `interaction_uri` when `responseBody.error === 'interaction_required'`. |
| `mcpInitialize(accessToken)` | JSON-RPC `initialize` (id 1) + fire-and-forget `notifications/initialized`. Returns `{ step, ok, sessionId, serverInfo }` where `sessionId` comes from the `Mcp-Session-Id` response header (may be absent — pass through as `undefined`). Step: `id: 'T3'`, title `MCP Initialize`, badge `MCP`, from `Agent`, to `GitHub MCP Server`. |
| `mcpListTools(accessToken, sessionId)` | JSON-RPC `tools/list` (id 2). Returns `{ step, ok, tools }` (`result.tools` array). Step: `id: 'T4'`, title `List MCP Tools`, badge `MCP`. |
| `mcpCallGetMe(accessToken, sessionId)` | JSON-RPC `tools/call` (id 3) with `params: { name: 'get_me', arguments: {} }`. Returns `{ step, ok, result }` (`result` = JSON-RPC result). Step: `id: 'T4'`, title `Call get_me Tool`, badge `MCP`. |
| `revokeMcpGithubToken(token)` | Copy of the GitHub STS revoke: RFC 7009 at the org revoke endpoint, `token_type_hint: 'oauth_sts'`, agent `private_key_jwt`. Returns `{ step, ok }`. Step: `id: 'R1'`, title `Revoke MCP GitHub Token`. |

**Module-private `captureMcpPost(step, url, headers, jsonBody)`** — adapted copy of
`captureJsonPost` with two MCP-specific behaviors:

1. Request headers: `Content-Type: application/json`,
   `Accept: application/json, text/event-stream`, `MCP-Protocol-Version: 2025-06-18`,
   `Authorization: Bearer <token>` (masked in the displayed step), plus
   `Mcp-Session-Id: <sessionId>` when provided.
2. Response parsing: if the response `Content-Type` is `text/event-stream`, parse the SSE
   body — split on lines, collect `data:` payloads, `JSON.parse` the last data payload
   (the JSON-RPC response) and use it as the step's response body. Otherwise parse as
   JSON with text fallback (same as `captureJsonPost`).

The captured step records the response's `Mcp-Session-Id` header (visible in the
Response tab) and the function returns it alongside the parsed body.

### `server/config.js` (additive block only)

```js
mcpGithub: {
  tokenUrl: ORG_TOKEN_URL,
  revokeUrl: ORG_REVOKE_URL,
  assertionAudience: ORG_TOKEN_URL,
  revokeAssertionAudience: process.env.STS_REVOKE_AUDIENCE || ORG_REVOKE_URL,
  resource: process.env.MCP_GITHUB_RESOURCE,
  scopes: process.env.MCP_GITHUB_SCOPES || undefined,
  url: process.env.MCP_GITHUB_URL,
},
```

Not added to `REQUIRED`. If `MCP_GITHUB_RESOURCE` or `MCP_GITHUB_URL` is blank the flow
answers "MCP GitHub flow is not configured — set MCP_GITHUB_RESOURCE and MCP_GITHUB_URL."

### `server/routes/ask.js` (additive only — existing branches byte-identical)

- Import the five functions from `mcpGithubBroker.js`.
- New `runMcpGithubFlow(idToken, steps, question)`:
  - Unconfigured guard (message above).
  - `action = 'whoami'` when the question matches `/\bwho\b|whoami|profile|\bme\b/i`,
    else `'tools'`.
  - Run `requestMcpGithubToken` on every ask (same as the GitHub/Azure STS flows — the
    T2 card always renders); on `interaction_required` return
    `{ answer, interaction: { uri } }` (same contract the client consent card already
    handles); on success return the token so the router stores it in
    `req.session.mcpGithubStsToken` for the revoke endpoint.
  - Run `mcpInitialize`; if it fails, return with the failed step (answer explains the
    MCP initialize failed).
  - `tools`: `mcpListTools` → answer lists tool count and first 10 tool names.
  - `whoami`: `mcpCallGetMe` → parse `result.content[0].text` as JSON when possible and
    answer with login/name; fall back to the raw text.
- Router branch: `else if (flow === 'mcp-github') { … }`.
- New endpoint `router.post('/mcp/github/revoke', …)` — mirrors `/sts/revoke` using
  `req.session.mcpGithubStsToken` and `revokeMcpGithubToken`.

## Client changes (additive only)

- **`client/src/flows.js`** — new entry:
  - id `mcp-github`, name `MCP Broker (GitHub)`, accent `#8957e5`
  - tagline: `token-exchange → MCP session → GitHub tools`
  - suggestions: `List MCP tools`, `Who am I on GitHub`
- **`client/src/api.js`** — `revokeMcpGithub()` → `POST /api/mcp/github/revoke`
  (`credentials: 'include'`), alongside the existing revoke helpers.
- **`client/src/components/Chat.jsx`** — three additive edits mirroring the Azure ones:
  greeting branch for `mcp-github` ('Click "List MCP tools" or "Who am I on GitHub" to
  start.'), input placeholder variant, revoke bar condition extended to include
  `mcp-github` with `revoke()` picking `revokeMcpGithub()` by `flow.id`. The consent card
  is already generic over `interaction.uri` — untouched.
- **`client/src/paramGlossary.js`** — NOT touched: its `describedParamsFromBody` only
  parses `x-www-form-urlencoded` bodies, so JSON-RPC entries would be dead code (YAGNI).
  The T2 form-urlencoded exchange already gets full glossary coverage.

## Environment variables (already added to `.env`)

```env
# ── MCP Broker flow (GitHub): token-exchange → brokered token → GitHub MCP server ──
MCP_GITHUB_RESOURCE=orn:oktapreview:idp:00o3m6magqT1j8efJ1d7:client-auth-settings:rsc11031i8gMCrWGt1d8
MCP_GITHUB_URL=https://copilot-api.octocorp.ghe.com/mcp
MCP_GITHUB_SCOPES=
```

Placeholder versions go in `.env-sample`.

## Documentation

- **OKTA_SETUP.md** — new "GitHub MCP Server flow" section: register the MCP server under
  **Directory → MCP Servers** (name, base URL, client-credential set from the GitHub OAuth
  app), add a Resource Connection of type **MCP server** on the AI Agent, copy the ORN.
  Troubleshooting rows: consent loop (`interaction_required`), 401 from the MCP server
  (brokered token rejected / wrong credential set), 404/405 (base URL not the MCP
  endpoint). Flow count references updated to seven.
- **UNDERSTANDING.md** — new "### 7. MCP Broker (GitHub)" section; consent-loop details
  cross-reference the existing GitHub STS write-up. Heading updated to "The seven flows".

## Error handling

- T2 `interaction_required` → consent card with authorize link + retry (existing UI).
- Other T2 errors → failed T2 step with the raw Okta error body.
- MCP HTTP errors (401/403/404) or JSON-RPC `error` responses → failed step with the raw
  body; JSON-RPC-level errors (HTTP 200 with `error` in the payload) mark the step
  `ok: false`.
- Network errors surface as the standard `network_error` response body from the capture
  helper.

## Verification (manual — no test suite exists)

1. `git diff` shows zero changes to `server/xaa/stsBroker.js`, `server/xaa/azureStsBroker.js`,
   `server/xaa/capture.js`, and the existing branches of `ask.js`.
2. All six existing cards still work (spot-check XAA and STS GitHub).
3. With `MCP_GITHUB_RESOURCE` blank → "not configured" answer, no crash.
4. MCP flow first run → consent card → authorize → Retry → T2 200 → T3 initialize 200 →
   T4 tools list renders.
5. "Who am I on GitHub" → T4 shows `get_me` result with the GitHub login.
6. Revoke → next ask re-triggers consent.
