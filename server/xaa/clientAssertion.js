import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { SignJWT } from 'jose';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Cache parsed private keys by cache key (file path, or 'env:<file path>' when
// sourced from an env var — supports the agent cert and the service cert).
const keyCache = new Map();

function parseKey(pem, source) {
  // crypto.createPrivateKey accepts PKCS#8 ("BEGIN PRIVATE KEY") and PKCS#1
  // ("BEGIN RSA PRIVATE KEY") PEMs; jose can sign with the resulting KeyObject.
  let key;
  try {
    key = crypto.createPrivateKey(pem);
  } catch (err) {
    throw new Error(`Could not parse private key from ${source}: ${err.message}`);
  }
  if (key.asymmetricKeyType !== 'rsa') {
    throw new Error(`Private key from ${source} is '${key.asymmetricKeyType}', but RS256 requires an RSA key.`);
  }
  return key;
}

// privateKey (PEM content, e.g. from Key Vault via an App Service setting) takes
// precedence over privateKeyFile, which is only used for local dev.
function loadKey({ privateKeyFile, privateKey } = {}) {
  if (privateKey) {
    const cacheKey = `env:${privateKeyFile || 'inline'}`;
    if (keyCache.has(cacheKey)) return keyCache.get(cacheKey);
    // App settings UIs often can't hold literal newlines — accept escaped \n too.
    const pem = privateKey.includes('\\n') ? privateKey.replace(/\\n/g, '\n') : privateKey;
    const key = parseKey(pem, 'env var');
    keyCache.set(cacheKey, key);
    return key;
  }

  if (!privateKeyFile) throw new Error('No private key configured.');
  if (keyCache.has(privateKeyFile)) return keyCache.get(privateKeyFile);

  const file = path.isAbsolute(privateKeyFile)
    ? privateKeyFile
    : path.resolve(__dirname, '..', '..', privateKeyFile);
  if (!fs.existsSync(file)) {
    throw new Error(`Private key not found at ${file}.`);
  }
  const pem = fs.readFileSync(file, 'utf8');
  const key = parseKey(pem, file);
  keyCache.set(privateKeyFile, key);
  return key;
}

/**
 * Build a signed private_key_jwt client assertion (RFC 7523 §2.2):
 * iss=sub=clientId, aud=the token endpoint it is sent to.
 */
export async function buildClientAssertion({ clientId, audience, kid, privateKeyFile, privateKey }) {
  const key = loadKey({ privateKeyFile, privateKey });
  const now = Math.floor(Date.now() / 1000);
  const jti = `${now}-${Math.random().toString(36).slice(2)}-xaa`;
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
    .setIssuer(clientId)
    .setSubject(clientId)
    .setAudience(audience)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .setJti(jti)
    .sign(key);
}

/** T2 — assertion for the agent client at the IdP token endpoint. */
export function buildAgentClientAssertion() {
  return buildClientAssertion({
    clientId: config.agent.clientId,
    audience: config.agent.assertionAudience,
    kid: config.agent.kid,
    privateKeyFile: config.agent.privateKeyFile,
    privateKey: config.agent.privateKey,
  });
}

/** T3 — assertion for the resource client at the resource token endpoint (same agent cert). */
export function buildResourceClientAssertion() {
  return buildClientAssertion({
    clientId: config.resource.clientId,
    audience: config.resource.assertionAudience,
    kid: config.resource.kid,
    privateKeyFile: config.agent.privateKeyFile,
    privateKey: config.agent.privateKey,
  });
}

/** Service App (client credentials) flow — assertion signed with the SERVICE cert. */
export function buildServiceClientAssertion(audience) {
  return buildClientAssertion({
    clientId: config.service.clientId,
    audience,
    kid: config.service.kid,
    privateKeyFile: config.service.privateKeyFile,
    privateKey: config.service.privateKey,
  });
}
