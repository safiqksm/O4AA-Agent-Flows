import { Router } from 'express';
import { config } from '../config.js';
import { requestIdJag, exchangeForAccessToken } from '../xaa/tokenExchange.js';
import { requestVaultedSecret, requestServiceAccount } from '../xaa/credentialExchange.js';
import { requestServiceToken, requestServiceIdJag, exchangeServiceIdJag } from '../xaa/serviceFlow.js';
import { requestResourceToken, readPullRequests, openPullRequest, revokeStsToken } from '../xaa/stsBroker.js';
import { requestAzureResourceToken, getMyProfile, getMyGroups, revokeAzureStsToken } from '../xaa/azureStsBroker.js';
import { requestMcpGithubToken, mcpInitialize, mcpListTools, mcpCallGetMe, revokeMcpGithubToken } from '../xaa/mcpGithubBroker.js';
import { callMcpTool } from '../mcp/inventoryServer.js';
import { validateAccessToken } from '../util/verifyToken.js';
import { decodeJwt } from '../util/jwt.js';

const router = Router();

// Deterministic routing of a question to an MCP tool.
function routeTool(question) {
  const q = (question || '').toLowerCase();
  if (q.includes('shipment') || q.includes('shipping') || q.includes('delivery')) {
    return 'get_last_5_shipments';
  }
  // inventory / stock / default
  return 'get_inventory_details';
}

function maskToken(t) {
  if (!t || t.length < 24) return t;
  return `${t.slice(0, 12)}…${t.slice(-8)}`;
}

