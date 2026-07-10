# Azure Deployment Plan — O4AA-Agent-Flows

**Status:** Deployed — infrastructure provisioned, awaiting first GitHub Actions run
**Date:** 2026-07-09
**Target:** Azure App Service (Linux Web App, Node 20) · CI/CD via GitHub Actions

## Deployed resources (actual)

| Resource | Value |
|---|---|
| Subscription | Azure_Subscription2 (`7e86c522-de98-4ca6-b435-5bf823da37f8`) |
| Resource group | `rg-o4aa-agent-flows` (East US, metadata only) |
| Region (actual resources) | **Central US** — East US had 0 App Service VM quota on this subscription (`SubscriptionIsOverQuotaForSku`); Central US validated cleanly |
| App Service Plan | `plan-o4aa-agent-flows`, **B1 (Basic, ~$13/mo)**, Central US — started on F1 (Free) but its 60 CPU-min/day cap tripped almost immediately and blocked the first deploy (`state: QuotaExceeded`, 403 on `azure/webapps-deploy@v3`). Upgraded in place with `az appservice plan update --sku B1`; `alwaysOn` flipped on manually afterward since Bicep only sets it at initial provision, not on imperative SKU changes |
| Web App | `o4aa-agent-flows-fjquv5bqmgghc` → `https://o4aa-agent-flows-fjquv5bqmgghc.azurewebsites.net` |
| Key Vault | `kv-o4aaagentflows-fjquv5` (RBAC mode) — 5 secrets seeded: SESSION-SECRET, OKTA-CLIENT-SECRET, AGENT-PRIVATE-KEY, SERVICE-PRIVATE-KEY, MCP-BASIC-PASSWORD |
| Web App managed identity | `563ce066-fbb8-44de-a2e6-9e5a2c2efb51` — granted Key Vault Secrets User on the vault |
| Entra app (GitHub OIDC) | `gh-oidc-o4aa-agent-flows`, client ID `43c85671-fcb5-49a6-b7ff-39fe24b520a6` — federated credential trusts `repo:safiqksm/O4AA-Agent-Flows:ref:refs/heads/azure-sts-flow-docs`; granted Website Contributor scoped to the Web App only |
| App settings | 31 plain values pushed from local `.env` (Okta/agent/resource/GitHub/service/MCP config) |

## Remaining manual steps (outside CLI reach)

1. **GitHub repo variables** (no `gh` CLI on this machine — add via GitHub UI: repo → Settings → Secrets and variables → Actions → Variables):
   - `AZURE_CLIENT_ID` = `43c85671-fcb5-49a6-b7ff-39fe24b520a6`
   - `AZURE_TENANT_ID` = `b66066d2-2dc9-4773-8a40-a7d93c1f76bf`
   - `AZURE_SUBSCRIPTION_ID` = `7e86c522-de98-4ca6-b435-5bf823da37f8`
   - `AZURE_WEBAPP_NAME` = `o4aa-agent-flows-fjquv5bqmgghc`
2. **Okta redirect URI** — add `https://o4aa-agent-flows-fjquv5bqmgghc.azurewebsites.net/api/callback` to the OIDC app's allowed redirect URIs (Okta Admin Console).
3. Push this branch → GitHub Actions workflow runs → verify login + one flow end-to-end on the deployed URL.

## Summary

Deploy the Okta XAA Agent Flows demo — a Node.js ESM Express server (port from `PORT`,
default 8080) that serves both the `/api` routes and the built React/Vite client from
`client/dist` — as a **single Linux Web App**. Infrastructure is provisioned once with
Bicep; every push to the deployment branch builds and deploys via a GitHub Actions
workflow authenticated with **OIDC federated credentials** (no publish profiles or
long-lived secrets in GitHub).

## Mode

MODIFY — existing app, add deployment artifacts only. No behavior changes except one
small enhancement (private-key-from-env, see Secrets section).

## Components

| Component | Tech | Notes |
|---|---|---|
| Web server + API | Node 20 ESM, Express 4 | `npm start` → `node server/index.js`; honors `PORT` (App Service sets it) |
| Client | React 18 + Vite | `npm run build` → `client/dist`, served by Express in production |
| MCP server | `@modelcontextprotocol/sdk` | In-process, in-memory transport — no extra service needed |
| Sessions | `express-session` MemoryStore | Fine for a single-instance demo; sticky/scale-out not required |

