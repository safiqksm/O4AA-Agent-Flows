const INVENTORY_SUGGESTIONS = [
  { label: 'Get inventory details', text: 'Get inventory details' },
  { label: 'Show last 5 shipments', text: 'Show me the last 5 shipments' },
];

// The AI-agent token-exchange use cases the demo walks through.
export const FLOWS = {
  xaa: {
    id: 'xaa',
    name: 'Cross-App Access',
    tagline: 'id-JAG → access token → protected MCP',
    description:
      'Exchange the user’s ID token for an Identity Assertion Authorization Grant, then for a resource access token, and call the inventory MCP — the token is validated for signature and scope.',
    accent: '#16c784',
    suggestions: INVENTORY_SUGGESTIONS,
  },
  secrets: {
    id: 'secrets',
    name: 'Secrets',
    tagline: 'Vaulted secret → Basic auth',
    description:
      'Exchange the user’s ID token for a vaulted secret from Okta Privileged Access, then call the inventory MCP using HTTP Basic authentication with the retrieved credentials.',
    accent: '#3b82f6',
    suggestions: INVENTORY_SUGGESTIONS,
  },
  'service-account': {
    id: 'service-account',
    name: 'Service Accounts',
    tagline: 'Service account → Basic auth',
    description:
      'Exchange the user’s ID token for a service account username/password, then call the inventory MCP using HTTP Basic authentication with those credentials.',
    accent: '#a855f7',
    suggestions: INVENTORY_SUGGESTIONS,
  },
  'client-credentials': {
    id: 'client-credentials',
    name: 'NHI - Cross-App Access',
    tagline: 'client_credentials → id-JAG → access token',
    description:
      'A headless service app authenticates with private_key_jwt (client_credentials), then exchanges its service token for an id-JAG and a resource access token — like Cross-App Access, but with a service identity instead of a user.',
    accent: '#f59e0b',
    // No user-login step in the sequence — this flow uses a service identity.
    prependLogin: false,
    suggestions: INVENTORY_SUGGESTIONS,
  },
  'sts-github': {
    id: 'sts-github',
    name: 'STS Broker (GitHub)',
    tagline: 'token-exchange → GitHub token → read PRs',
    description:
      'Exchange the user’s ID token for a GitHub access token brokered by Okta. If consent is needed, Okta returns interaction_required — authorize, then retry — and the agent reads the repository’s pull requests with the brokered token.',
    accent: '#6e40c9',
    suggestions: [
      { label: 'Read pull requests', text: 'Read pull requests' },
      { label: 'Create a pull request', text: 'Create a pull request' },
    ],
  },
};

export const FLOW_LIST = Object.values(FLOWS);
