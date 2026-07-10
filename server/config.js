import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env from project root regardless of where node was launched from.
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const REQUIRED = [
  'SESSION_SECRET',
  'OKTA_ISSUER',
  'OKTA_CLIENT_ID',
  'OKTA_CLIENT_SECRET',
  'OKTA_REDIRECT_URI',
  'RESOURCE_AUTH_SERVER',
  'AGENT_CLIENT_ID',
  'AGENT_PRIVATE_KEY_FILE',
  'AGENT_KID',
  'RESOURCE_CLIENT_ID',
];

// Build the standard Okta token endpoint from an authorization server base URL.
// Custom auth server: https://org.okta.com/oauth2/<id>  -> .../oauth2/<id>/v1/token
// Org auth server:    https://org.okta.com              -> .../oauth2/v1/token
const tokenEndpoint = (authServer) => {
  if (!authServer) return undefined;
  const base = authServer.replace(/\/$/, '');
  return base.includes('/oauth2') ? `${base}/v1/token` : `${base}/oauth2/v1/token`;
};

// Same shape for the JWKS (public keys) endpoint used to verify access tokens.
const keysEndpoint = (authServer) => {
  if (!authServer) return undefined;
  const base = authServer.replace(/\/$/, '');
  return base.includes('/oauth2') ? `${base}/v1/keys` : `${base}/oauth2/v1/keys`;
};

// Agent auth server (IdP where the user logged in / token-exchange happens).
// Defaults to OKTA_ISSUER since that's the same authorization server.
const AGENT_AUTH_SERVER = process.env.AGENT_AUTH_SERVER || process.env.OKTA_ISSUER;
const RESOURCE_AUTH_SERVER = process.env.RESOURCE_AUTH_SERVER;

// Secrets & Service Account token exchanges MUST use the ORG authorization server
// token endpoint (/oauth2/v1/token), never a custom one. Derive the org base by
// stripping any /oauth2/... suffix from the issuer.
const ORG_BASE = (process.env.OKTA_ORG_URL || process.env.OKTA_ISSUER || '')
  .replace(/\/oauth2\/.*$/, '')
  .replace(/\/$/, '');
const ORG_TOKEN_URL = ORG_BASE ? `${ORG_BASE}/oauth2/v1/token` : undefined;
const ORG_REVOKE_URL = ORG_BASE ? `${ORG_BASE}/oauth2/v1/revoke` : undefined;

