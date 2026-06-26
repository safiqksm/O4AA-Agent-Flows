# Okta Cross-App Access (XAA) — Inventory Assistant Demo

A self-contained demo of **Okta Cross-App Access** (Identity Assertion Authorization Grant).
A user signs into a chat app with Okta. When they ask an inventory question, an agent walks the
XAA token chain and calls a locally-hosted **Inventory MCP server** — and every API call in the
chain is rendered as a step with **Request / Response / Token / Code** tabs.

## The flow

| Step | What happens | Auth |
|------|--------------|------|
| **T1 — User Login** | User signs in via Okta OIDC (Auth Code + PKCE). Shows the user access token. | Web app client secret |
| **T2 — Token Exchange → id-JAG** | Agent exchanges the user's `id_token` for an Identity Assertion Authorization Grant at the IdP. | `private_key_jwt` (agent key) |
| **T3 — JWT-Bearer → Access Token** | Agent presents the id-JAG to the resource's authorization server. | `client_id` only |
| **T4 — MCP Tool Call** | Agent calls the Inventory MCP tool with the `Bearer` access token. | Bearer access token |

Tools: `get_inventory_details`, `get_last_5_shipments` (static data in `server/mcp/data.js`).

## Setup

```sh
npm install            # server deps
npm run client:install # client deps (React + Vite)
cp .env.example .env   # then fill in your Okta values
```

Drop your agent's PEM private key at `keys/agent.pem` (PKCS#8). Register the matching public JWK
on the agent client in Okta, set `AGENT_KID` to its `kid`. See `.env.example` for every variable.

### Okta prerequisites (already configured in your org)
- **Chat app** — OIDC web app for user login (`OKTA_CLIENT_ID` / `OKTA_CLIENT_SECRET`, redirect `…/api/callback`).
- **Agent app** — enabled for `token-exchange`, authenticates with `private_key_jwt`.
- **Resource client + auth server** — enabled for `jwt-bearer`; `RESOURCE_CLIENT_ID` must match the
  `client_id` embedded in the id-JAG.

## Run

```sh
npm run dev    # server on :8080, Vite UI on :5173 (proxies /api)
```

Open **http://localhost:5173**, sign in, then click a suggestion ("Get inventory details" /
"Show last 5 shipments") and watch T1→T4 execute.

For a production-style single-port run:

```sh
npm run build  # builds the client into client/dist
npm start      # server serves the API + built client on :8080
```

## Notes
- If Okta rejects a grant, the error response is captured and shown in that step's **Response** tab —
  handy for debugging the demo live.
- `decodeJwt` is display-only (no signature verification) so the UI can show every token's claims.
