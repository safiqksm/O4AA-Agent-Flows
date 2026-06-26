import { config } from '../config.js';
import { captureFormPost } from './capture.js';
import { buildClientAssertion } from './clientAssertion.js';

const GRANT_TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const TOKEN_TYPE_ID_TOKEN = 'urn:ietf:params:oauth:token-type:id_token';
const TOKEN_TYPE_VAULTED_SECRET = 'urn:okta:params:oauth:token-type:vaulted-secret';
const TOKEN_TYPE_SERVICE_ACCOUNT = 'urn:okta:params:oauth:token-type:service-account';
const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

// Pull a username/password out of the returned credential object. Service accounts
// return { username, password }; vaulted secrets return arbitrary key/value pairs,
// so prefer username/password keys and fall back to the first two values.
function extractCreds(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const keys = Object.keys(obj);
  const username = obj.username ?? obj.user ?? (keys[0] ? obj[keys[0]] : undefined);
  const password = obj.password ?? obj.pass ?? (keys[1] ? obj[keys[1]] : undefined);
  if (username == null || password == null) return null;
  return { username: String(username), password: String(password) };
}

/**
 * Shared T2 for the Secrets / Service Account flows: exchange the user's id_token
 * at the org token endpoint for vaulted static credentials, authenticating with a
 * private_key_jwt signed by the agent cert.
 */
async function requestVaultedCredential({ flowCfg, requestedTokenType, credentialField, step }) {
  const clientAssertion = await buildClientAssertion({
    clientId: config.agent.clientId,
    audience: flowCfg.assertionAudience,
    kid: config.agent.kid,
  });

  const bodyParams = {
    grant_type: GRANT_TOKEN_EXCHANGE,
    requested_token_type: requestedTokenType,
    subject_token: step.idToken,
    subject_token_type: TOKEN_TYPE_ID_TOKEN,
    resource: flowCfg.resource,
    client_assertion_type: CLIENT_ASSERTION_TYPE,
    client_assertion: clientAssertion,
  };

  const { captured, responseBody, ok } = await captureFormPost(
    { id: 'T2', title: step.title, badge: step.badge, from: 'Agent', to: 'Okta Org Server' },
    flowCfg.tokenUrl,
    {},
    bodyParams
  );

  const credObj = ok && responseBody && typeof responseBody === 'object' ? responseBody[credentialField] : null;
  const creds = extractCreds(credObj);
  return { step: captured, creds, ok: ok && !!creds };
}

/** T2 (Secrets) — exchange id_token for a vaulted secret. */
export function requestVaultedSecret(idToken) {
  return requestVaultedCredential({
    flowCfg: config.secrets,
    requestedTokenType: TOKEN_TYPE_VAULTED_SECRET,
    credentialField: 'vaulted_secret',
    step: { idToken, title: 'Retrieve Vaulted Secret', badge: 'Secret' },
  });
}

/** T2 (Service Account) — exchange id_token for service account credentials. */
export function requestServiceAccount(idToken) {
  return requestVaultedCredential({
    flowCfg: config.serviceAccount,
    requestedTokenType: TOKEN_TYPE_SERVICE_ACCOUNT,
    credentialField: 'service_account',
    step: { idToken, title: 'Retrieve Service Account', badge: 'Service Account' },
  });
}