export const config = {
  port: Number(process.env.PORT || 8080),
  appBaseUrl: process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 8080}`,
  sessionSecret: process.env.SESSION_SECRET,

  okta: {
    issuer: process.env.OKTA_ISSUER,
    clientId: process.env.OKTA_CLIENT_ID,
    clientSecret: process.env.OKTA_CLIENT_SECRET,
    redirectUri: process.env.OKTA_REDIRECT_URI,
    scopes: process.env.OKTA_SCOPES || 'openid profile email',
  },

  // T2 — token exchange (private_key_jwt) at the agent's authorization server
  agent: {
    authServer: AGENT_AUTH_SERVER,
    tokenUrl: tokenEndpoint(AGENT_AUTH_SERVER),
    clientId: process.env.AGENT_CLIENT_ID,
    privateKeyFile: process.env.AGENT_PRIVATE_KEY_FILE,
    // PEM content (e.g. from Key Vault via an App Service setting) takes
    // precedence over privateKeyFile when both are present.
    privateKey: process.env.AGENT_PRIVATE_KEY || undefined,
    kid: process.env.AGENT_KID,
    // 'aud' of the client_assertion JWT = the token endpoint it's sent to (RFC 7523).
    assertionAudience: tokenEndpoint(AGENT_AUTH_SERVER),
    // 'audience' request param = the audience VALUE configured on the resource
    // authorization server in Okta (e.g. api://resource). Falls back to the
    // resource auth server URL only if RESOURCE_AUDIENCE is not set.
    audience: process.env.RESOURCE_AUDIENCE || RESOURCE_AUTH_SERVER,
    resource: process.env.XAA_RESOURCE || undefined,
    scopes: process.env.XAA_SCOPES || 'inventory:read',
  },

  // T3 — jwt-bearer (private_key_jwt, same agent cert) at the resource's authorization server
  resource: {
    authServer: RESOURCE_AUTH_SERVER,
    tokenUrl: tokenEndpoint(RESOURCE_AUTH_SERVER),
    // For T4 access-token validation: the issuer (iss claim) and JWKS endpoint.
    issuer: RESOURCE_AUTH_SERVER ? RESOURCE_AUTH_SERVER.replace(/\/$/, '') : undefined,
    jwksUri: keysEndpoint(RESOURCE_AUTH_SERVER),
    clientId: process.env.RESOURCE_CLIENT_ID,
    // 'aud' of the T3 client_assertion = the resource token endpoint it's sent to.
    assertionAudience: tokenEndpoint(RESOURCE_AUTH_SERVER),
    // Same signing cert as the agent; override only if the resource client uses a different kid.
    kid: process.env.RESOURCE_KID || process.env.AGENT_KID,
    scopes: process.env.RESOURCE_SCOPES || 'inventory:read',
  },

  // Service App (Client Credentials) flow — a headless service identity instead
  // of a user. Authenticates all calls with its own private_key_jwt cert.
  service: {
    clientId: process.env.SERVICE_CLIENT_ID,
    privateKeyFile: process.env.SERVICE_PRIVATE_KEY_FILE,
    privateKey: process.env.SERVICE_PRIVATE_KEY || undefined,
    kid: process.env.SERVICE_KID,
    // T1 only: SERVICE_ISSUER = the auth server the service app gets its token from
    // (client_credentials); SERVICE_AUDIENCE = the 'audience' param in that T1 call.
    t1TokenUrl: tokenEndpoint(
      process.env.SERVICE_ISSUER || process.env.SERVICE_AUTH_SERVER || AGENT_AUTH_SERVER
    ),
    t1Audience: process.env.SERVICE_AUDIENCE || undefined,
    t1Resource: process.env.SERVICE_RESOURCE || undefined,
    // T2 (token-exchange) endpoint — unchanged, independent of SERVICE_ISSUER.
    tokenUrl: tokenEndpoint(process.env.SERVICE_AUTH_SERVER || AGENT_AUTH_SERVER),
    scopes: process.env.SERVICE_SCOPES || undefined,
    // 'scope' param for the T2 id-JAG token-exchange (omitted if blank).
    idJagScopes: process.env.SERVICE_IDJAG_SCOPES || 'inventory:read',
    // What kind of token the service token is when used as subject_token at T2.
    subjectTokenType:
      process.env.SERVICE_SUBJECT_TOKEN_TYPE || 'urn:ietf:params:oauth:token-type:access_token',
  },

  // STS broker flow (T2) — exchange the user id_token for a brokered resource
  // (e.g. GitHub) token at the org token endpoint. May return interaction_required.
  sts: {
    tokenUrl: ORG_TOKEN_URL,
    revokeUrl: ORG_REVOKE_URL,
    assertionAudience: ORG_TOKEN_URL,
    // 'aud' of the client_assertion for the REVOKE call = the revoke endpoint.
    revokeAssertionAudience: process.env.STS_REVOKE_AUDIENCE || ORG_REVOKE_URL,
    resource: process.env.GITHUB_RESOURCE,
    // Optional 'scope' on the STS token-exchange (omitted if blank). The brokered
    // token's actual scopes are governed by the Okta GitHub Resource Connection.
    scopes: process.env.GITHUB_SCOPES || undefined,
  },

  // T3 of the STS flow — read or create pull requests with the brokered token.
  github: {
    apiBaseUrl: process.env.GITHUB_API_BASE_URL || 'https://api.github.com',
    owner: process.env.GITHUB_OWNER,
    repo: process.env.GITHUB_REPO,
    // Used by the "create a pull request" action.
    base: process.env.GITHUB_PR_BASE || 'main',
    head: process.env.GITHUB_PR_HEAD,
    title: process.env.GITHUB_PR_TITLE || 'Automated PR via Okta AI Agent',
    body: process.env.GITHUB_PR_BODY || 'Opened by the AI agent using an Okta STS-brokered GitHub token.',
  },

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

  // MCP broker flow (GitHub) — same STS mechanics as the GitHub/Azure STS flows,
  // but the brokered token is used to speak MCP (JSON-RPC) to a GitHub MCP server.
  mcpGithub: {
    tokenUrl: ORG_TOKEN_URL,
    revokeUrl: ORG_REVOKE_URL,
    assertionAudience: ORG_TOKEN_URL,
    revokeAssertionAudience: process.env.STS_REVOKE_AUDIENCE || ORG_REVOKE_URL,
    resource: process.env.MCP_GITHUB_RESOURCE,
    // Optional 'scope' on the STS token-exchange (omitted if blank). The brokered
    // token's actual scopes are governed by the Okta MCP-server connection.
    scopes: process.env.MCP_GITHUB_SCOPES || undefined,
    // Base URL registered in Okta Directory → MCP Servers.
    url: process.env.MCP_GITHUB_URL,
  },

  // Secrets flow (T2) — vaulted-secret token exchange at the org token endpoint.
  secrets: {
    tokenUrl: ORG_TOKEN_URL,
    assertionAudience: ORG_TOKEN_URL,
    resource: process.env.SECRETS_RESOURCE,
  },

  // Service Account flow (T2) — service-account token exchange at the org token endpoint.
  serviceAccount: {
    tokenUrl: ORG_TOKEN_URL,
    assertionAudience: ORG_TOKEN_URL,
    resource: process.env.SERVICE_ACCOUNT_RESOURCE,
  },

  // T3 of the Secrets / Service Account flows authenticates to the MCP with HTTP
  // Basic. These are the credentials the MCP validates the presented creds against.
  mcpBasic: {
    username: process.env.MCP_BASIC_USERNAME,
    password: process.env.MCP_BASIC_PASSWORD,
  },
};

export function validateConfig() {
  const missing = REQUIRED.filter((k) => !process.env[k] || String(process.env[k]).trim() === '');
  if (missing.length) {
    console.error('\n❌ Missing required environment variables:\n');
    missing.forEach((k) => console.error(`   - ${k}`));
    console.error('\nCopy .env.example to .env and fill in your Okta values.\n');
    process.exit(1);
  }
}
