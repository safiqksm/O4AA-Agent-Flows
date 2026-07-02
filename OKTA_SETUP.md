# Okta Configuration & Setup Guide

This guide walks through every Okta configuration step required to run the six flows in this demo.

**Tenant:** `https://ntrsoiesys.oktapreview.com`  
**Admin console:** `https://ntrsoiesys-admin.oktapreview.com`

---

## Prerequisites

- Node.js 18+ installed
- Dependencies installed: `npm install && npm run client:install`
- `.env` file created: `cp .env-sample .env`

---

## Step 1 — Create the Chat App (user login · T1)

This is the app users log into. It performs OIDC Authorization Code.

### In the Okta Admin Console:

1. Go to **Applications → Applications**
2. Click **Create App Integration**
3. Select:
   - **Sign-in method:** OIDC – Web Application
   - Click **Next**
4. Fill in:
   - **App integration name:** `XAA Chat App`
   - **Grant type:** Authorization Code only
   - **Sign-in redirect URIs:** `http://localhost:8080/api/callback`
   - **Sign-out redirect URIs:** `http://localhost:8080`
   - **Controlled access:** Allow everyone in your organization
5. Click **Save**

### Collect values:

On the app's **General** tab, copy:
- **Client ID** → `OKTA_CLIENT_ID`
- **Client secret** → `OKTA_CLIENT_SECRET`

### Update `.env`:

```env
OKTA_ISSUER=https://ntrsoiesys.oktapreview.com/oauth2/default
OKTA_CLIENT_ID=<Client ID from above>
OKTA_CLIENT_SECRET=<Client Secret from above>
OKTA_REDIRECT_URI=http://localhost:8080/api/callback
OKTA_SCOPES=openid profile email
```

---

## Step 2 — Register the AI Agent (token exchange · T2)

The AI agent is **not** a regular OAuth app. It is registered under **Okta AI Agent** — a dedicated identity type that generates its own RSA key pair and produces an agent ID (`wlp…`).

### In the Okta Admin Console:

1. Go to **AI Agents** (left nav) → **AI Agents**
2. Click **Register Agent**
3. Select **Register Manually**
4. Fill in:
   - **Agent name:** `XAA AI Agent`
   - **App owner:** assign yourself or your team
5. Click **Register**

### Generate the key pair:

1. On the agent's detail page, go to the **Keys** tab
2. Click **Generate New Key**
3. Okta generates an RSA key pair and shows you:
   - **Private key (PEM)** — download or copy this immediately (shown once only)
   - **Public JWK** with a `kid` value
4. Save the private key as `keys/agent.pem` in this project
5. Copy the `kid` value

### Collect values:

- **Agent ID** (`wlp…`) shown on the agent overview → `AGENT_CLIENT_ID` and `RESOURCE_CLIENT_ID`
- **kid** from the generated key → `AGENT_KID`

### Update `.env`:

```env
AGENT_AUTH_SERVER=https://ntrsoiesys.oktapreview.com/oauth2/default
AGENT_CLIENT_ID=<Agent ID, e.g. wlp10tv4ror3uKEbH1d8>
AGENT_PRIVATE_KEY_FILE=./keys/agent.pem
AGENT_KID=<kid from generated key>
XAA_SCOPES=inventory:read
```

---

## Step 3 — Create the Resource Authorization Server (access token · T3)

A custom authorization server that issues the final resource access token. Its **Audience** is the server's own issuer URL.

### In the Okta Admin Console:

1. Go to **Security → API**
2. Click the **Authorization Servers** tab
3. Click **Add Authorization Server**
4. Fill in:
   - **Name:** `Resource Auth Server`
   - **Audience:** `https://ntrsoiesys.oktapreview.com/oauth2/<new-server-id>` (Okta pre-fills this — leave it as-is after creation)
   - **Description:** optional
5. Click **Save**

### Add the required scope:

1. Click the **Scopes** tab → **Add Scope**
2. Fill in:
   - **Name:** `inventory:read`
   - **Display phrase:** `Read inventory data`
3. Click **Create**

### Add an Access Policy:

1. Click the **Access Policies** tab → **Add Policy**
2. Fill in:
   - **Name:** `Resource Access Policy`
   - **Assign to:** The following clients → select your **AI Agent** (`wlp…`)
3. Click **Create Policy**, then **Add Rule**
4. Fill in:
   - **Rule name:** `Allow inventory:read`
   - **Grant type:** JWT Bearer ✓
   - **Scopes:** `inventory:read`
5. Click **Create Rule**

### Collect values:

