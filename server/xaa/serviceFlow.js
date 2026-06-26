import { config } from '../config.js';
import { captureFormPost } from './capture.js';
import { buildServiceClientAssertion, buildClientAssertion } from './clientAssertion.js';

const GRANT_CLIENT_CREDENTIALS = 'client_credentials';
const GRANT_TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const GRANT_JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const TOKEN_TYPE_ID_JAG = 'urn:ietf:params:oauth:token-type:id-jag';
const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

/**
 * T1 — Client Credentials. The service app authenticates with private_key_jwt
 * and obtains its own access token (no user involved).
 */
export async function requestServiceToken() {
  const clientAssertion = await buildServiceClientAssertion(config.service.t1TokenUrl);

  const bodyParams = {
    grant_type: GRANT_CLIENT_CREDENTIALS,
    client_assertion_type: CLIENT_ASSERTION_TYPE,
    client_assertion: clientAssertion,
  };
  if (config.service.scopes) bodyParams.scope = config.service.scopes;
  if (config.service.t1Audience) bodyParams.audience = config.service.t1Audience;
  if (config.service.t1Resource) bodyParams.resource = config.service.t1Resource;

  const { captured, responseBody, ok } = await captureFormPost(
    { id: 'T1', title: 'Client Credentials', badge: 'Access Token', from: 'Service App', to: 'Okta', tokenField: 'access_token' },
    config.service.t1TokenUrl,
    {},
    bodyParams
  );

  return { step: captured, token: ok ? responseBody.access_token : null, ok };
}

/**
 * T2 — Token Exchange → id-JAG, using the service token as the subject token.
 */
export async function requestServiceIdJag(serviceToken) {
  // T2 client_assertion: iss/sub = AGENT_CLIENT_ID, signed with the AGENT cert.
  const clientAssertion = await buildClientAssertion({
    clientId: config.agent.clientId,
    audience: config.service.tokenUrl,
    kid: config.agent.kid,
    privateKeyFile: config.agent.privateKeyFile,
  });

  const bodyParams = {
    grant_type: GRANT_TOKEN_EXCHANGE,
    subject_token: serviceToken,
    subject_token_type: config.service.subjectTokenType,
    requested_token_type: TOKEN_TYPE_ID_JAG,
    audience: config.agent.audience,
    client_assertion_type: CLIENT_ASSERTION_TYPE,
    client_assertion: clientAssertion,
  };
  if (config.service.idJagScopes) bodyParams.scope = config.service.idJagScopes;
  if (config.agent.resource) bodyParams.resource = config.agent.resource;

  const { captured, responseBody, ok } = await captureFormPost(
    { id: 'T2', title: 'Token Exchange', badge: 'ID-JAG', from: 'Agent', to: 'IdP', tokenField: 'access_token' },
    config.service.tokenUrl,
    {},
    bodyParams
  );

  return { step: captured, idJag: ok ? responseBody.access_token : null, ok };
}

/**
 * T3 — JWT-Bearer → Access Token at the resource auth server. Authenticated as the
 * agent: client_assertion iss/sub = AGENT_CLIENT_ID, signed with the agent cert.
 */
export async function exchangeServiceIdJag(idJag) {
  const clientAssertion = await buildClientAssertion({
    clientId: config.agent.clientId,
    audience: config.resource.tokenUrl,
    kid: config.agent.kid,
    privateKeyFile: config.agent.privateKeyFile,
  });

  const bodyParams = {
    grant_type: GRANT_JWT_BEARER,
    assertion: idJag,
    client_assertion_type: CLIENT_ASSERTION_TYPE,
    client_assertion: clientAssertion,
  };

  const { captured, responseBody, ok } = await captureFormPost(
    { id: 'T3', title: 'Access Token Request', badge: 'Access Token', from: 'Agent', to: 'Auth Server', tokenField: 'access_token' },
    config.resource.tokenUrl,
    {},
    bodyParams
  );

  return { step: captured, accessToken: ok ? responseBody.access_token : null, ok };
}
