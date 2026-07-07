# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
# Install dependencies (run both on first clone)
npm install
npm run client:install

# Development (hot-reload): Express on :8080, Vite on :5173
npm run dev

# Production
npm run build   # builds client/dist
npm start       # serves API + built client on :8080

# Generate or inspect the agent RSA signing key
node scripts/agent-key.mjs --generate   # generate + print public JWK
node scripts/agent-key.mjs              # inspect existing keys/agent.pem
```

There is no test suite or linter configured.

## Setup prerequisites

1. Copy `.env.example` to `.env` and fill in Okta values — the server exits with a clear error listing any missing required vars.
2. Place RSA private keys at `keys/agent.pem` (and `keys/service.pem` for the NHI flow). Generate with `node scripts/agent-key.mjs --generate` and register the printed public JWK in Okta.

## Architecture

The project is a monorepo with a Node ESM server and a React/Vite client.

### Server (`server/`, Express, port 8080)

**Request flow**: `POST /api/ask` → `routes/ask.js` → one of five flow functions → captured steps returned as JSON to the UI.

**Core abstractions**:
- `server/xaa/capture.js` — instrumented `fetch` wrappers (`captureFormPost`, `captureGet`, `captureJsonPost`). Every Okta/GitHub HTTP call goes through here so the exact request, response, decoded JWT, and `curl` snippet are recorded into a **step object** for the visualization UI.
- `server/xaa/clientAssertion.js` — builds `private_key_jwt` client assertions (RFC 7523) used to authenticate all token-exchange calls. Both the agent key (`keys/agent.pem`) and service key (`keys/service.pem`) are loaded here.
- `server/config.js` — loads `.env`, derives `/v1/token`, `/v1/keys`, and `/v1/revoke` endpoints from auth-server base URLs, and validates required vars at startup.

**Five flows** (all routed through `routes/ask.js`):
| Flow key | Files | Steps |
|---|---|---|
| `xaa` | `xaa/tokenExchange.js` | T2 id-JAG → T3 access token → T4 MCP (JWT-validated) |
| `secrets` / `service-account` | `xaa/credentialExchange.js` | T2 vaulted creds → T3 MCP (HTTP Basic) |
| `client-credentials` | `xaa/serviceFlow.js` | T1 client_credentials → T2 id-JAG → T3 access token → T4 MCP |
| `sts-github` | `xaa/stsBroker.js` | T2 STS brokered token (consent loop) → T3 read/create PR + revoke |

The MCP server (`server/mcp/inventoryServer.js`) is **in-process** using `@modelcontextprotocol/sdk` over an in-memory transport — it is not a separate network port. It exposes two tools: `get_inventory_details` and `get_last_5_shipments`.

Token validation at T4 (`server/util/verifyToken.js`) checks JWKS signature, issuer, expiry, and required scopes against `RESOURCE_AUTH_SERVER`.

### Client (`client/`, React 18 + Vite, dev port 5173)

Vite proxies all `/api` requests to `:8080` in dev mode. In production, Express serves `client/dist` directly.

**Key client files**:
- `client/src/flows.js` — single source of truth for the five flow definitions (id, name, suggestions, accent color).
- `client/src/api.js` — thin wrappers around `POST /api/ask` and `POST /api/sts/revoke`.
- `client/src/components/SequenceView.jsx` + `StepCard.jsx` — render the step stepper and per-step Request/Response/Token/Code tabs.
- `client/src/paramGlossary.js` — per-parameter explanations shown in the "PARAMETER REFERENCE" section of each step card.
- `client/src/decodeJwt.js` — in-browser JWT decoder (display only, no signature validation).

### Step object shape

Every captured step (returned in `steps[]` from `/api/ask`) has this shape — both server-generated and manually constructed steps (`buildMcpStep`, `buildBasicMcpStep`) must match it:

```js
{
  id: 'T2',               // step label
  title: string,
  badge: string,          // e.g. 'Token Exchange'
  from: string, to: string,
  ok: boolean,
  request:  { method, url, headers, body },
  response: { status, headers, body },
  token: decodedJwt | null,
  code: string,           // curl snippet
}
```
