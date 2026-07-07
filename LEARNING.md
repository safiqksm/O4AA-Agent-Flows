# Secure AI-Agent Access with Okta — The Deep-Dive Learning Guide

> One source to understand every token flow in this demo: what each token is, where it
> comes from, exactly what goes over the wire (`audience`, `resource`, `subject_token`,
> `client_assertion`, …), and why each parameter exists. Written from the working code in
> this repo, verified against a live Okta preview tenant.

**Companion docs:** [OKTA_SETUP.md](OKTA_SETUP.md) (how to configure the tenant) ·
[UNDERSTANDING.md](UNDERSTANDING.md) (repo architecture) · the running app itself
(`npm run dev`) which shows every request/response/decoded-token live.

---

## Table of contents

1. [The cast of actors](#1-the-cast-of-actors)
2. [The four access patterns](#2-the-four-access-patterns)
3. [Token taxonomy](#3-token-taxonomy)
4. [`aud` vs `audience` vs `resource` vs issuer — the confusing four](#4-aud-vs-audience-vs-resource-vs-issuer)
5. [Anatomy of a `client_assertion` (private_key_jwt)](#5-anatomy-of-a-client_assertion)
6. [Flow 1 — Cross-App Access (XAA): id_token → id-JAG → access token → MCP](#6-flow-1--cross-app-access-xaa)
7. [Flow 2 & 3 — Secrets / Service Accounts: id_token → vaulted credentials](#7-flows-2--3--secrets--service-accounts)
8. [Flow 4 — NHI Cross-App Access: client_credentials → id-JAG](#8-flow-4--nhi-cross-app-access)
9. [Flow 5 — STS Broker (GitHub): id_token → brokered GitHub token → REST](#9-flow-5--sts-broker-github)
10. [Flow 6 — STS Broker (Azure): id_token → brokered Graph token](#10-flow-6--sts-broker-azure)
11. [Flow 7 — MCP Broker (GitHub): id_token → brokered token → MCP protocol](#11-flow-7--mcp-broker-github)
12. [The consent loop (`interaction_required`)](#12-the-consent-loop)
13. [Revocation (RFC 7009)](#13-revocation)
14. [Proving the managed connection — the audit trail](#14-proving-the-managed-connection)
15. [Token validation at the resource (T4)](#15-token-validation-at-the-resource)
16. [Security principles for agent builders](#16-security-principles)
17. [War stories — real failures from building this demo](#17-war-stories)
18. [Specs & further reading](#18-specs--further-reading)

---

## 1. The cast of actors

Every flow involves some subset of these parties. Real values from this project's tenant
are shown so you can correlate with the running app and the Okta System Log.

| Actor | Who it is | This project |
|---|---|---|
| **User** | The human whose identity is delegated | you, via Okta SSO |
| **Chat App** | OIDC web app the user logs into (T1) | client id `0oa…` (client secret auth) |
| **AI Agent** | A dedicated Okta identity type — *not* a regular OAuth app. Registered under **AI Agents**, gets a `wlp…` id and an RSA key pair | `wlp10tv4ror3uKEbH1d8`, key `keys/agent.pem` |
| **Org Authorization Server** (IdP) | Okta's org-level AS. Issues id_tokens, id-JAGs, STS-brokered tokens, vaulted credentials | `https://ntrsoiesys.oktapreview.com` → token endpoint `/oauth2/v1/token` |
| **Resource Authorization Server** | A *custom* Okta AS that protects one API. Issues the final access token | `https://ntrsoiesys.oktapreview.com/oauth2/aus10ta4mhvArN8jE1d8` → token endpoint `…/v1/token`, JWKS `…/v1/keys` |
| **Resource / MCP server** | The thing the agent ultimately calls | in-process Inventory MCP, GitHub REST, Microsoft Graph, GitHub MCP server |
| **Service App** (NHI flows) | A headless machine identity (regular API Services app, `0oa…`) with its own key | `keys/service.pem` |

Key mental model: **Okta sits between the agent and every resource.** The agent never
holds a long-lived credential to any downstream system — it holds one private key, and
exchanges short-lived proof of *who is asking* for short-lived access to *one resource*.

---

## 2. The four access patterns

(Terminology follows Okta's ecosystem; see [Fabio Grasso's access-patterns series](https://iam.fabiograsso.net/blog/okta-ai-access-patterns/) for the strategic framing.)

| Pattern | Demo card(s) | Token mechanics | User context | Revocation granularity |
|---|---|---|---|---|
| **XAA — Cross-App Access** | Cross-App Access, NHI | id-JAG (RFC 8693 exchange) → jwt-bearer (RFC 7523) → access token carrying `sub` (user) + agent identity | ✓ full (`sub` + agent) | per-user, per-agent |
| **STS — Secure Token Service** | STS Broker (GitHub), STS Broker (Azure), MCP Broker (GitHub) | RFC 8693 exchange with `requested_token_type=oauth-sts`; Okta vaults/brokers a third-party OAuth token, gated by user consent | ✓ via consent | per managed connection |
| **PSK — Pre-Shared Key** | Secrets | id_token exchanged for a vaulted static secret (Okta PAM) | ✗ agent-level only | rotate/remove the secret |
| **Service Account** | Service Accounts | id_token exchanged for a vaulted username/password | ✗ shared identity | all-or-nothing |

Strategic ordering: **XAA is the destination** (it's what the MCP spec adopted for
enterprise auth), STS is the bridge for third-party SaaS that speaks OAuth but not id-JAG,
PSK supports legacy API-key systems, and Service Accounts exist to be deprecated —
every one of them is an identity-collapse / compliance gap.

---

## 3. Token taxonomy

Seven distinct token-like things move through these flows. Confusing them is the #1
source of bugs.

| Token | Issued by | Presented to | Lifetime | Format |
|---|---|---|---|---|
| **id_token** | Org AS, at user login (T1) | Org AS again, as `subject_token` in exchanges | ~1h | JWT (`aud` = Chat App client id) |
| **client_assertion** | *The agent itself* (self-signed with its private key) | Any token endpoint, to authenticate the client | ~5 min (you choose) | JWT (`iss`=`sub`= client id, `aud` = the token endpoint) |
| **id-JAG** | Org AS (T2, XAA flows) | Resource AS, as the `assertion` of a jwt-bearer grant | short (~5 min class) | JWT, header `typ: oauth-id-jag+jwt` |
| **Access token** | Resource AS (T3) | The protected resource (T4) | ~1h | JWT (`iss` = resource AS, validated via JWKS) |
| **STS brokered token** | Third party (GitHub/Microsoft), vaulted & released by Okta | The third-party API / MCP server | provider-defined | usually opaque (GitHub `gho_…`) |
| **Vaulted secret / service account** | Okta PAM vault | Legacy resource (HTTP Basic etc.) | static until rotated | key/value, username/password |
| **Service token (NHI T1)** | Custom AS via client_credentials | Org AS as `subject_token` (T2) | ~1h | JWT (`sub` = the service app's client id) |

---

## 4. `aud` vs `audience` vs `resource` vs issuer

Four different things that all sound like "who is this for". Getting these right is most
of the battle:

```
                      ┌────────────────────────────────────────────────────────────┐
                      │  client_assertion JWT                                      │
  "aud" CLAIM ───────▶│    aud = the TOKEN ENDPOINT URL you are POSTing to         │
  (inside a JWT)      │    e.g. https://…/oauth2/v1/token          (RFC 7523 §3)   │
                      ├────────────────────────────────────────────────────────────┤
                      │  id-JAG JWT                                                │
                      │    aud = the RESOURCE AUTHORIZATION SERVER's identifier    │
                      │    e.g. https://…/oauth2/aus10ta4mhvArN8jE1d8              │
                      ├────────────────────────────────────────────────────────────┤
                      │  access token JWT                                          │
                      │    aud = the AUDIENCE value configured on the resource AS  │
                      └────────────────────────────────────────────────────────────┘

  "audience" BODY PARAM (RFC 8693): in the T2 token-exchange REQUEST — names the
      authorization server you want the id-JAG to be accepted BY.
      In this repo: RESOURCE_AUDIENCE = the resource AS's own issuer URL
      (NOT api://something — that was a real bug we hit).

  "resource" BODY PARAM (RFC 8707): names the specific protected RESOURCE.
      In the STS/secrets flows this is an Okta ORN, e.g.
      orn:oktapreview:idp:<org-id>:client-auth-settings:<connection-id>
      — it selects WHICH resource connection on the AI Agent to use.

  ISSUER (iss claim): who minted the token. Validators pin this exactly
      (e.g. https://ntrsoiesys.oktapreview.com/oauth2/aus10ta4mhvArN8jE1d8)
      and fetch that issuer's JWKS to verify the signature.
```

Rule of thumb: **`aud` inside a JWT points one hop downstream from the signer; `audience`
and `resource` in a request body tell the AS what to mint.**

---

## 5. Anatomy of a `client_assertion`

Every privileged call in this demo authenticates with **private_key_jwt** (RFC 7523) —
no client secrets for the agent, ever. The agent constructs and signs this JWT itself:

```
Header:  { "alg": "RS256", "kid": "<AGENT_KID — must match the JWK registered in Okta>" }
Payload: {
  "iss": "wlp10tv4ror3uKEbH1d8",      // the agent IS the issuer…
  "sub": "wlp10tv4ror3uKEbH1d8",      // …and the subject: self-attestation
  "aud": "https://ntrsoiesys.oktapreview.com/oauth2/v1/token",  // the exact endpoint
  "iat": 1751800000,
  "exp": 1751800300,                   // short! minutes, not hours
  "jti": "random-unique-id"            // replay protection
}
Signature: RS256 over header.payload with keys/agent.pem
```

It rides in the POST body as:

```
client_assertion_type = urn:ietf:params:oauth:client-assertion-type:jwt-bearer
client_assertion      = <the signed JWT>
```

Okta verifies it against the **public JWK registered on the agent** (or service app).
Three failure modes we hit for real — see [War stories](#17-war-stories):
no JWK registered at all, `kid` mismatch, and wrong `aud` (must equal the endpoint —
token endpoint for exchanges, **revoke endpoint for revocations**).

---

## 6. Flow 1 — Cross-App Access (XAA)

`flow=xaa` — the flagship. Full identity chain: user + agent at every hop.

```
 ┌──────┐          ┌──────────┐            ┌─────────────────┐        ┌──────────────────┐       ┌───────────────┐
 │ User │          │ Chat App │            │ Org Auth Server │        │ Resource Auth    │       │ Inventory MCP │
 │      │          │  (0oa…)  │            │ (IdP, org-level)│        │ Server (aus10…)  │       │ (scope-gated) │
 └──┬───┘          └────┬─────┘            └────────┬────────┘        └────────┬─────────┘       └───────┬───────┘
    │  T1 OIDC login    │                           │                          │                         │
    │──────────────────▶│  authorization_code       │                          │                         │
    │                   │──────────────────────────▶│                          │                         │
    │                   │◀─ ─ ─ id_token ─ ─ ─ ─ ─ ─│                          │                         │
    │                   │                           │                          │                         │
    │                   │      AGENT (wlp…) takes over from here               │                         │
    │                   │  T2 token-exchange        │                          │                         │
    │                   │  subject_token=id_token   │                          │                         │
    │                   │  + client_assertion(agent)│                          │                         │
    │                   │──────────────────────────▶│                          │                         │
    │                   │◀─ ─ ─ id-JAG ─ ─ ─ ─ ─ ─ ─│                          │                         │
    │                   │                           │                          │                         │
    │                   │  T3 jwt-bearer: assertion=id-JAG + client_assertion  │                         │
    │                   │──────────────────────────────────────────────────────▶                         │
    │                   │◀─ ─ ─ ─ ─ ─ ─ ─ ─ access token (sub=user, act=agent) │                         │
    │                   │                           │                          │                         │
    │                   │  T4 tools/call  Authorization: Bearer <access token> │                         │
    │                   │────────────────────────────────────────────────────────────────────────────────▶
    │                   │        resource validates: JWKS signature + iss + exp + scope inventory:read   │
    │◀─ ─ answer ─ ─ ─ ─│◀─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │
```

### T2 — the id-JAG exchange, field by field

`POST https://ntrsoiesys.oktapreview.com/oauth2/v1/token` (form-urlencoded):

| Param | Value | Why |
|---|---|---|
| `grant_type` | `urn:ietf:params:oauth:grant-type:token-exchange` | RFC 8693: trading one token for another |
| `subject_token` | the user's **id_token** | proof of *whose* delegation this is |
| `subject_token_type` | `urn:ietf:params:oauth:token-type:id_token` | tells the AS how to validate the subject (the org endpoint accepts only `id_token` or `saml2` — we proved this the hard way, see [War stories](#17-war-stories)) |
| `requested_token_type` | `urn:ietf:params:oauth:token-type:id-jag` | "give me an Identity Assertion Authorization Grant" |
| `audience` | `https://…/oauth2/aus10ta4mhvArN8jE1d8` | the AS that must *accept* the id-JAG — the resource AS's issuer URL |
| `scope` | `inventory:read` | narrow at request time (scope narrowing) |
| `client_assertion(_type)` | agent's private_key_jwt, `aud` = this token endpoint | authenticates the **agent** |

Okta checks its policy: *is this agent (`wlp…`) allowed a token-exchange grant on this AS,
and does it have a Resource Connection to that audience?* Then mints the id-JAG:

```
Header:  { "typ": "oauth-id-jag+jwt", "alg": "RS256" }
Payload: {
  "iss": "https://ntrsoiesys.oktapreview.com",              // org AS minted it
  "sub": "<user id>",                                        // the HUMAN
  "aud": "https://…/oauth2/aus10ta4mhvArN8jE1d8",            // the resource AS
  "client_id": "wlp10tv4ror3uKEbH1d8",                       // the AGENT
  "scope": "inventory:read",
  "jti": "…", "iat": …, "exp": …                              // short-lived
}
```

Both identities are now cryptographically bound in one artifact. The response body returns
it in `access_token` with `token_type: N_A` — a common reading trap: **an id-JAG is not an
access token**; `N_A` means "you can't call an API with this, redeem it at the AS in `aud`."

### T3 — redeeming the id-JAG (jwt-bearer)

`POST https://…/oauth2/aus10ta4mhvArN8jE1d8/v1/token`:

| Param | Value |
|---|---|
| `grant_type` | `urn:ietf:params:oauth:grant-type:jwt-bearer` (RFC 7523 §2.1 — a JWT *as the grant itself*) |
| `assertion` | the id-JAG |
| `client_assertion(_type)` | agent's private_key_jwt — `aud` = **this** (resource AS) token endpoint |

The resource AS validates the id-JAG's signature against the **org AS JWKS**, checks
`aud` == itself, checks its access policy allows this `client_id` the jwt-bearer grant with
`inventory:read`, and mints the final **access token** (`iss` = resource AS, `sub` = user,
agent identity carried, `scp: ["inventory:read"]`).

### T4 — the resource validates

See [§15](#15-token-validation-at-the-resource). Nothing downstream trusts anything it
didn't verify itself.

---

## 7. Flows 2 & 3 — Secrets / Service Accounts

`flow=secrets` / `flow=service-account` — the PSK and Service-Account patterns. Same T1;
then a single exchange at the **org** token endpoint:

```
 User ──T1──▶ id_token
 Agent ──T2──▶ POST /oauth2/v1/token
                 grant_type            = …token-exchange
                 subject_token         = id_token          (user context for the AUDIT LOG,
                 subject_token_type    = …:id_token         not for the credential itself)
                 requested_token_type  = urn:okta:params:oauth:token-type:vaulted-secret
                                          — or — …:service-account
                 resource              = orn:okta:pam:<tenant>:secrets:<secret-id>
                                          — or — orn:okta:pam:…:service_accounts:<sa-id>
                 client_assertion      = agent private_key_jwt
               ◀── { vaulted_secret: {…} }  /  { service_account: { username, password } }
 Agent ──T3──▶ resource with  Authorization: Basic base64(user:pass)
```

Note what's *lost* versus XAA: the credential itself carries **no user identity** — the
resource sees only "the service account did it." Okta's release of the secret is logged
per-user, but downstream attribution collapses. This is why these patterns rank below XAA:
use them to bring legacy systems under management, then migrate.

---

## 8. Flow 4 — NHI Cross-App Access

`flow=client-credentials` — no human at all. A headless **service app** (`0oa…`, its own
key `keys/service.pem`) wants the XAA chain.

```
 Service App ──T1──▶ POST <SERVICE_ISSUER>/v1/token          (custom AS, e.g. aus10vq5m…)
                       grant_type       = client_credentials
                       scope            = agent.invoke        (custom scope on that AS)
                       client_assertion = SERVICE key (iss=sub=SERVICE_CLIENT_ID)
                     ◀── service access token (sub = the service app itself)

 Agent ──T2──▶ POST /oauth2/v1/token   (org endpoint)
                 grant_type            = …token-exchange
                 subject_token         = the SERVICE TOKEN     ◀── the non-human "subject"
                 subject_token_type    = …:access_token  ⚠️
                 requested_token_type  = …:id-jag
                 audience              = resource AS issuer
                 client_assertion      = AGENT key
 Agent ──T3──▶ jwt-bearer at resource AS (as in XAA)
 Agent ──T4──▶ MCP with validated access token
```

⚠️ **Platform reality check (July 2026):** Okta's org id-JAG exchange currently accepts
only `id_token` / `saml2` subject tokens. Sending `…:access_token` returns
`invalid_request: 'subject_token_type' is invalid or not supported.` — i.e. the *code
path* is correct per RFC 8693, but the platform doesn't yet support a workload as the
subject. Okta's EA notes point toward agent-to-agent / service-app-without-user-context
support. Track it; the demo degrades gracefully at T2 meanwhile.

Two different keys authenticate in this flow — T1 is signed by the **service** key (proves
the workload), T2/T3 by the **agent** key (proves the agent). Keep them distinct.

---

## 9. Flow 5 — STS Broker (GitHub)

`flow=sts-github` — the bridge pattern for third-party SaaS that speaks OAuth but not
id-JAG. Okta acts as a **Secure Token Service**: it runs the provider's OAuth dance once
(with user consent), vaults the resulting provider token, and re-releases it to the agent
on demand.

```
 User ──T1──▶ id_token
 Agent ──T2──▶ POST /oauth2/v1/token   (org endpoint)
                 grant_type            = …token-exchange
                 requested_token_type  = urn:okta:params:oauth:token-type:oauth-sts   ◀── Okta-specific
                 subject_token         = id_token
                 subject_token_type    = …:id_token
                 resource              = orn:oktapreview:idp:<org>:client-auth-settings:<conn>
                 client_assertion      = agent key (aud = org token endpoint)

        FIRST RUN ──▶ HTTP 400 { "error": "interaction_required",
                                  "interaction_uri": "https://…/consent…" }
        user authorizes in browser ──▶ Okta runs GitHub's OAuth code flow
                                        (callback: https://<okta>/oauth2/v1/sts/callback)
        agent RETRIES THE IDENTICAL REQUEST ──▶ HTTP 200 { access_token: "gho_…", … }

 Agent ──T3──▶ GET  https://api.github.com/repos/<owner>/<repo>/pulls   Bearer gho_…
          or──▶ POST https://api.github.com/repos/<owner>/<repo>/pulls  (write proves scope)
 Agent ──R1──▶ POST /oauth2/v1/revoke  token_type_hint=oauth_sts  (re-arms consent)
```

The brokered `gho_…` token is **GitHub's**, not Okta's — opaque, provider lifetime,
provider scopes (governed by the Resource Connection, not by your `scope` param). The
agent never saw the GitHub client secret: that lives in the OIN app's **Sign-On → Client
authentication settings** in Okta.

---

## 10. Flow 6 — STS Broker (Azure)

`flow=sts-azure` — mechanically **identical** to Flow 5 (same endpoint, same
`oauth-sts` request, same consent loop, same revoke) with two substitutions:

- `resource` = the ORN of an **Azure/Microsoft** resource connection
- T3 targets Microsoft Graph: `GET /v1.0/me` and `GET /v1.0/me/memberOf` with the
  brokered token (delegated `User.Read` covers both)

**Status (July 2026):** blocked upstream — STS resource connections require an
**XAA-enabled OIN integration** (one whose app page has the *Client authentication
settings* section), and no Microsoft/Entra/Office-365-with-Graph entry currently
qualifies for Graph brokering on this tenant. The card answers
"STS Azure flow is not configured" until `AZURE_RESOURCE` can be populated. The lesson
generalizes: **STS coverage is bounded by the IdP's partner catalog** — check it before
promising an integration.

---

## 11. Flow 7 — MCP Broker (GitHub)

`flow=mcp-github` — same STS trust chain as Flow 5; the *target* changes from a REST API
to an **MCP server**, and Okta registration moves from an OIN app to
**Directory → MCP Servers** (base URL + a credential set = the provider OAuth client),
connected to the agent as Resource Connection type **MCP server**.

```
 User ──T1──▶ id_token
 Agent ──T2──▶ org /oauth2/v1/token, requested_token_type=oauth-sts,
               resource=<ORN of the MCP-server connection>        (+ consent loop)
             ◀── brokered GitHub token

 Agent ──T3──▶ POST https://api.githubcopilot.com/mcp/            ┐
                 Authorization: Bearer <brokered token>           │ MCP protocol:
                 Accept: application/json, text/event-stream      │ JSON-RPC over
                 MCP-Protocol-Version: 2025-06-18                 │ Streamable HTTP
                 { "jsonrpc":"2.0","id":1,"method":"initialize",  │
                   "params":{ "protocolVersion":"2025-06-18",     │
                              "clientInfo":{…} } }                ┘
             ◀── result { serverInfo… } + header Mcp-Session-Id: <sid>
               (agent then fires notifications/initialized)

 Agent ──T4──▶ same URL, echoing Mcp-Session-Id: <sid>
                 { "method":"tools/list" }        → the server's tool catalog
                 { "method":"tools/call",
                   "params":{ "name":"get_me", "arguments":{} } } → who the token belongs to
```

MCP-specific mechanics worth knowing:

- **Responses may arrive SSE-framed** (`Content-Type: text/event-stream`): the JSON-RPC
  reply is the last `data:` line. Parse accordingly.
- **JSON-RPC errors ride on HTTP 200** — check for an `error` member; HTTP status alone
  lies to you.
- **Session**: `Mcp-Session-Id` from `initialize` must be echoed on every later call.

### Why this flow matters — REST vs MCP with the same identity chain

| | Flow 5 (REST) | Flow 7 (MCP) |
|---|---|---|
| Agent's knowledge | endpoints hardcoded by a developer | tools **discovered at runtime** via `tools/list` |
| Adding a capability | code change | server-side: publish a new tool |
| Protocol | HTTP verbs + provider-specific JSON | uniform JSON-RPC (`initialize`/`tools/*`) |
| Fit for LLM agents | translation layer required | designed as the agent-native interface |

Okta's STS layer literally cannot tell the difference — both connections produce
`client-auth-settings:rsc…` ORNs. **Identity is orthogonal to protocol**: you can move a
resource from REST to MCP without touching the trust chain.

---

## 12. The consent loop

All three broker flows share it. What actually happens:

1. **T2 first attempt** → `HTTP 400 {"error":"interaction_required","interaction_uri":"…"}`.
   Okta has no vaulted provider token for (user × connection) yet.
2. The UI shows **Authorize connection ↗** (opens `interaction_uri`) and **Retry**.
3. On the consent page Okta runs the provider's authorization-code flow — the provider
   redirects back to `https://<okta-domain>/oauth2/v1/sts/callback` (this exact URL must
   be registered on the provider OAuth app). Okta vaults the provider token,
   **server-side**.
4. The agent **retries the byte-identical T2 request** → `HTTP 200`. No new parameter, no
   code passed to the agent — the state change happened entirely inside Okta.

Security property: the agent never participates in the provider's OAuth dance and never
sees the provider client secret or refresh token. Consent is per user × per connection,
auditable, and revocable (below).

---

## 13. Revocation

`POST https://<org>/oauth2/v1/revoke` (RFC 7009), agent-authenticated:

```
token                 = <the brokered access token>
token_type_hint       = oauth_sts
client_assertion_type = urn:ietf:params:oauth:client-assertion-type:jwt-bearer
client_assertion      = agent key — aud = the REVOKE endpoint (not the token endpoint!)
```

Revoking an STS token deletes Okta's vaulted grant → the **next T2 returns
`interaction_required` again**. That gives you *revocation precision*: kill one user's
one connection without touching anything else. (XAA needs no equivalent — id-JAGs and
access tokens simply expire in minutes/hours; you revoke by disabling the agent or the
resource connection.)

---

## 14. Proving the managed connection

"How do we know the agent isn't just using a hidden GitHub token?" — the question every
security review will ask about the broker flows. Six pieces of evidence, ordered from
what's visible on screen to what's independently verifiable. For a live team demo, run
**2 → 1 → 3 → 5**: about two minutes for a complete story.

**1. The T2 request names the managed connection on the wire.** Open the T2 step card →
Request tab. The body carries
`resource=orn:oktapreview:idp:<org-id>:client-auth-settings:<connection-id>` — the exact
ORN shown on the AI Agent's **Resource Connections** tab. The request goes to *Okta's*
token endpoint, not the provider's, authenticated only by the agent's `client_assertion`.

**2. The codebase holds no provider credential.**

```sh
grep -ri "gho_\|ghp_\|GITHUB_TOKEN\|client_secret" server/ .env | grep -v OKTA_CLIENT_SECRET
# → nothing
```

The only GitHub secret in the whole system is the OAuth app's client ID/secret — stored
in Okta (Directory → MCP Servers credential set / OIN app Sign-On tab), where the agent
cannot read it. If the agent still reaches the resource, the token *must* have come from
Okta.

**3. The revoke test (strongest live proof).** Click **Revoke STS token**, re-run the
flow → T2 returns `interaction_required`. Nothing changed on the provider and nothing
changed locally; only Okta's vaulted grant was deleted, and access died instantly. Okta
is demonstrably the gatekeeper, not a cached credential.

**4. The kill switch.** In Okta Admin, deactivate the Resource Connection (or the
credential set on the MCP Server entry) → the byte-identical T2 request now fails, with
agent code, keys, and prior consent all untouched. Re-enable and it works again. That is
IT-controlled, per-connection revocation — the point of managed connections.

**5. The Okta System Log (compliance-grade record).** Admin console → **Reports →
System Log**, filter `client.id eq "<your wlp… agent id>"` (or search the `rsc…`
connection id). Every token-exchange grant appears with **actor = the agent, subject =
the signed-in user, target = the resource connection**, timestamped to match each run —
per-release attribution of user + agent + connection.

**6. The provider's side agrees.** GitHub → Settings → Applications → **Authorized OAuth
Apps** shows the app authorized at exactly the moment the user clicked
*Authorize connection ↗*, and the `get_me` MCP call returns *that user's* identity —
the brokered token carries the consenting user's delegation, not a bot account.

---

## 15. Token validation at the resource

The Inventory MCP (T4) shows the non-negotiable checklist every resource must run —
`server/util/verifyToken.js`:

1. Fetch JWKS from the **expected issuer's** `jwks_uri`
   (`https://…/aus10ta4mhvArN8jE1d8/v1/keys`) and verify the **signature**.
2. Pin `iss` — exact string match against the resource AS.
3. Check `exp` (and reasonable clock skew).
4. Enforce **scopes**: `scp` must contain `inventory:read` → else `403 insufficient_scope`.
5. Signature/issuer/expiry failure → `401 invalid_token`.

Decode-only is display, not security — the client's JWT viewer in this app deliberately
does *no* signature check, the server does. Never authorize off an unverified decode.

---

## 16. Security principles

Distilled from the flows above — the checklist to present to your team:

1. **No static secrets on the agent.** One RSA private key; everything else is minted
   per-request and short-lived. Registered public JWKs are the trust anchor.
2. **Identity chain, not identity collapse.** XAA carries user (`sub`) *and* agent at
   every hop → per-user audit and surgical revocation. Every step toward service-account
   sharing loses attribution.
3. **Scope narrowing at every exchange.** Request the minimum (`inventory:read`) even if
   the agent could get more; effective access = agent capabilities ∩ user entitlements ∩
   requested scope.
4. **Short lifetimes limit blast radius.** Assertions in minutes, access tokens ≤ 1h,
   id-JAGs single-purpose.
5. **`aud` pinning everywhere.** Assertion `aud` = the exact endpoint; id-JAG `aud` = the
   resource AS; access-token `aud` = the resource. A token replayed anywhere else fails.
6. **The IdP is the policy chokepoint.** Resource Connections, access policies, and the
   consent vault put IT in control of *which agent reaches which resource as which user* —
   without touching agent code.
7. **Resources verify, never trust.** JWKS + iss + exp + scope at every resource;
   HTTP-level success ≠ protocol-level success (MCP's error-on-200).
8. **Choose the strongest pattern the resource supports**: XAA > STS > PSK > Service
   Account — and treat everything below XAA as a migration waypoint.

---

## 17. War stories

Real failures from building this demo — each one is a lesson you can reuse:

| Symptom | Root cause | Lesson |
|---|---|---|
| `invalid_client: The client does not have a JWKSet configured` | Service app had no public key registered; also `SERVICE_KID` didn't match the key on disk | the JWK in Okta and the `kid` in your assertion header must both match the private key you sign with |
| `'subject_token_type' is invalid or not supported` (T2, NHI) | Org id-JAG exchange only accepts `id_token`/`saml2` subjects today | RFC 8693 defines more than a platform implements; verify supported subject types before designing an NHI flow |
| `The redirect_uri is not associated with this application` (consent page) | Provider OAuth app's callback ≠ `https://<okta>/oauth2/v1/sts/callback` | the STS callback URL is Okta's, registered on the *provider's* app — one exact string |
| T3 `network_error: fetch failed` (MCP) | Base URL was `copilot-api.octocorp.ghe.com` — GitHub's *docs placeholder* (NXDOMAIN) | probe endpoints with curl before wiring them; an unauthenticated 401 is *good news* (host exists, wants auth) |
| Azure Step B impossible — "no option for client secret" | No XAA-enabled Microsoft OIN integration exists (yet) | STS reach = IdP partner catalog; check before committing |
| Token exchange succeeded but revoke failed | Revoke assertion `aud` must be the **revoke** endpoint | every endpoint you authenticate to is its own audience |
| `SERVICE_SCOPES=agent.invoke - NHI - Cross-App Access` | Scope param is space-separated; the label text became bogus scopes | env values go over the wire verbatim — keep labels in comments |

---

## 18. Specs & further reading

- **RFC 8693** — OAuth 2.0 Token Exchange (`subject_token`, `requested_token_type`, `act` claim)
- **RFC 7523** — JWT Profile for Client Authentication & Authorization Grants (`private_key_jwt`, jwt-bearer)
- **RFC 7009** — Token Revocation · **RFC 8707** — Resource Indicators (`resource` param)
- **Identity Assertion Authorization Grant (id-JAG)** — IETF draft implemented by Okta XAA
- Okta: [Set up AI agent token exchange](https://developer.okta.com/docs/guides/ai-agent-token-exchange/-/main/) · [Cross App Access](https://help.okta.com/oie/en-us/content/topics/apps/apps-cross-app-access.htm) · [AI agents & MCP servers](https://help.okta.com/oie/en-us/content/topics/ai-agents/ai-agent-mcp-server.htm)
- Fabio Grasso: [Okta AI Blueprint (demo video)](https://iam.fabiograsso.net/blog/okta-ai-blueprint/#demo-video) · [Access Patterns](https://iam.fabiograsso.net/blog/okta-ai-access-patterns/) · [Access Patterns Deep-Dive](https://iam.fabiograsso.net/blog/okta-ai-access-patterns-deep-dive/)
- **MCP** — [Model Context Protocol spec](https://modelcontextprotocol.io) (Streamable HTTP transport, `initialize`/`tools/*`, enterprise auth via XAA)
- This repo: run `npm run dev` and click through the seven cards — every request/response
  and decoded token in this guide renders live in the step viewer.
