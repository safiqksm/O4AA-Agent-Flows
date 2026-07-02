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
