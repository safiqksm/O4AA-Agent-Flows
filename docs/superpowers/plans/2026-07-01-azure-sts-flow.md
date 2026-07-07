# STS Broker (Azure) Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a sixth flow, STS Broker (Azure) (`flow=sts-azure`), that exchanges the user's Okta id_token for a brokered Microsoft Graph token and calls `GET /me` or `GET /me/memberOf` — without modifying the existing GitHub STS flow.

**Architecture:** Duplicate-and-adapt: a new `server/xaa/azureStsBroker.js` copies the GitHub STS broker pattern (org-endpoint token exchange with consent loop, Graph calls at T3, RFC 7009 revoke). New `config.azureSts`/`config.graph` blocks, a new `runStsAzureFlow` in `routes/ask.js`, a new `/api/sts/azure/revoke` endpoint, and a new `sts-azure` client flow entry. The consent UI in `Chat.jsx` is already generic over `interaction.uri`.

**Tech Stack:** Node ESM + Express (server), React 18 + Vite (client), Okta org token endpoint, Microsoft Graph v1.0.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-01-azure-sts-flow-design.md`
- Do NOT modify `server/xaa/stsBroker.js`, the GitHub branch of `routes/ask.js`, or the existing `/api/sts/revoke` endpoint.
- No test suite exists (per CLAUDE.md) — verify each task with `node --check` and the manual steps given.
- All Okta/Graph HTTP calls must go through the `capture.js` wrappers so steps render in the UI.
- New env vars: `AZURE_RESOURCE`, `AZURE_SCOPES`, `GRAPH_API_BASE_URL` (optional, default `https://graph.microsoft.com/v1.0`). None are added to `REQUIRED` in `config.js`.
- Session key for the Azure token: `req.session.azureStsAccessToken` (distinct from GitHub's `stsAccessToken`).
- Flow key: `sts-azure`. Accent color: `#0078d4`.

---

### Task 0: Create feature branch

**Files:** none

- [ ] **Step 1: Branch**

```bash
cd /Users/shafiqksm/claude/O4AA-Agent-Flows
git checkout -b feature/sts-azure
```

Expected: `Switched to a new branch 'feature/sts-azure'`

---

### Task 1: Add `azureSts` and `graph` config blocks

**Files:**
- Modify: `server/config.js` (insert after the `github` block, around line 145)

**Interfaces:**
- Produces: `config.azureSts = { tokenUrl, revokeUrl, assertionAudience, revokeAssertionAudience, resource, scopes }` and `config.graph = { apiBaseUrl }` — consumed by Task 2 and Task 3.

- [ ] **Step 1: Insert the two config blocks**

In `server/config.js`, directly after the closing `},` of the `github: { ... }` block, insert:

```js
  // STS broker flow (Azure) — same mechanics as the GitHub STS flow, but the
  // brokered token targets Microsoft Graph. May return interaction_required.
  azureSts: {
    tokenUrl: ORG_TOKEN_URL,
    revokeUrl: ORG_REVOKE_URL,
    assertionAudience: ORG_TOKEN_URL,
    revokeAssertionAudience: process.env.STS_REVOKE_AUDIENCE || ORG_REVOKE_URL,
    resource: process.env.AZURE_RESOURCE,
    // Optional 'scope' on the STS token-exchange (omitted if blank). The brokered
    // token's actual scopes are governed by the Okta Azure Resource Connection.
    scopes: process.env.AZURE_SCOPES || undefined,
  },

  // T3 of the Azure STS flow — Microsoft Graph API base.
  graph: {
    apiBaseUrl: process.env.GRAPH_API_BASE_URL || 'https://graph.microsoft.com/v1.0',
  },
```

- [ ] **Step 2: Verify syntax and values**

```bash
node --check server/config.js
node -e "import('./server/config.js').then(m => console.log(m.config.azureSts, m.config.graph))"
```

Expected: no syntax error; prints an object with `tokenUrl` ending in `/oauth2/v1/token` and `apiBaseUrl: 'https://graph.microsoft.com/v1.0'`.

- [ ] **Step 3: Commit**

```bash
git add server/config.js
git commit -m "feat(azure-sts): add azureSts and graph config blocks"
```

---

### Task 2: Create `server/xaa/azureStsBroker.js`

**Files:**
- Create: `server/xaa/azureStsBroker.js`

**Interfaces:**
- Consumes: `config.azureSts`, `config.graph` (Task 1); `captureFormPost`, `captureGet` from `./capture.js`; `buildClientAssertion` from `./clientAssertion.js`.
- Produces (consumed by Task 3):
  - `requestAzureResourceToken(idToken)` → `{ step, accessToken: string|null, ok: boolean, interactionUri: string|null }`
  - `getMyProfile(accessToken)` → `{ step, ok: boolean, profile: object|null }`
  - `getMyGroups(accessToken)` → `{ step, ok: boolean, groups: array|null }`
  - `revokeAzureStsToken(token)` → `{ step, ok: boolean }`

- [ ] **Step 1: Write the full file**

```js
import { config } from '../config.js';
import { captureFormPost, captureGet } from './capture.js';
import { buildClientAssertion } from './clientAssertion.js';

const GRANT_TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const TOKEN_TYPE_ID_TOKEN = 'urn:ietf:params:oauth:token-type:id_token';
const TOKEN_TYPE_OAUTH_STS = 'urn:okta:params:oauth:token-type:oauth-sts';
const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

/**
 * T2 — STS broker token exchange (Azure). Exchanges the user's id_token for a
 * brokered Microsoft Graph access token at the org token endpoint. If Okta has
 * no stored tokens yet it returns HTTP 400 interaction_required + an
 * interaction_uri; after the user consents, the agent retries the identical
 * request and gets HTTP 200.
 */
export async function requestAzureResourceToken(idToken) {
  const clientAssertion = await buildClientAssertion({
    clientId: config.agent.clientId,
    audience: config.azureSts.assertionAudience,
    kid: config.agent.kid,
    privateKeyFile: config.agent.privateKeyFile,
  });

  const bodyParams = {
    grant_type: GRANT_TOKEN_EXCHANGE,
    requested_token_type: TOKEN_TYPE_OAUTH_STS,
    subject_token: idToken,
    subject_token_type: TOKEN_TYPE_ID_TOKEN,
    resource: config.azureSts.resource,
    client_assertion_type: CLIENT_ASSERTION_TYPE,
    client_assertion: clientAssertion,
  };
  if (config.azureSts.scopes) bodyParams.scope = config.azureSts.scopes;

  const { captured, responseBody, ok } = await captureFormPost(
    { id: 'T2', title: 'Azure Token Exchange', badge: 'STS', from: 'Agent', to: 'Okta Org Server', tokenField: 'access_token' },
    config.azureSts.tokenUrl,
    {},
    bodyParams
  );

  // 400 interaction_required → the user must consent before the retry can succeed.
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
 * T3 — Read the signed-in user's profile from Microsoft Graph (GET /me).
 */
export async function getMyProfile(accessToken) {
  const url = `${config.graph.apiBaseUrl}/me`;

  const { captured, responseBody, ok } = await captureGet(
    { id: 'T3', title: 'Get My Profile', badge: 'Graph', from: 'Agent', to: 'Microsoft Graph' },
    url,
    { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
  );

  return { step: captured, ok, profile: ok && responseBody ? responseBody : null };
}

/**
 * T3 — List the signed-in user's group memberships (GET /me/memberOf).
 */
export async function getMyGroups(accessToken) {
  const url = `${config.graph.apiBaseUrl}/me/memberOf`;

  const { captured, responseBody, ok } = await captureGet(
    { id: 'T3', title: 'List My Groups', badge: 'Graph', from: 'Agent', to: 'Microsoft Graph' },
    url,
    { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
  );

  return {
    step: captured,
    ok,
    groups: ok && responseBody && Array.isArray(responseBody.value) ? responseBody.value : null,
  };
}

/**
 * Revoke the Azure STS access token stored in Okta (so the next exchange
 * re-prompts for consent). Authenticated as the agent via private_key_jwt
 * (RFC 7009 revoke).
 */
export async function revokeAzureStsToken(token) {
  const clientAssertion = await buildClientAssertion({
    clientId: config.agent.clientId,
    audience: config.azureSts.revokeAssertionAudience,
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
    { id: 'R1', title: 'Revoke Azure STS Token', badge: 'Revoke', from: 'Agent', to: 'Okta Org Server' },
    config.azureSts.revokeUrl,
    {},
    bodyParams
  );

  return { step: captured, ok };
}
```

- [ ] **Step 2: Verify syntax and that GitHub broker is untouched**

```bash
node --check server/xaa/azureStsBroker.js
git diff --stat server/xaa/stsBroker.js
```

Expected: no syntax error; empty diff for `stsBroker.js`.

- [ ] **Step 3: Commit**

```bash
git add server/xaa/azureStsBroker.js
git commit -m "feat(azure-sts): add Azure STS broker module (T2 exchange, Graph T3, revoke)"
```

---

### Task 3: Wire the flow into `routes/ask.js`

**Files:**
- Modify: `server/routes/ask.js`

**Interfaces:**
- Consumes: `requestAzureResourceToken`, `getMyProfile`, `getMyGroups`, `revokeAzureStsToken` (Task 2).
- Produces: `POST /api/ask` accepts `flow: 'sts-azure'`; `POST /api/sts/azure/revoke` endpoint (consumed by Task 4's `revokeAzureSts()`).

- [ ] **Step 1: Add the import**

At the top of `server/routes/ask.js`, after the existing `stsBroker.js` import line, add:

```js
import { requestAzureResourceToken, getMyProfile, getMyGroups, revokeAzureStsToken } from '../xaa/azureStsBroker.js';
```

- [ ] **Step 2: Add `runStsAzureFlow`**

Insert directly after the closing `}` of `runStsGithubFlow` (around line 253):

```js
// STS broker (Azure): resource token exchange (with consent loop) → Microsoft Graph.
async function runStsAzureFlow(idToken, steps, action) {
  if (!config.azureSts.resource) {
    return { answer: 'STS Azure flow is not configured — set AZURE_RESOURCE.' };
  }

  const t2 = await requestAzureResourceToken(idToken);
  steps.push(t2.step);
  if (!t2.ok) {
    if (t2.interactionUri) {
      return {
        answer:
          'Consent required: authorize the Azure connection, then click Retry to re-run the request.',
        interaction: { uri: t2.interactionUri },
      };
    }
    return { answer: 'The resource token request failed — see step T2 for the error response.' };
  }

  const azureStsAccessToken = t2.accessToken;

  if (action === 'groups') {
    const t3 = await getMyGroups(azureStsAccessToken);
    steps.push(t3.step);
    if (!t3.ok) {
      return { answer: 'The Microsoft Graph memberOf call failed — see step T3 for the response.', azureStsAccessToken };
    }
    const groups = (t3.groups || []).filter((g) => g['@odata.type'] === '#microsoft.graph.group');
    return {
      answer: groups.length
        ? `You are a member of ${groups.length} group(s):\n\n` +
          groups.map((g) => `• ${g.displayName ?? g.id}`).join('\n')
        : 'No group memberships found for your account.',
      azureStsAccessToken,
    };
  }

  const t3 = await getMyProfile(azureStsAccessToken);
  steps.push(t3.step);
  if (!t3.ok) {
    return { answer: 'The Microsoft Graph profile call failed — see step T3 for the response.', azureStsAccessToken };
  }
  const p = t3.profile || {};
  return {
    answer:
      `Here is your Azure profile:\n\n` +
      `• Name: ${p.displayName ?? '—'}\n` +
      `• Email: ${p.mail ?? p.userPrincipalName ?? '—'}\n` +
      `• Job title: ${p.jobTitle ?? '—'}\n` +
      `• Office: ${p.officeLocation ?? '—'}`,
    azureStsAccessToken,
  };
}
```

- [ ] **Step 3: Add the router branch**

In `router.post('/ask', ...)`, insert this branch between the `sts-github` branch and the final `else`:

```js
    } else if (flow === 'sts-azure') {
      const action = /\bgroups?\b|member/i.test(question || '') ? 'groups' : 'profile';
      const r = await runStsAzureFlow(req.session.idToken, steps, action);
      answer = r.answer;
      interaction = r.interaction;
      if (r.azureStsAccessToken) req.session.azureStsAccessToken = r.azureStsAccessToken;
```

- [ ] **Step 4: Add the Azure revoke endpoint**

After the existing `router.post('/sts/revoke', ...)` block, add:

```js
// Revoke the stored Azure STS token (agent-authenticated) so the next exchange re-prompts consent.
router.post('/sts/azure/revoke', async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'not_authenticated' });
  }
  const token = req.session.azureStsAccessToken;
  if (!token) {
    return res.json({
      answer: 'No Azure STS token to revoke yet — run “Get my Azure profile” first to obtain one.',
      steps: [],
    });
  }
  try {
    const r = await revokeAzureStsToken(token);
    if (r.ok) req.session.azureStsAccessToken = undefined;
    res.json({
      answer: r.ok
        ? 'Azure STS token revoked. Run “Get my Azure profile” again to re-trigger consent.'
        : 'Revoke request failed — see the step for details.',
      steps: [r.step],
    });
  } catch (err) {
    console.error('[sts/azure/revoke] error:', err);
    res.json({ answer: `Revoke error: ${err.message}`, steps: [] });
  }
});
```

- [ ] **Step 5: Verify syntax and server boot**

```bash
node --check server/routes/ask.js
timeout 5 node server/index.js; true
```

Expected: no syntax error; server prints `🚀 XAA demo server on http://localhost:8080` (then times out — fine). If it exits with a missing-env error, the env is at fault, not this change.

- [ ] **Step 6: Commit**

```bash
git add server/routes/ask.js
git commit -m "feat(azure-sts): route sts-azure flow and add /api/sts/azure/revoke"
```

---

### Task 4: Client — flow entry, API wrapper, revoke bar

**Files:**
- Modify: `client/src/flows.js`
- Modify: `client/src/api.js`
- Modify: `client/src/components/Chat.jsx`

**Interfaces:**
- Consumes: `POST /api/ask` with `flow: 'sts-azure'`; `POST /api/sts/azure/revoke` (Task 3).
- Produces: `FLOWS['sts-azure']` entry; `revokeAzureSts()` in `api.js`.

- [ ] **Step 1: Add the flow entry**

In `client/src/flows.js`, after the `'sts-github'` entry (before the closing `};`), add:

```js
  'sts-azure': {
    id: 'sts-azure',
    name: 'STS Broker (Azure)',
    tagline: 'token-exchange → Graph token → read profile',
    description:
      'Exchange the user’s ID token for a Microsoft Graph access token brokered by Okta. If consent is needed, Okta returns interaction_required — authorize, then retry — and the agent reads your Azure profile or group memberships with the brokered token.',
    accent: '#0078d4',
    suggestions: [
      { label: 'Get my Azure profile', text: 'Get my Azure profile' },
      { label: 'List my groups', text: 'List my groups' },
    ],
  },
```

- [ ] **Step 2: Add the revoke wrapper**

In `client/src/api.js`, after the `revokeSts()` function, add:

```js
export async function revokeAzureSts() {
  const res = await fetch('/api/sts/azure/revoke', {
    method: 'POST',
    credentials: 'include',
  });
  return res.json();
}
```

- [ ] **Step 3: Update `Chat.jsx`**

Three edits:

3a. Update the import line:

```js
import { ask, revokeSts, revokeAzureSts } from '../api.js';
```

3b. Replace the greeting initializer (the `useState` for `messages`) with:

```js
  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      text: `Hi! ${
        flow.id === 'sts-github'
          ? 'Click “Read pull requests” or “Create a pull request” to start.'
          : flow.id === 'sts-azure'
            ? 'Click “Get my Azure profile” or “List my groups” to start.'
            : 'Ask me about inventory or recent shipments.'
      } I’ll run it through the ${flow.name} flow.`,
    },
  ]);
```

3c. Replace the `revoke` function with:

```js
  async function revoke() {
    if (busy) return;
    setInteraction(null);
    setBusy(true);
    try {
      const res = flow.id === 'sts-azure' ? await revokeAzureSts() : await revokeSts();
      setMessages((m) => [...m, { role: 'assistant', text: res.answer }]);
      if (res.steps?.length) setSteps((prev) => [...prev, ...res.steps]);
    } catch (err) {
      setMessages((m) => [...m, { role: 'assistant', text: `Revoke failed: ${err.message}` }]);
    } finally {
      setBusy(false);
    }
  }
```

3d. Replace the input `placeholder` expression with:

```js
placeholder={
  flow.id === 'sts-github'
    ? 'Ask the agent to read pull requests…'
    : flow.id === 'sts-azure'
      ? 'Ask the agent for your Azure profile…'
      : 'Ask about inventory or shipments…'
}
```

3e. Replace the revoke-bar condition `{flow.id === 'sts-github' && (` with:

```js
{(flow.id === 'sts-github' || flow.id === 'sts-azure') && (
```

and the button label line with:

```js
Revoke STS token (re-trigger consent)
```

(label unchanged — it applies to both flows).

- [ ] **Step 4: Verify the client builds**

```bash
npm run build
```

Expected: Vite build completes with no errors.

- [ ] **Step 5: Commit**

```bash
git add client/src/flows.js client/src/api.js client/src/components/Chat.jsx
git commit -m "feat(azure-sts): add sts-azure flow to client with revoke support"
```

---

### Task 5: Env samples and documentation

**Files:**
- Modify: `.env` (append Azure block)
- Modify: `.env-sample` (append same block)
- Modify: `OKTA_SETUP.md` (new Azure section after the GitHub section)
- Modify: `UNDERSTANDING.md` (new flow 6 description after flow 5)

- [ ] **Step 1: Append the env block**

Append to both `.env` and `.env-sample`:

```env

# ── STS Broker flow (Azure): token-exchange → brokered Graph token → Microsoft Graph ──
# Resource indicator (ORN) from the Azure Resource Connection on the AI Agent.
AZURE_RESOURCE=
# Optional 'scope' on the STS token-exchange (omitted if blank).
AZURE_SCOPES=
# GRAPH_API_BASE_URL=https://graph.microsoft.com/v1.0
```

(In `.env`, fill `AZURE_RESOURCE` with the real ORN once the Okta connection exists.)

- [ ] **Step 2: Add the OKTA_SETUP.md section**

Insert after the "GitHub STS Broker flow" section (before "## Run the app"):

```markdown
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
```

- [ ] **Step 3: Add the UNDERSTANDING.md flow description**

Insert after the STS Broker (GitHub) section (after the "Revoking consent" block, before `---`):

```markdown
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
```

- [ ] **Step 4: Commit**

```bash
git add .env-sample OKTA_SETUP.md UNDERSTANDING.md
git commit -m "docs(azure-sts): setup steps, env sample, and flow description"
```

(`.env` is gitignored — do not add it.)

---

### Task 6: End-to-end verification

**Files:** none (manual verification)

- [ ] **Step 1: Confirm GitHub code untouched**

```bash
git diff master --stat -- server/xaa/stsBroker.js
```

Expected: empty output.

- [ ] **Step 2: Boot and click through**

```bash
npm run dev
```

Then in the browser at `http://localhost:5173`:

1. Sign in, pick **STS Broker (Azure)**.
2. With `AZURE_RESOURCE` blank → answer says "STS Azure flow is not configured". ✓
3. With `AZURE_RESOURCE` set: click **Get my Azure profile** → expect the consent card (Authorize connection ↗ / Retry) on first run.
4. Authorize in the new tab, click **Retry** → T2 shows HTTP 200, T3 shows your Graph profile.
5. Click **List my groups** → T3 shows group list.
6. Click **Revoke STS token** → R1 step renders; re-run profile → consent card returns. ✓
7. Switch to **STS Broker (GitHub)**, click **Read pull requests** → still works. ✓
