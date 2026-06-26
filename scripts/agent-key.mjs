// Inspect or generate the agent signing key.
//
//   node scripts/agent-key.mjs              # READ-ONLY: print the public JWK of keys/agent.pem
//   node scripts/agent-key.mjs --generate   # generate a NEW keypair (refuses to overwrite)
//   node scripts/agent-key.mjs --generate --force   # generate and overwrite keys/agent.pem
//
// Use the printed JWK to register the public key on the agent client in Okta,
// and set AGENT_KID to the printed thumbprint.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { exportJWK, exportPKCS8, generateKeyPair, calculateJwkThumbprint } from 'jose';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY_PATH = path.resolve(__dirname, '..', 'keys', 'agent.pem');
const generate = process.argv.includes('--generate');
const force = process.argv.includes('--force');

async function printJwk(publicKeyObj, note) {
  const jwk = await exportJWK(publicKeyObj);
  const kid = await calculateJwkThumbprint(jwk);
  jwk.kid = kid;
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  console.log(`\n${note}`);
  console.log(`\n  AGENT_KID=${kid}\n`);
  console.log('Public JWK to register on the agent client in Okta:\n');
  console.log(JSON.stringify({ keys: [jwk] }, null, 2));
  console.log('');
}

if (generate) {
  if (fs.existsSync(KEY_PATH) && !force) {
    console.error(`Refusing to overwrite ${KEY_PATH}. Re-run with --force to replace it.`);
    process.exit(1);
  }
  const { publicKey, privateKey } = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
  fs.mkdirSync(path.dirname(KEY_PATH), { recursive: true });
  fs.writeFileSync(KEY_PATH, await exportPKCS8(privateKey), { mode: 0o600 });
  console.log(`✓ New private key written to ${KEY_PATH}`);
  await printJwk(publicKey, '⚠️  This is a NEW key — register it in Okta and update AGENT_KID before T2 will work.');
} else {
  if (!fs.existsSync(KEY_PATH)) {
    console.error(`No key at ${KEY_PATH}. Run with --generate to create one.`);
    process.exit(1);
  }
  const priv = crypto.createPrivateKey(fs.readFileSync(KEY_PATH, 'utf8'));
  const pub = crypto.createPublicKey(priv);
  await printJwk(pub, 'Public JWK derived from the EXISTING keys/agent.pem (read-only).');
}