// Build the T4 (MCP tool call) step manually — it's an in-process call, not HTTP,
// but we render it with the same shape and show the bearer access token in use.
function buildMcpStep(toolName, accessToken, result, validation) {
  const status = validation.ok ? 200 : validation.verified ? 403 : 401;
  const body = validation.ok
    ? { tokenValidation: validation, data: result }
    : {
        error: validation.verified ? 'insufficient_scope' : 'invalid_token',
        error_description: validation.verified
          ? `Token is missing required scope(s): ${validation.requiredScopes.join(', ')}`
          : `Access token failed validation${validation.error ? ` (${validation.error})` : ''}`,
        tokenValidation: validation,
      };
  return {
    id: 'T4',
    title: `MCP Tool Call · ${toolName}`,
    badge: 'MCP',
    from: 'Agent',
    to: 'Inventory MCP',
    ok: validation.ok,
    request: {
      method: 'POST',
      url: `${config.agent.resource || 'mcp://inventory/'}tools/call`,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${maskToken(accessToken)}`,
      },
      body: JSON.stringify({ method: 'tools/call', params: { name: toolName, arguments: {} } }, null, 2),
    },
    response: { status, headers: { 'Content-Type': 'application/json' }, body },
    token: decodeJwt(accessToken),
    code: `# MCP tools/call with the resource access token\ncurl -X POST '<mcp-endpoint>/tools/call' \\\n  -H 'Authorization: Bearer ${maskToken(accessToken)}' \\\n  -H 'Content-Type: application/json' \\\n  -d '${JSON.stringify({ name: toolName, arguments: {} })}'`,
  };
}

// T3 of the Secrets / Service Account flows: call the MCP with HTTP Basic auth
// using the retrieved credentials. The MCP validates them against config.mcpBasic.
function validateBasic(creds) {
  return !!(
    config.mcpBasic.username &&
    config.mcpBasic.password &&
    creds &&
    creds.username === config.mcpBasic.username &&
    creds.password === config.mcpBasic.password
  );
}

function buildBasicMcpStep(toolName, creds, result, ok) {
  const masked = '•'.repeat(Math.max(4, (creds?.password || '').length));
  const encoded = Buffer.from(`${creds?.username || ''}:${masked}`).toString('base64');
  const status = ok ? 200 : 401;
  const body = ok
    ? { basicAuth: { username: creds.username, validated: true }, data: result }
    : {
        error: 'invalid_credentials',
        error_description: 'The presented Basic credentials did not match the MCP server configuration.',
        basicAuth: { username: creds?.username, validated: false },
      };
  return {
    id: 'T3',
    title: `MCP Tool Call · ${toolName}`,
    badge: 'MCP',
    from: 'Agent',
    to: 'Inventory MCP',
    ok,
    request: {
      method: 'POST',
      url: 'mcp://inventory/tools/call',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${encoded}` },
      body: JSON.stringify({ method: 'tools/call', params: { name: toolName, arguments: {} } }, null, 2),
    },
    response: { status, headers: { 'Content-Type': 'application/json' }, body },
    token: null,
    code: `# MCP tools/call with HTTP Basic auth (creds from the secret/service account)\ncurl -X POST '<mcp-endpoint>/tools/call' \\\n  -u '${creds?.username || '<username>'}:<password>' \\\n  -H 'Content-Type: application/json' \\\n  -d '${JSON.stringify({ name: toolName, arguments: {} })}'`,
  };
}

function summarize(toolName, result) {
  if (toolName === 'get_inventory_details') {
    const low = result.items.filter((i) => i.quantity <= i.reorderLevel);
    const lines = result.items.map((i) => `• ${i.name} (${i.sku}) — ${i.quantity} in stock @ ${i.location}`);
    let answer = `Here are the current inventory details (${result.count} SKUs):\n\n${lines.join('\n')}`;
    if (low.length) {
      answer += `\n\n⚠️ ${low.length} item(s) at or below reorder level: ${low.map((i) => i.sku).join(', ')}.`;
    }
    return answer;
  }
  if (toolName === 'get_last_5_shipments') {
    const lines = result.shipments.map(
      (s) => `• ${s.id} — ${s.status} via ${s.carrier} → ${s.destination} (${s.items} items, ${s.date})`
    );
    return `Here are the last ${result.count} shipments:\n\n${lines.join('\n')}`;
  }
  return JSON.stringify(result, null, 2);
}

// Cross-App Access: id-JAG → access token → token-validated MCP call.
async function runXaaFlow(idToken, toolName, steps) {
  const t2 = await requestIdJag(idToken);
  steps.push(t2.step);
  if (!t2.ok) return 'The token exchange (id-JAG) request failed — see step T2 for the error response.';

  const t3 = await exchangeForAccessToken(t2.idJag);
  steps.push(t3.step);
  if (!t3.ok) return 'The access token request failed — see step T3 for the error response.';

  const requiredScopes = (config.resource.scopes || '').split(' ').filter(Boolean);
  const validation = await validateAccessToken(t3.accessToken, requiredScopes);
  if (!validation.ok) {
    steps.push(buildMcpStep(toolName, t3.accessToken, null, validation));
    return validation.verified
      ? `Access denied: the token is missing the required scope(s) ${requiredScopes.join(', ')}. See step T4.`
      : `Access denied: the access token failed validation${validation.error ? ` (${validation.error})` : ''}. See step T4.`;
  }

  const result = await callMcpTool(toolName);
  steps.push(buildMcpStep(toolName, t3.accessToken, result, validation));
  return summarize(toolName, result);
}

// Secrets / Service Account: retrieve vaulted creds, then call the MCP with HTTP Basic auth.
async function runCredentialFlow(flow, idToken, toolName, steps) {
  const isSecret = flow === 'secrets';
  const label = isSecret ? 'vaulted secret' : 'service account';

  const t2 = isSecret ? await requestVaultedSecret(idToken) : await requestServiceAccount(idToken);
  steps.push(t2.step);
  if (!t2.ok) return `The ${label} request failed — see step T2 for the error response.`;

  const basicOk = validateBasic(t2.creds);
  if (!basicOk) {
    steps.push(buildBasicMcpStep(toolName, t2.creds, null, false));
    return 'Access denied: the retrieved credentials did not match the MCP server (HTTP 401). See step T3.';
  }

  const result = await callMcpTool(toolName);
  steps.push(buildBasicMcpStep(toolName, t2.creds, result, true));
  return summarize(toolName, result);
}

// Service App: client_credentials → id-JAG → access token → token-validated MCP call.
async function runServiceFlow(toolName, steps) {
  if (!config.service.clientId || !config.service.privateKeyFile) {
    return 'Service App flow is not configured — set SERVICE_CLIENT_ID and SERVICE_PRIVATE_KEY_FILE.';
  }

  const t1 = await requestServiceToken();
  steps.push(t1.step);
  if (!t1.ok) return 'The client_credentials request failed — see step T1 for the error response.';

  const t2 = await requestServiceIdJag(t1.token);
  steps.push(t2.step);
  if (!t2.ok) return 'The token exchange (id-JAG) request failed — see step T2 for the error response.';

  const t3 = await exchangeServiceIdJag(t2.idJag);
  steps.push(t3.step);
  if (!t3.ok) return 'The access token request failed — see step T3 for the error response.';

  const requiredScopes = (config.resource.scopes || '').split(' ').filter(Boolean);
  const validation = await validateAccessToken(t3.accessToken, requiredScopes);
  if (!validation.ok) {
    steps.push(buildMcpStep(toolName, t3.accessToken, null, validation));
    return validation.verified
      ? `Access denied: the token is missing the required scope(s) ${requiredScopes.join(', ')}. See step T4.`
      : `Access denied: the access token failed validation${validation.error ? ` (${validation.error})` : ''}. See step T4.`;
  }

  const result = await callMcpTool(toolName);
  steps.push(buildMcpStep(toolName, t3.accessToken, result, validation));
  return summarize(toolName, result);
}

// STS broker (GitHub): resource token exchange (with consent loop) → read/create PR.
async function runStsGithubFlow(idToken, steps, action) {
  if (!config.sts.resource) {
    return { answer: 'STS GitHub flow is not configured — set GITHUB_RESOURCE.' };
  }

  const t2 = await requestResourceToken(idToken);
  steps.push(t2.step);
  if (!t2.ok) {
    if (t2.interactionUri) {
      return {
        answer:
          'Consent required: authorize the GitHub connection, then click Retry to re-run the request.',
        interaction: { uri: t2.interactionUri },
      };
    }
    return { answer: 'The resource token request failed — see step T2 for the error response.' };
  }

  const stsAccessToken = t2.accessToken;

  if (action === 'create') {
    const t3 = await openPullRequest(stsAccessToken);
    steps.push(t3.step);
    if (!t3.ok) {
      return {
        answer: `The GitHub create-pull-request call failed (HTTP ${t3.step.response.status}) — see step T3. A write call like this is what actually exercises the brokered token's permissions.`,
        stsAccessToken,
      };
    }
    const pr = t3.pr;
    return {
      answer: pr?.html_url
        ? `Pull request opened: #${pr.number} → ${pr.html_url}`
        : 'Create pull request completed — see step T3 for the GitHub response.',
      stsAccessToken,
    };
  }

  const t3 = await readPullRequests(stsAccessToken);
  steps.push(t3.step);
  if (!t3.ok) {
    return { answer: 'The GitHub pull request read failed — see step T3 for the response.', stsAccessToken };
  }

  const pulls = t3.pulls || [];
  return {
    answer: pulls.length
      ? `Found ${pulls.length} pull request(s):\n\n` +
        pulls.map((p) => `• #${p.number} ${p.title} (${p.state}) — ${p.user?.login ?? 'unknown'}`).join('\n')
      : 'No pull requests found in the repository.',
    stsAccessToken,
  };
}

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

router.post('/ask', async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'not_authenticated' });
  }

  const { question, flow = 'xaa' } = req.body;
  const toolName = routeTool(question);
  const steps = [];

  try {
    let answer;
    let interaction;
    if (flow === 'secrets' || flow === 'service-account') {
      answer = await runCredentialFlow(flow, req.session.idToken, toolName, steps);
    } else if (flow === 'client-credentials') {
      answer = await runServiceFlow(toolName, steps);
    } else if (flow === 'sts-github') {
      const action = /\b(create|open|new|raise)\b/i.test(question || '') ? 'create' : 'read';
      const r = await runStsGithubFlow(req.session.idToken, steps, action);
      answer = r.answer;
      interaction = r.interaction;
      if (r.stsAccessToken) req.session.stsAccessToken = r.stsAccessToken;
    } else if (flow === 'sts-azure') {
      const action = /\bgroups?\b|member/i.test(question || '') ? 'groups' : 'profile';
      const r = await runStsAzureFlow(req.session.idToken, steps, action);
      answer = r.answer;
      interaction = r.interaction;
      if (r.azureStsAccessToken) req.session.azureStsAccessToken = r.azureStsAccessToken;
    } else if (flow === 'mcp-github') {
      const action = /\bwho\b|whoami|profile|\bme\b/i.test(question || '') ? 'whoami' : 'tools';
      const r = await runMcpGithubFlow(req.session.idToken, steps, action);
      answer = r.answer;
      interaction = r.interaction;
      if (r.mcpGithubStsToken) req.session.mcpGithubStsToken = r.mcpGithubStsToken;
    } else {
      answer = await runXaaFlow(req.session.idToken, toolName, steps);
    }
    res.json({ answer, toolName, flow, steps, interaction });
  } catch (err) {
    console.error('[ask] unexpected error:', err);
    res.json({
      answer: `Unexpected error while running the chain: ${err.message}`,
      toolName,
      flow,
      steps,
    });
  }
});

// Revoke the stored STS token (agent-authenticated) so the next exchange re-prompts consent.
router.post('/sts/revoke', async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'not_authenticated' });
  }
  const token = req.session.stsAccessToken;
  if (!token) {
    return res.json({
      answer: 'No STS token to revoke yet — run “Read pull requests” first to obtain one.',
      steps: [],
    });
  }
  try {
    const r = await revokeStsToken(token);
    if (r.ok) req.session.stsAccessToken = undefined;
    res.json({
      answer: r.ok
        ? 'STS token revoked. Run “Read pull requests” again to re-trigger consent.'
        : 'Revoke request failed — see the step for details.',
      steps: [r.step],
    });
  } catch (err) {
    console.error('[sts/revoke] error:', err);
    res.json({ answer: `Revoke error: ${err.message}`, steps: [] });
  }
});

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

export default router;