On the **Settings** tab, copy the **Issuer URI** (e.g. `https://ntrsoiesys.oktapreview.com/oauth2/aus…`).

### Update `.env`:

```env
RESOURCE_AUTH_SERVER=https://ntrsoiesys.oktapreview.com/oauth2/<resource-server-id>
RESOURCE_AUDIENCE=https://ntrsoiesys.oktapreview.com/oauth2/<resource-server-id>
RESOURCE_CLIENT_ID=<same Agent ID as AGENT_CLIENT_ID>
RESOURCE_SCOPES=inventory:read
```

> **Note:** `RESOURCE_AUDIENCE` is the auth server's own issuer URL — not `api://resource`.  
> `RESOURCE_CLIENT_ID` is the same `wlp…` agent ID, not a separate app.

---

## Step 4 — Add the Resource Server as a Resource Connection on the AI Agent

The AI Agent needs explicit permission to request tokens scoped to the resource auth server.

### In the Okta Admin Console:

1. Go to **AI Agents** → open your **XAA AI Agent**
2. Click the **Resource Connections** tab
3. Click **Add Resource Connection**
4. Select **Resource Server API**
5. Choose the **Resource Auth Server** you created in Step 3
6. Click **Save**

---

## Step 5 — Add a Token Exchange policy to the default Authorization Server

The agent needs permission to perform a token exchange on the default auth server (T2).

### In the Okta Admin Console:

1. Go to **Security → API → Authorization Servers → default**
2. Click the **Access Policies** tab → **Add Policy**
3. Fill in:
   - **Name:** `Agent Token Exchange Policy`
   - **Assign to:** The following clients → select your **AI Agent** (`wlp…`)
4. Click **Create Policy**, then **Add Rule**
5. Fill in:
   - **Rule name:** `Allow token exchange`
   - **Grant type:** Token Exchange ✓
6. Click **Create Rule**

---

## Complete `.env` for the XAA flow

```env
PORT=8080
APP_BASE_URL=http://localhost:5173

SESSION_SECRET=<32+ char random string>

# T1 — Chat App (user login)
OKTA_ISSUER=https://ntrsoiesys.oktapreview.com/oauth2/default
OKTA_CLIENT_ID=<Chat App client_id>
OKTA_CLIENT_SECRET=<Chat App client_secret>
OKTA_REDIRECT_URI=http://localhost:8080/api/callback
OKTA_SCOPES=openid profile email

# T2 — AI Agent (token exchange)
AGENT_AUTH_SERVER=https://ntrsoiesys.oktapreview.com/oauth2/default
AGENT_CLIENT_ID=<Agent ID, wlp…>
AGENT_PRIVATE_KEY_FILE=./keys/agent.pem
AGENT_KID=<kid from agent key>
XAA_SCOPES=inventory:read
RESOURCE_AUDIENCE=https://ntrsoiesys.oktapreview.com/oauth2/<resource-server-id>

# T3 — Resource Auth Server + Agent
RESOURCE_AUTH_SERVER=https://ntrsoiesys.oktapreview.com/oauth2/<resource-server-id>
RESOURCE_AUDIENCE=https://ntrsoiesys.oktapreview.com/oauth2/<resource-server-id>
RESOURCE_CLIENT_ID=<same Agent ID, wlp…>
RESOURCE_SCOPES=inventory:read
```

---

## GitHub STS Broker flow

This flow exchanges an Okta token for a brokered GitHub token, then reads or creates a pull request.

### Step A — Create a GitHub OAuth App

1. Go to **GitHub → Settings → Developer settings → OAuth Apps**
2. Click **New OAuth App**
3. Fill in:
   - **Application name:** `Okta XAA Demo`
   - **Homepage URL:** `http://localhost:8080`
   - **Authorization callback URL:** `https://ntrsoiesys.oktapreview.com/oauth2/v1/sts/callback`
4. Click **Register application**
5. On the app page, click **Generate a new client secret**
6. Copy:
   - **Client ID** → needed in the next step
   - **Client secret** → needed in the next step

### Step B — Grant repository permissions

1. Still in GitHub, go to your OAuth App → **Permissions**
2. Enable **Read and write** access for **Repository contents** (for PR creation)
3. Install the OAuth App on your account or organization targeting the repo you want to use

### Step C — Create the GitHub integration in Okta (OIN)

1. In Okta Admin, go to **Applications → Applications**
2. Click **Browse App Catalog** (OIN)
3. Search for **GitHub** and select the GitHub integration
4. Click **Add Integration**
5. Fill in:
   - **GitHub OAuth Client ID:** (from Step A)
   - **GitHub OAuth Client Secret:** (from Step A)
