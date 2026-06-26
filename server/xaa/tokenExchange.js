import { config } from '../config.js';
import { captureFormPost } from './capture.js';
import { buildAgentClientAssertion, buildResourceClientAssertion } from './clientAssertion.js';

const GRANT_TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const GRANT_JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const TOKEN_TYPE_ID_TOKEN = 'urn:ietf:params:oauth:token-type:id_token';
const TOKEN_TYPE_ID_JAG = 'urn:ietf:params:oauth:token-type:id-jag';
const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

/**
 * T2 — Token Exchange → id-JAG.
 * Agent authenticates to the IdP with a private_key_jwt client assertion and
 * exchanges the user's id_token for an Identity Assertion Authorization Grant.
 */
export async function requestIdJag(idToken) {
  // Signing can throw (key not found, not PKCS#8, wrong alg) — surface it as a
  // failed T2 step rather than crashing the request with no visible cause.
  let clientAssertion;
  try {
    clientAssertion = await buildAgentClientAssertion();
  } catch (err) {
    console.error('[T2] client_assertion signing failed:', err);
    return {
      step: {
        id: 'T2',
        title: 'Token Exchange',
        badge: 'ID-JAG',
        from: 'Agent',
        to: 'IdP',
        ok: false,
        request: { method: 'POST', url: config.agent.tokenUrl, headers: {}, body: '(request not sent — client_assertion could not be built)' },
        response: { status: 0, headers: {}, body: { error: 'client_assertion_error', error_description: err.message } },
        token: null,
        code: '',
      },
      idJag: null,
      ok: false,
    };
  }

  const bodyParams = {
    grant_type: GRANT_TOKEN_EXCHANGE,
    subject_token: idToken,
    subject_token_type: TOKEN_TYPE_ID_TOKEN,
    requested_token_type: TOKEN_TYPE_ID_JAG,
    audience: config.agent.audience,
    scope: config.agent.scopes,
    client_assertion_type: CLIENT_ASSERTION_TYPE,
    client_assertion: clientAssertion,
  };
  if (config.agent.resource) bodyParams.resource = config.agent.resource;

  const { captured, responseBody, ok } = await captureFormPost(
    {
      id: 'T2',
      title: 'Token Exchange',
      badge: 'ID-JAG',
      from: 'Agent',
      to: 'IdP',
      tokenField: 'access_token', // the id-JAG is returned in access_token (token_type: N_A)
    },
    config.agent.tokenUrl,
    {},
    bodyParams
  );

  return { step: captured, idJag: ok ? responseBody.access_token : null, ok };
}

/**
 * T3 — JWT-Bearer → Access Token.
 * Agent presents the id-JAG to the resource's authorization server, authenticating
 * with a private_key_jwt client assertion signed by the same agent cert.
 */
export async function exchangeForAccessToken(idJag) {
  const clientAssertion = await buildResourceClientAssertion();

  const bodyParams = {
    grant_type: GRANT_JWT_BEARER,
    assertion: idJag,
    client_assertion_type: CLIENT_ASSERTION_TYPE,
    client_assertion: clientAssertion,
  };

  const { captured, responseBody, ok } = await captureFormPost(
    {
      id: 'T3',
      title: 'Access Token Request',
      badge: 'Access Token',
      from: 'Agent',
      to: 'Auth Server',
      tokenField: 'access_token',
    },
    config.resource.tokenUrl,
    {},
    bodyParams
  );

  return { step: captured, accessToken: ok ? responseBody.access_token : null, ok };
}
