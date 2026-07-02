# Project Deep Dive — Okta for AI Agent Flows (O4AA)

A detailed explanation of how this codebase works: what it does, why each piece exists, and how every part connects.

---

## What this project is

This is an **educational demo** — not a production app — that makes Okta's AI-agent token-exchange patterns *visible*. The point is that a user logs in, picks one of six authentication flows, asks a question in a chat UI, and then watches **every individual HTTP call** in the resulting chain rendered as a step card, complete with the raw request, the raw response, any decoded JWT, and a copy-paste `curl` snippet.

The goal is to let a developer or solutions engineer read and understand the exact protocol mechanics of each flow without reading RFCs.

---

## The six flows

All six flows end by calling an **inventory MCP tool** (or a GitHub / Microsoft Graph API). The difference is *how the agent authenticates* to reach that tool.

### 1. Cross-App Access (XAA) — `flow=xaa`

The canonical AI-agent identity pattern.

```
T1  User logs in (OIDC / PKCE)         → id_token stored in session
T2  Agent exchanges id_token → id-JAG  (token-exchange, private_key_jwt)
T3  Agent exchanges id-JAG  → access token  (jwt-bearer, private_key_jwt)
T4  Agent calls MCP with access token  (Bearer, JWKS-validated server-side)
```

- **T2** sends `grant_type=urn:ietf:params:oauth:grant-type:token-exchange` with `subject_token=id_token` and `requested_token_type=urn:ietf:params:oauth:token-type:id-jag` to **AGENT_AUTH_SERVER**.
- **T3** sends `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` with the id-JAG as `assertion` to **RESOURCE_AUTH_SERVER**. The response is a proper access token scoped to the resource.
- **T4** decodes and verifies that access token (JWKS signature, issuer, expiry, required scopes) *before* calling the MCP tool — demonstrating what a real resource server would do.

### 2. Secrets — `flow=secrets`

```
T1  User logs in                        → id_token
T2  Agent exchanges id_token → vaulted secret  (token-exchange, ORG endpoint)
T3  Agent calls MCP with HTTP Basic auth using retrieved username/password
```

`requested_token_type` is `urn:okta:params:oauth:token-type:vaulted-secret`. The ORG token endpoint (`/oauth2/v1/token`, not a custom auth server) is always used. The response carries a `username` and `password` from Okta Privileged Access; those are compared against `MCP_BASIC_USERNAME` / `MCP_BASIC_PASSWORD`.

### 3. Service Accounts — `flow=service-account`

Structurally identical to Secrets but `requested_token_type` = `urn:okta:params:oauth:token-type:service-account` and `ACCOUNT_RESOURCE` points to a service account ORN rather than a secret ORN.

### 4. NHI / Client Credentials — `flow=client-credentials`

No user involved. A headless service identity authenticates with its own key.

```
T1  Service app: client_credentials + private_key_jwt  → service access token
T2  Service app exchanges service token → id-JAG  (same token-exchange as XAA T2)
T3  Service app exchanges id-JAG → resource access token
T4  Calls MCP (same as XAA T4)
```

The service app uses a *separate* RSA key (`keys/service.pem`, `SERVICE_KID`) and a separate Okta client (`SERVICE_CLIENT_ID`). T2 and T3 reuse the same auth servers and resource audience as XAA.

### 5. STS Broker (GitHub) — `flow=sts-github`

```
T1  User logs in                              → id_token
T2  Agent exchanges id_token → GitHub token  (oauth-sts token-exchange, ORG endpoint)
     ↳ if interaction_required: show consent link, wait for retry
T3  Agent reads or creates a GitHub pull request with the brokered token
     (optional) Revoke: RFC 7009 revoke at ORG revoke endpoint
```

The `requested_token_type` is `urn:okta:params:oauth:token-type:oauth-sts`. On the first call, Okta may return HTTP 400 `interaction_required` with an `interaction_uri`; the UI surfaces that URI so the user can authorize the GitHub connection, then retries the identical request. The stored STS token can be revoked (also agent-authenticated with `private_key_jwt`) to re-trigger consent.

#### The consent loop in detail

The STS flow has a built-in interactive consent gate. Here is exactly what happens on each run:

**First run — consent not yet granted:**