6. Click **Done**

### Step D — Add GitHub as a Resource Connection on the AI Agent

1. Go to **AI Agents** → open your **XAA AI Agent**
2. Click the **Resource Connections** tab
3. Click **Add Resource Connection**
4. Select the **GitHub** integration you just created (Step C)
5. Click **Save**
6. Copy the **ORN** shown for this connection → `GITHUB_RESOURCE`

### Update `.env`:

```env
GITHUB_RESOURCE=orn:oktapreview:idp:<org-id>:client-auth-settings:<connection-id>
GITHUB_SCOPES=
GITHUB_OWNER=<your GitHub username or org>
GITHUB_REPO=<repository name>
GITHUB_PR_BASE=main
GITHUB_PR_HEAD=<branch to open PR from>
GITHUB_PR_TITLE=Automated PR via Okta AI Agent
```

> **Note:** GitHub App tokens use App permissions, not OAuth scopes — leave `GITHUB_SCOPES` blank if using a GitHub App. Scopes only apply to user OAuth tokens.

---

## Azure STS Broker flow

This flow exchanges an Okta token for a brokered Microsoft Graph token, then reads the signed-in user's profile or group memberships.

### Step A — Register an app in Microsoft Entra ID

1. Go to **Azure portal → Microsoft Entra ID → App registrations**
2. Click **New registration**
3. Fill in:
   - **Name:** `Okta XAA Demo`
   - **Supported account types:** Accounts in this organizational directory only
   - **Redirect URI:** platform **Web**, value `https://ntrsoiesys.oktapreview.com/oauth2/v1/sts/callback`
4. Click **Register**
5. Go to **Certificates & secrets → New client secret**, copy the secret **Value**
6. Go to **API permissions** — confirm **Microsoft Graph → User.Read** (delegated) is present (added by default)
7. From the **Overview** page copy:
   - **Application (client) ID** → needed in the next step
   - The client secret value → needed in the next step

### Step B — Create the Azure integration in Okta

1. In Okta Admin, go to **Applications → Applications**
2. Add the Azure / Microsoft Entra integration from the app catalog (or the same integration type used for the GitHub STS connection on your tenant)
3. Fill in the Entra **client ID** and **client secret** from Step A
4. Save

### Step C — Add Azure as a Resource Connection on the AI Agent

1. Go to **AI Agents** → open your **XAA AI Agent**
2. Click the **Resource Connections** tab
3. Click **Add Resource Connection**
4. Select the **Azure** integration you just created (Step B)
5. Click **Save**
6. Copy the **ORN** shown for this connection → `AZURE_RESOURCE`

### Update `.env`:

```env
AZURE_RESOURCE=orn:oktapreview:idp:<org-id>:client-auth-settings:<connection-id>
AZURE_SCOPES=
```

### Troubleshooting

| Symptom | Likely cause |
|---|---|
| Consent loop never succeeds | Redirect URI in the Entra app doesn't match `https://<okta-domain>/oauth2/v1/sts/callback` |
| T3 Graph call fails 401 | Brokered token not a Graph token — check the Entra app / connection configuration |
| T3 `/me/memberOf` fails 403 | `User.Read` delegated permission missing on the Entra app |

---

## Run the app

```sh
npm run dev
```

Open **http://localhost:5173**, sign in, pick a flow, and click a suggestion.

> If the server exits on startup it prints exactly which env variable is missing.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Server exits immediately | A required env var is blank — read the printed error |
| T1 fails (login redirect broken) | `OKTA_REDIRECT_URI` doesn't match the Chat App's redirect URI |
| T1 fails — OIDC discovery error | `OKTA_ISSUER` is missing `/oauth2/default` — must be the full issuer URL |
| T2 fails `unauthorized_client` | AI Agent doesn't have Token Exchange policy on the default auth server |
| T2 fails `invalid_client` | `AGENT_KID` doesn't match the `kid` of the key registered on the AI Agent |
| T3 fails `invalid_client` | `RESOURCE_CLIENT_ID` is wrong — must be the `wlp…` agent ID |
| T3 fails `invalid_token` | `RESOURCE_AUDIENCE` doesn't match the resource auth server's issuer URL |
| T4 fails `insufficient_scope` | `inventory:read` scope not in the resource auth server, or access policy rule missing |
| GitHub flow fails `access_denied` | GitHub Resource Connection not added to the AI Agent, or repo permissions not granted |
| GitHub flow fails `invalid_request` | Callback URL in GitHub OAuth App doesn't match `https://<okta-domain>/oauth2/v1/sts/callback` |
