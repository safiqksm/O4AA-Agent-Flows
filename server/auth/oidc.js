import { Router } from 'express';
import { Issuer, generators } from 'openid-client';
import { config } from '../config.js';
import { decodeJwt } from '../util/jwt.js';

let client = null;

/** Discover the Okta issuer and build the OIDC client once at startup. */
export async function initOidc() {
  const issuer = await Issuer.discover(config.okta.issuer);
  client = new issuer.Client({
    client_id: config.okta.clientId,
    client_secret: config.okta.clientSecret,
    redirect_uris: [config.okta.redirectUri],
    response_types: ['code'],
  });
  console.log(`✓ OIDC client ready (issuer: ${issuer.metadata.issuer})`);
}

/**
 * Build the captured T1 "User Login" step from the token set returned by Okta,
 * surfacing the decoded user access token for the UI.
 */
function buildLoginStep(tokenSet) {
  const tokenUrl = `${config.okta.issuer.replace(/\/$/, '')}/v1/token`;
  return {
    id: 'T1',
    title: 'User Login',
    badge: 'Access Token',
    from: 'User',
    to: 'IdP',
    ok: true,
    request: {
      method: 'POST',
      url: tokenUrl,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: [
        'grant_type=authorization_code',
        'code=<authorization_code>',
        `client_id=${config.okta.clientId}`,
        `redirect_uri=${config.okta.redirectUri}`,
        'code_verifier=<pkce_verifier>',
      ].join('&'),
    },
    response: {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: {
        token_type: tokenSet.token_type,
        expires_in: tokenSet.expires_in,
        scope: tokenSet.scope,
        access_token: tokenSet.access_token,
        id_token: tokenSet.id_token,
      },
    },
    // Show the user access token in the Token tab (fall back to id_token if access token is opaque).
    token: decodeJwt(tokenSet.access_token) || decodeJwt(tokenSet.id_token),
    code: `curl -X POST '${tokenUrl}' \\\n  -H 'Content-Type: application/x-www-form-urlencoded' \\\n  -d 'grant_type=authorization_code&code=<code>&redirect_uri=${config.okta.redirectUri}&code_verifier=<verifier>'`,
  };
}

const router = Router();

router.get('/login', (req, res, next) => {
  if (!client) return next(new Error('OIDC not initialized'));
  const code_verifier = generators.codeVerifier();
  const code_challenge = generators.codeChallenge(code_verifier);
  const state = generators.state();
  const nonce = generators.nonce();
  req.session.pkce = { code_verifier, state, nonce };

  const url = client.authorizationUrl({
    scope: config.okta.scopes,
    code_challenge,
    code_challenge_method: 'S256',
    state,
    nonce,
  });
  res.redirect(url);
});

router.get('/callback', async (req, res, next) => {
  try {
    if (!client) return next(new Error('OIDC not initialized'));
    const { pkce } = req.session;
    if (!pkce) return res.redirect(`${config.appBaseUrl}/?auth=error`);

    const params = client.callbackParams(req);
    const tokenSet = await client.callback(config.okta.redirectUri, params, {
      code_verifier: pkce.code_verifier,
      state: pkce.state,
      nonce: pkce.nonce,
    });

    const claims = tokenSet.claims();
    req.session.user = {
      sub: claims.sub,
      name: claims.name,
      email: claims.email,
    };
    req.session.idToken = tokenSet.id_token;
    req.session.loginStep = buildLoginStep(tokenSet);
    delete req.session.pkce;

    res.redirect(`${config.appBaseUrl}/?auth=success`);
  } catch (err) {
    console.error('OIDC callback error:', err);
    res.redirect(`${config.appBaseUrl}/?auth=error`);
  }
});

router.get('/me', (req, res) => {
  if (req.session.user) {
    res.json({
      authenticated: true,
      user: req.session.user,
      loginStep: req.session.loginStep || null,
    });
  } else {
    res.json({ authenticated: false });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

export default router;