1. `stsBroker.js → requestResourceToken()` posts a token exchange to the org endpoint (`/oauth2/v1/token`) with:
   - `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`
   - `requested_token_type=urn:okta:params:oauth:token-type:oauth-sts`
   - `subject_token=<id_token>` (the user's login token from session)
   - `resource=<GITHUB_RESOURCE ORN>` (identifies the GitHub resource connection)
   - `client_assertion=<private_key_jwt>` (agent authenticates with its RSA key)
2. Okta has no stored consent for this user + GitHub connection, so it returns **HTTP 400**:
   ```json
   { "error": "interaction_required", "interaction_uri": "https://ntrsoiesys.oktapreview.com/..." }
   ```
3. `stsBroker.js` detects `error === 'interaction_required'`, extracts `interaction_uri`, and returns it alongside the failed T2 step.
4. `routes/ask.js → runStsGithubFlow()` sees `t2.interactionUri` set and returns early:
   ```json
   { "answer": "Consent required ...", "interaction": { "uri": "..." }, "steps": [<T2 step>] }
   ```
5. The client's `Chat.jsx` receives `res.interaction.uri` and stores it in `interaction` state.
6. The UI renders two controls:
   - **"Authorize connection ↗"** — an `<a>` tag opening `interaction_uri` in a new tab. This takes the user through Okta's consent page for the GitHub OAuth App, where they authorize Okta to obtain a brokered GitHub token on their behalf.
   - **"Retry"** — a button that re-submits the exact same `POST /api/ask` payload (same question, same flow key) as a brand-new request.

**After consent — the retry:**

1. User clicks **"Authorize connection ↗"** and completes the Okta consent flow in the new tab. Okta stores the granted authorization internally.
2. User clicks **"Retry"** in the original tab. This fires the *identical* `POST /api/ask` request — no special parameter, no token passed back.
3. `requestResourceToken()` posts the same token exchange request to the org endpoint.
4. This time Okta finds stored consent and returns **HTTP 200** with a brokered GitHub access token in `access_token`.
5. The flow continues to T3: the agent uses the brokered token to call the GitHub API (read PRs or create a PR).
6. `routes/ask.js` stores the STS token in `req.session.stsAccessToken` so the revoke endpoint can use it later.

**Why the retry works without any new input:**

The `interaction_uri` is a one-time gate, not a parameter the server needs back. Once the user consents, Okta's internal state changes — the next token exchange for the same user + resource connection succeeds automatically. The "Retry" button just re-runs the original request against the now-unlocked Okta state.

**Revoking consent (re-triggering the gate):**

Clicking **"Revoke STS token"** calls `POST /api/sts/revoke`, which:
1. Reads `req.session.stsAccessToken` (stored on the successful run).
2. Builds a new `private_key_jwt` assertion with audience = the org revoke endpoint.
3. Posts `token` + `token_type_hint=oauth_sts` to `/oauth2/v1/revoke` (RFC 7009).
4. On HTTP 200, clears the token from the session.

After revocation, Okta discards the stored brokered token for this user + connection. The next "Read pull requests" run will again receive `interaction_required`, cycling back to the start of the consent loop. This makes revocation a useful demo tool: it lets you observe the full consent flow a second time without creating a new user session.

### 6. STS Broker (Azure) — `flow=sts-azure`

```
T1  User logs in                                  → id_token
T2  Agent exchanges id_token → Graph token        (oauth-sts token-exchange, ORG endpoint)
     ↳ if interaction_required: show consent link, wait for retry
T3  Agent calls Microsoft Graph (GET /me or GET /me/memberOf)
     (optional) Revoke: RFC 7009 revoke at ORG revoke endpoint
```

Mechanically identical to the GitHub STS flow — same `requested_token_type`
(`urn:okta:params:oauth:token-type:oauth-sts`), same org token endpoint, same
consent loop and revoke behavior (see "The consent loop in detail" above; the
Azure flow reuses that exact pattern with its own resource ORN,
`AZURE_RESOURCE`, its own session token `azureStsAccessToken`, and its own
revoke endpoint `POST /api/sts/azure/revoke`). Only T3 differs: the brokered
token is a Microsoft Graph access token used to call `GET /me` ("Get my Azure
profile") or `GET /me/memberOf` ("List my groups"). Both reads need only the
delegated `User.Read` scope on the Entra app. Server module:
`server/xaa/azureStsBroker.js`.

---

## How the step pipeline works

This is the most important design pattern in the codebase.

### The step object

Every visible card in the UI maps 1:1 to a **step object**:

```js
{
  id: 'T2',
  title: 'Token Exchange',
  badge: 'ID-JAG',
  from: 'Agent',
  to: 'IdP',
  ok: boolean,
  request:  { method, url, headers, body },   // what was sent
  response: { status, headers, body },         // what came back
  token: { header, payload } | null,           // decoded JWT (display-only)
  code: string,                                // curl snippet
}
```

### How steps are created

There are two ways a step is created:

**1. Via `captureFormPost` / `captureGet` / `captureJsonPost` (`server/xaa/capture.js`)**

These are instrumented `fetch` wrappers. You call them with a `step` descriptor (id, title, badge, from, to, tokenField) + the URL + headers + body. They fire the real HTTP call, collect the request, response, and any decoded JWT from the response body, and return a fully-formed step object alongside the raw response body so the calling code can extract tokens.

`tokenField` tells `captureFormPost` which field in the JSON response to decode as a JWT (e.g. `'access_token'` for the id-JAG call even though id-JAGs are returned in the `access_token` field with `token_type: N_A`).

Authorization headers are masked in the display (first 8 + last 4 chars) so secrets don't leak into the visualization.

**2. Manually constructed (`routes/ask.js`)**

The MCP call is in-process (no HTTP), so it can't be captured. `buildMcpStep` and `buildBasicMcpStep` construct step objects with the same shape, fake method/URL, masked token, and a representative curl snippet. This is deliberate: the UI renders them identically.

The T1 login step is also manually constructed in `auth/oidc.js` (`buildLoginStep`) because the OIDC exchange is handled by `openid-client` internally — there is no raw fetch to intercept.

### How steps flow to the UI

`POST /api/ask` collects all steps into a `steps[]` array (push after each T), then returns:

```js
{ answer: string, toolName: string, flow: string, steps: [], interaction?: { uri } }
```

The client `SequenceView` renders each item in `steps[]` as a `StepCard`. The login step (`T1`) is fetched separately from `GET /api/me` and prepended by the client (except for the NHI flow where `prependLogin: false`).

---

## The `private_key_jwt` authentication model

All agent-to-Okta calls (T2, T3, T2 STS, revoke) are authenticated with a **signed JWT client assertion** (RFC 7523 §2.2), not a client secret.

`clientAssertion.js` is the single place where these JWTs are built:

- `iss` = `sub` = the client ID being authenticated (`AGENT_CLIENT_ID`, `RESOURCE_CLIENT_ID`, or `SERVICE_CLIENT_ID`)
- `aud` = the token endpoint URL the assertion is sent to (the "audience" must match the endpoint, not the issuer)
- `exp` = now + 300 seconds
- `jti` = a unique value to prevent replay

Keys are loaded on first use and cached in memory by file path (supports both PKCS#8 and PKCS#1 PEM formats). The agent key (`keys/agent.pem`) is used for T2 and T3 of XAA — T3 uses the *agent key* but asserts the *resource client ID*, because the resource client is configured in Okta with the same public key.

The NHI flow uses a separate service key (`keys/service.pem`) for its T1/T2/T3 assertions, signed as `SERVICE_CLIENT_ID`.

---

## The configuration system (`server/config.js`)

`config.js` does three things:

1. **Loads `.env`** from the project root regardless of launch directory.
2. **Derives endpoints** from base URLs. You configure `AGENT_AUTH_SERVER=https://org.okta.com/oauth2/<id>` and `config.agent.tokenUrl` becomes `https://org.okta.com/oauth2/<id>/v1/token` automatically. The same derivation covers the org endpoint (`/oauth2/v1/token`), custom auth servers, and the JWKS endpoint.
3. **Validates required vars** at startup, printing exactly which are missing and exiting — so the server never silently runs half-configured.

A key subtlety: Secrets, Service Accounts, and STS flows must use the **org** token endpoint (`/oauth2/v1/token`), not a custom auth server. `config.js` strips any `/oauth2/...` suffix from `OKTA_ISSUER` to get the org base URL.

---

## The MCP server

`server/mcp/inventoryServer.js` runs entirely **in-process**: it creates an MCP `Server`, wires it to a `Client` through an `InMemoryTransport`, and exposes two tools (`get_inventory_details`, `get_last_5_shipments`) backed by static data in `mcp/data.js`.

There is no network port. `callMcpTool(name)` just calls `mcpClient.callTool(...)` over the in-memory transport, which is synchronous from the server's perspective.

This architecture means:
- No extra port to configure or secure.
- The demo can run entirely locally without any real MCP infrastructure.
- The T4 "Bearer token validation" is still real — `verifyToken.js` validates the JWT against Okta's JWKS before calling `callMcpTool`, so the validation logic is genuine even though the MCP transport is synthetic.

---

## Token validation (`server/util/verifyToken.js`)

This simulates what a **real resource server** does when it receives a bearer token:

1. Fetch the JWKS from `RESOURCE_AUTH_SERVER/v1/keys` (cached per URI via `createRemoteJWKSet`).
2. Verify the JWT signature, issuer, and expiry using `jose`'s `jwtVerify`.
3. Extract scopes from `scp` (array) or `scope` (space-separated string) — Okta uses `scp`.
4. Check that all required scopes are present.

Returns a plain result object (never throws) with `ok: true` only if all checks pass. Insufficient scope → 403; invalid signature/expiry → 401. Both are rendered visually in the T4 step card.

---

## The OIDC / session model (`server/auth/oidc.js`)

- Uses `openid-client` with PKCE (S256 code challenge) and state + nonce for CSRF protection.
- On callback, stores `user`, `idToken`, and the constructed T1 `loginStep` on the Express session (`express-session`, in-memory, cookie `xaa.sid`).
- `GET /api/me` returns `{ authenticated, user, loginStep }` — the client fetches this on load to restore session state and to get the T1 step to prepend to flow results.
- `req.session.idToken` is the `id_token` passed as `subject_token` in every T2 token exchange.
- The STS flow additionally stores `stsAccessToken` in the session so the revoke endpoint can use it without the client re-sending it.

---

## The client (`client/src/`)

The React client is deliberately thin — it is a visualization layer, not an application.

**Data flow:**
1. `App.jsx` fetches `/api/me` on load → sets `user` and `loginStep`.
2. User picks a flow from the `FLOWS` map in `flows.js` → sets active flow.
3. User clicks a suggestion in `Chat.jsx` → calls `api.js` → `POST /api/ask` with `{ question, flow }`.
4. Response `steps[]` (with T1 prepended from `loginStep`) → passed to `SequenceView.jsx`.
5. `SequenceView` renders the stepper (T1, T2, …). Clicking a step opens `StepCard.jsx`.
6. `StepCard` renders four tabs: **Request** (method, URL, headers, body), **Response** (status, headers, body via `JsonView`), **Token** (decoded JWT via `TokenView`), **Code** (curl snippet via `CodeBlock`).

**Supporting files:**
- `paramGlossary.js` — a flat map of OAuth parameter names to plain-English explanations. Shown in the "PARAMETER REFERENCE" accordion inside each step card. Adding a new parameter here is the only change needed to document it in the UI.
- `decodeJwt.js` — in-browser Base64url decoder that splits a JWT into `{ header, payload }`. No signature verification — display only.
- `flows.js` — the single source of truth for flow metadata. Adding a new flow requires an entry here and a corresponding route in `routes/ask.js`.

---

## Key data boundaries

| Boundary | What crosses it |
|---|---|
| Browser → Server | `POST /api/ask { question, flow }` — only the question text and flow key |
| Server → Okta | Token requests signed with agent private key; id_token as subject_token |
| Okta → Server | id-JAG, access token, vaulted creds, STS token, interaction_required |
| Server → MCP | In-process function call via InMemoryTransport |
| Server → GitHub | Bearer access token brokered by Okta |
| Server → Browser | `steps[]` array with all captured HTTP detail |

The `id_token` never leaves the server — it stays in the session and is used as `subject_token` in Okta calls. Only the decoded step data is sent to the browser. The GitHub bearer token is masked in the displayed request headers.

---

## Where to make common changes

| Task | Where |
|---|---|
| Add a new flow | `client/src/flows.js` (metadata) + `server/routes/ask.js` (handler) + new `server/xaa/*.js` (logic) |
| Add a new OAuth parameter explanation | `client/src/paramGlossary.js` |
| Change MCP tool data | `server/mcp/data.js` |
| Add a new MCP tool | `server/mcp/inventoryServer.js` (add to `TOOLS` + handler) + `routes/ask.js` (`routeTool`) |
| Change token validation rules | `server/util/verifyToken.js` |
| Add a new environment variable | `server/config.js` + `.env-sample` |
| Change step card UI | `client/src/components/StepCard.jsx` |