## Azure Services

| Service | SKU / Config | Purpose |
|---|---|---|
| App Service Plan (Linux) | B1 (demo-appropriate; F1 possible but slow cold starts) | Hosts the web app |
| Web App | Node 20 LTS, `startup command: npm start`, HTTPS-only, `SCM_DO_BUILD_DURING_DEPLOYMENT=false` (we ship prebuilt) | The app |
| Key Vault | Standard, RBAC mode | Holds Okta client secret, session secret, agent/service private keys (PEM) |
| Managed Identity (system-assigned on Web App) | Key Vault Secrets User role | Lets app settings use Key Vault references |
| Entra App Registration + federated credential | Subject: `repo:<owner>/O4AA-Agent-Flows:ref:refs/heads/<branch>` | OIDC login for the GitHub workflow (Website Contributor scope on the RG) |

Region/subscription: confirmed with user at execution time.

## Recipe

**Bicep + GitHub Actions (`azure/webapps-deploy@v3`)** rather than azd:
the user explicitly asked for "GitHub workflow → Azure Web App", the app is a single
service, and this keeps the workflow readable and standard.

## Secrets & Configuration

Required env vars (from `server/config.js` REQUIRED list + operational ones):

| App setting | Source |
|---|---|
| `SESSION_SECRET`, `OKTA_CLIENT_SECRET` | Key Vault reference |
| `AGENT_PRIVATE_KEY`, `SERVICE_PRIVATE_KEY` (PEM content) | Key Vault reference — **requires small code change** (see below) |
| `OKTA_ISSUER`, `OKTA_CLIENT_ID`, `AGENT_CLIENT_ID`, `AGENT_KID`, `RESOURCE_CLIENT_ID`, `RESOURCE_AUTH_SERVER`, `AGENT_AUTH_SERVER`, scopes/audience vars | Plain app settings |
| `APP_BASE_URL` | `https://<app>.azurewebsites.net` |
| `OKTA_REDIRECT_URI` | `https://<app>.azurewebsites.net/api/callback` |

**Code change required:** `server/xaa/clientAssertion.js` only reads keys from files
(`keys/agent.pem`), which are gitignored and won't exist in CI or on App Service.
Add support for `AGENT_PRIVATE_KEY` / `SERVICE_PRIVATE_KEY` env vars containing PEM
content, falling back to the existing file path for local dev.

**Okta side:** add the azurewebsites.net redirect URI to the OIDC app; no other Okta
changes (agent/resource clients authenticate by JWK already registered).

## CI/CD — GitHub Actions workflow (`.github/workflows/deploy.yml`)

Runs in `safiqksm/O4AA-Agent-Flows` (the remote the user can push to).

1. Trigger: push to deployment branch (+ `workflow_dispatch`)
2. `actions/checkout` → `actions/setup-node@v4` (Node 20, npm cache)
3. `npm ci && npm run build` (installs client deps + builds `client/dist`)
4. Prune to production deps (`npm ci --omit=dev`), zip server + client/dist + package files
5. `azure/login@v2` with OIDC (`permissions: id-token: write`; repo variables
   `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`)
6. `azure/webapps-deploy@v3` with the zip

No secrets stored in GitHub — only non-secret IDs as repo variables.

## Steps

| # | Step | Status |
|---|---|---|
| 1 | Confirm subscription, region, resource names with user | pending |
| 2 | Code: env-var private key support in `clientAssertion.js` | pending |
| 3 | Bicep: `infra/main.bicep` (plan, web app, Key Vault, RBAC, app settings) | pending |
| 4 | One-time: create Entra app + federated credential for GitHub OIDC; seed Key Vault secrets | pending |
| 5 | Workflow: `.github/workflows/deploy.yml` | pending |
| 6 | Okta: add production redirect URI | pending |
| 7 | Validate (azure-validate) then deploy (azure-deploy), verify login + one flow end-to-end | pending |

## Risks / Notes

- Session store is in-memory: restarts log users out; acceptable for a demo, keep instance count = 1.
- The app talks to a real Okta org — the Azure-hosted instance uses the same org; anyone with the URL sees your Okta login page. Consider App Service access restrictions if this should stay private.
- `keys/*.pem` never enter git or CI artifacts; PEMs live only in Key Vault.
