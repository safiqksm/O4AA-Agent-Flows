# STS Broker (Azure) Flow — Design

**Date:** 2026-07-01
**Status:** Approved

## Goal

Add a sixth flow, **STS Broker (Azure)** (`flow=sts-azure`), alongside the existing STS Broker (GitHub) flow. The agent exchanges the user's Okta `id_token` for a brokered Microsoft (Entra ID) access token via Okta's STS, then calls Microsoft Graph. The GitHub flow is not modified in any way.

## Approach

**Duplicate-and-adapt** (chosen over parameterizing the shared T2 exchange): copy the GitHub STS broker module and adapt it for Azure. Zero regression risk to the GitHub flow; accepted trade-off is some duplicated T2/revoke logic.

## Flow shape

```
T1  User logs in                                  → id_token (existing, unchanged)
T2  Agent exchanges id_token → Azure Graph token  (oauth-sts token-exchange, ORG endpoint)
     ↳ if interaction_required: show consent link, wait for retry (same UI as GitHub)
T3  Agent calls Microsoft Graph with the brokered token
     - "Get my Azure profile"  → GET /me
     - "List my groups"        → GET /me/memberOf
     (optional) Revoke: RFC 7009 revoke at ORG revoke endpoint → re-triggers consent
```

Both Graph reads require only the delegated `User.Read` scope — no admin consent in Entra.

## Server changes (additive only)

### New file: `server/xaa/azureStsBroker.js`

Adapted copy of `server/xaa/stsBroker.js`:

| Function | Behavior |
|---|---|
| `requestAzureResourceToken(idToken)` | Same token exchange as GitHub's `requestResourceToken` (`grant_type=token-exchange`, `requested_token_type=urn:okta:params:oauth:token-type:oauth-sts`, `subject_token=id_token`, `client_assertion` signed with the agent key) but `resource = config.azureSts.resource`. Returns `{ step, accessToken, ok, interactionUri }`. Step: `id: 'T2'`, title `Azure Token Exchange`, badge `STS`, to `Okta Org Server`. |
| `getMyProfile(accessToken)` | `GET {graph.apiBaseUrl}/me` with `Authorization: Bearer`. Step: `id: 'T3'`, title `Get My Profile`, badge `Graph`, to `Microsoft Graph`. |
| `getMyGroups(accessToken)` | `GET {graph.apiBaseUrl}/me/memberOf`. Step: `id: 'T3'`, title `List My Groups`, badge `Graph`, to `Microsoft Graph`. |
| `revokeAzureStsToken(token)` | RFC 7009 revoke at the org revoke endpoint, `token_type_hint=oauth_sts`, agent-authenticated via `private_key_jwt`. Step: `id: 'R1'`, title `Revoke Azure STS Token`. |

All HTTP calls go through the existing `capture.js` wrappers so steps render in the UI identically to every other flow.

### `server/config.js` (additive)

```js
azureSts: {
  tokenUrl: ORG_TOKEN_URL,
  revokeUrl: ORG_REVOKE_URL,
  assertionAudience: ORG_TOKEN_URL,
  revokeAssertionAudience: ORG_REVOKE_URL,
  resource: process.env.AZURE_RESOURCE,
  scopes: process.env.AZURE_SCOPES || undefined,
},
graph: {
  apiBaseUrl: process.env.GRAPH_API_BASE_URL || 'https://graph.microsoft.com/v1.0',
},
```

Not added to `REQUIRED`. If `AZURE_RESOURCE` is blank, the flow answers "STS Azure flow is not configured — set AZURE_RESOURCE." (same pattern as GitHub).

### `server/routes/ask.js`

- New `runStsAzureFlow(idToken, steps, action)` mirroring `runStsGithubFlow`:
  - `action = 'groups'` when the question matches `/\bgroups?\b|member/i`, else `'profile'`.
  - On `interaction_required`: return `{ answer, interaction: { uri } }` — same contract the client already handles.
  - On success: store token in `req.session.azureStsAccessToken` (separate from GitHub's `stsAccessToken`).
  - Answer summarizes the Graph response (profile: displayName, mail, userPrincipalName; groups: list of displayNames).
- Router branch: `flow === 'sts-azure'`.
- New endpoint `POST /api/sts/azure/revoke` — mirrors `/api/sts/revoke` but uses `azureStsAccessToken` and `revokeAzureStsToken`. The existing GitHub revoke endpoint is untouched.

## Client changes

- **`client/src/flows.js`** — new entry:
  - id `sts-azure`, name `STS Broker (Azure)`, accent `#0078d4`
  - tagline: `token-exchange → Graph token → read profile`
  - suggestions: `Get my Azure profile`, `List my groups`
- **`client/src/api.js`** — `revokeAzureSts()` → `POST /api/sts/azure/revoke`.
- **`client/src/components/Chat.jsx`**:
  - Revoke bar renders for `sts-github` **or** `sts-azure`; calls the matching revoke API by `flow.id`.
  - Greeting and input placeholder gain an `sts-azure` variant.
  - Consent card (Authorize connection ↗ / Retry) unchanged — already generic over `interaction.uri`.

## Environment variables

```env
# ── STS Broker flow (Azure): token-exchange → brokered Graph token → Microsoft Graph ──
AZURE_RESOURCE=orn:oktapreview:idp:<org-id>:client-auth-settings:<connection-id>
AZURE_SCOPES=
# GRAPH_API_BASE_URL=https://graph.microsoft.com/v1.0
```

Added to `.env` and the env sample file(s).

## Documentation

- **OKTA_SETUP.md** — new "Azure STS Broker flow" section mirroring the GitHub one:
  - **Step A** — Register an app in Microsoft Entra ID (Azure portal → App registrations): Web platform redirect URI `https://ntrsoiesys.oktapreview.com/oauth2/v1/sts/callback`; create a client secret; add delegated Microsoft Graph `User.Read` permission.
  - **Step B** — In Okta Admin, add the Azure/Entra integration from the app catalog with the Entra client ID + secret.
  - **Step C** — AI Agents → agent → Resource Connections → add the Azure connection → copy its ORN into `AZURE_RESOURCE`.
  - Troubleshooting rows for the common failures (`interaction_required` loop, wrong redirect URI, missing Graph permission).
- **UNDERSTANDING.md** — new "6. STS Broker (Azure)" flow description; consent loop cross-references the detailed GitHub write-up rather than duplicating it.

## Error handling

Same patterns as the GitHub flow:
- T2 `interaction_required` → consent card with authorize link + retry.
- Other T2 errors → failed T2 step card with the raw Okta error body.
- Graph HTTP errors (401/403) → failed T3 step card with the raw Graph error body.

## Verification (manual — no test suite exists)

1. `git diff` shows no changes to `server/xaa/stsBroker.js` or the GitHub branch of `ask.js`.
2. GitHub STS flow still works end-to-end (read PRs, revoke, consent retry).
3. Azure flow: first run returns consent card → authorize in new tab → Retry → T2 200 → T3 Graph profile/groups render.
4. Azure revoke → next run re-triggers consent.
5. With `AZURE_RESOURCE` blank, the flow answers "not configured" instead of crashing.
