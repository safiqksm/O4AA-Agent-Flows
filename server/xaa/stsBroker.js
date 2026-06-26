import { config } from '../config.js';
import { captureFormPost, captureGet, captureJsonPost } from './capture.js';
import { buildClientAssertion } from './clientAssertion.js';

const GRANT_TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const TOKEN_TYPE_ID_TOKEN = 'urn:ietf:params:oauth:token-type:id_token';
const TOKEN_TYPE_OAUTH_STS = 'urn:okta:params:oauth:token-type:oauth-sts';
const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

/**
 * T2 — STS broker token exchange. Exchanges the user's id_token for a brokered
 * resource (GitHub) access token at the org token endpoint. If Okta has no stored
 * tokens yet it returns HTTP 400 interaction_required + an interaction_uri; after
 * the user consents, the agent retries the identical request and gets HTTP 200.
 */
export async function requestResourceToken(idToken) {
  const clientAssertion = await buildClientAssertion({
    clientId: config.agent.clientId,
    audience: config.sts.assertionAudience,
    kid: config.agent.kid,
    privateKeyFile: config.agent.privateKeyFile,
  });

  const bodyParams = {
    grant_type: GRANT_TOKEN_EXCHANGE,
    requested_token_type: TOKEN_TYPE_OAUTH_STS,
    subject_token: idToken,
    subject_token_type: TOKEN_TYPE_ID_TOKEN,
    resource: config.sts.resource,
    client_assertion_type: CLIENT_ASSERTION_TYPE,
    client_assertion: clientAssertion,
  };
  if (config.sts.scopes) bodyParams.scope = config.sts.scopes;

  const { captured, responseBody, ok } = await captureFormPost(
    { id: 'T2', title: 'Resource Token Exchange', badge: 'STS', from: 'Agent', to: 'Okta Org Server', tokenField: 'access_token' },
    config.sts.tokenUrl,
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
 * T3 — Read GitHub pull requests using the brokered access token.
 */
export async function readPullRequests(accessToken) {
  const { apiBaseUrl, owner, repo } = config.github;
  const url = `${apiBaseUrl}/repos/${owner}/${repo}/pulls?state=all&per_page=5`;

  const { captured, responseBody, ok } = await captureGet(
    { id: 'T3', title: 'Read Pull Requests', badge: 'GitHub', from: 'Agent', to: 'GitHub' },
    url,
    { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json' }
  );

  return { step: captured, ok, pulls: ok && Array.isArray(responseBody) ? responseBody : null };
}

/**
 * T3 (create) — Open a GitHub pull request with the brokered token. This is a
 * write call, so it genuinely exercises the token's permissions.
 */
export async function openPullRequest(accessToken) {
  const { apiBaseUrl, owner, repo, base, head, title, body } = config.github;
  const url = `${apiBaseUrl}/repos/${owner}/${repo}/pulls`;
  const prBody = { title, head, base, body };

  const { captured, responseBody, ok } = await captureJsonPost(
    { id: 'T3', title: 'Create Pull Request', badge: 'GitHub', from: 'Agent', to: 'GitHub' },
    url,
    { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json' },
    prBody
  );

  return { step: captured, ok, pr: ok ? responseBody : null };
}

/**
 * Revoke the STS access token stored in Okta (so the next exchange re-prompts for
 * consent). Authenticated as the agent via private_key_jwt (RFC 7009 revoke).
 */
export async function revokeStsToken(token) {
  const clientAssertion = await buildClientAssertion({
    clientId: config.agent.clientId,
    audience: config.sts.revokeAssertionAudience,
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
    { id: 'R1', title: 'Revoke STS Token', badge: 'Revoke', from: 'Agent', to: 'Okta Org Server' },
    config.sts.revokeUrl,
    {},
    bodyParams
  );

  return { step: captured, ok };
}
