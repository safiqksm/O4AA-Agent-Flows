#!/usr/bin/env bash
# One-command Azure deploy: resource group -> Bicep infra -> Key Vault secrets ->
# app settings -> GitHub OIDC (Entra app + federated credential + role assignment).
# Safe to re-run: every step checks current state before creating anything.
#
# Usage:
#   ./scripts/azure-deploy.sh                # infra + secrets + settings + OIDC
#   ./scripts/azure-deploy.sh --with-code     # also zip-deploys the app immediately
#
# Required locally: az CLI (logged in), keys/agent.pem, keys/service.pem, .env
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

SUBSCRIPTION_ID="${SUBSCRIPTION_ID:-7e86c522-de98-4ca6-b435-5bf823da37f8}"
RESOURCE_GROUP="${RESOURCE_GROUP:-rg-o4aa-agent-flows}"
RG_LOCATION="${RG_LOCATION:-eastus}"        # only used if the group doesn't exist yet
RESOURCE_LOCATION="${RESOURCE_LOCATION:-centralus}"  # passed to Bicep for the actual resources
BASE_NAME="${BASE_NAME:-o4aa-agent-flows}"
PLAN_SKU="${PLAN_SKU:-B1}"

OIDC_APP_NAME="${OIDC_APP_NAME:-gh-oidc-${BASE_NAME}}"
GITHUB_OWNER="${GITHUB_OWNER:-safiqksm}"
GITHUB_REPO="${GITHUB_REPO:-O4AA-Agent-Flows}"
GITHUB_BRANCH="${GITHUB_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"

WITH_CODE=0
[[ "${1:-}" == "--with-code" ]] && WITH_CODE=1

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

log "Checking az CLI login"
az account show >/dev/null 2>&1 || { echo "Run 'az login' first."; exit 1; }
az account set --subscription "$SUBSCRIPTION_ID"

[[ -f keys/agent.pem ]] || { echo "Missing keys/agent.pem — generate with scripts/agent-key.mjs."; exit 1; }
[[ -f keys/service.pem ]] || { echo "Missing keys/service.pem."; exit 1; }
[[ -f .env ]] || { echo "Missing .env — copy .env.example first."; exit 1; }

log "Resource group: $RESOURCE_GROUP"
if ! az group show -n "$RESOURCE_GROUP" >/dev/null 2>&1; then
  az group create -n "$RESOURCE_GROUP" -l "$RG_LOCATION" -o none
  echo "created"
else
  echo "already exists"
fi

log "Deploying infra/main.bicep (plan=$PLAN_SKU, region=$RESOURCE_LOCATION)"
DEPLOY_OUT=$(az deployment group create \
  -g "$RESOURCE_GROUP" \
  -f infra/main.bicep \
  --parameters baseName="$BASE_NAME" location="$RESOURCE_LOCATION" planSkuName="$PLAN_SKU" \
  -o json)

WEBAPP_NAME=$(echo "$DEPLOY_OUT" | grep -o '"webAppName": *{[^}]*"value": *"[^"]*"' | grep -o '"value": *"[^"]*"' | sed 's/.*"value": *"\(.*\)"/\1/')
KEYVAULT_NAME=$(echo "$DEPLOY_OUT" | grep -o '"keyVaultName": *{[^}]*"value": *"[^"]*"' | grep -o '"value": *"[^"]*"' | sed 's/.*"value": *"\(.*\)"/\1/')
echo "Web App:   $WEBAPP_NAME"
echo "Key Vault: $KEYVAULT_NAME"

env_get() { grep -E "^${1}=" .env | head -1 | cut -d= -f2- ; }

log "Seeding Key Vault secrets (values never printed)"
set_secret() {
  local name="$1" value="$2"
  if [[ -z "$value" ]]; then echo "  skip $name (empty in .env)"; return; fi
  az keyvault secret set --vault-name "$KEYVAULT_NAME" --name "$name" --value "$value" -o none
  echo "  set $name"
}
set_secret "SESSION-SECRET" "$(env_get SESSION_SECRET)"
set_secret "OKTA-CLIENT-SECRET" "$(env_get OKTA_CLIENT_SECRET)"
set_secret "MCP-BASIC-PASSWORD" "$(env_get MCP_BASIC_PASSWORD)"
az keyvault secret set --vault-name "$KEYVAULT_NAME" --name "AGENT-PRIVATE-KEY" --file keys/agent.pem -o none
echo "  set AGENT-PRIVATE-KEY (from keys/agent.pem)"
az keyvault secret set --vault-name "$KEYVAULT_NAME" --name "SERVICE-PRIVATE-KEY" --file keys/service.pem -o none
echo "  set SERVICE-PRIVATE-KEY (from keys/service.pem)"

log "Pushing plain app settings from .env"
# Bicep already owns: PORT-independent runtime, APP_BASE_URL, OKTA_REDIRECT_URI, and
# every value above that goes to Key Vault instead. Everything else in .env is a plain
# (non-secret) app setting the app needs at runtime.
EXCLUDE='^(PORT|APP_BASE_URL|OKTA_REDIRECT_URI|SESSION_SECRET|OKTA_CLIENT_SECRET|AGENT_PRIVATE_KEY|AGENT_PRIVATE_KEY_FILE|SERVICE_PRIVATE_KEY|SERVICE_PRIVATE_KEY_FILE|MCP_BASIC_PASSWORD|NODE_ENV)$'
settings=()
while IFS='=' read -r key value; do
  [[ -z "$key" || "$key" == \#* ]] && continue
  [[ "$key" =~ $EXCLUDE ]] && continue
  [[ -z "$value" ]] && continue
  settings+=("${key}=${value}")
done < <(grep -E '^[A-Z0-9_]+=' .env)

if [[ ${#settings[@]} -gt 0 ]]; then
  az webapp config appsettings set -g "$RESOURCE_GROUP" -n "$WEBAPP_NAME" --settings "${settings[@]}" -o none
  echo "  pushed ${#settings[@]} settings"
else
  echo "  nothing to push"
fi

log "GitHub OIDC (Entra app + federated credential + role assignment)"
APP_ID=$(az ad app list --display-name "$OIDC_APP_NAME" --query "[0].appId" -o tsv)
if [[ -z "$APP_ID" ]]; then
  APP_ID=$(az ad app create --display-name "$OIDC_APP_NAME" --query appId -o tsv)
  az ad sp create --id "$APP_ID" -o none
  echo "  created Entra app $APP_ID"
else
  echo "  Entra app already exists: $APP_ID"
fi

FED_SUBJECT="repo:${GITHUB_OWNER}/${GITHUB_REPO}:ref:refs/heads/${GITHUB_BRANCH}"
FED_NAME="github-actions-${GITHUB_BRANCH}"
if ! az ad app federated-credential list --id "$APP_ID" --query "[?subject=='${FED_SUBJECT}']" -o tsv | grep -q .; then
  az ad app federated-credential create --id "$APP_ID" --parameters "{
    \"name\": \"${FED_NAME}\",
    \"issuer\": \"https://token.actions.githubusercontent.com\",
    \"subject\": \"${FED_SUBJECT}\",
    \"audiences\": [\"api://AzureADTokenExchange\"]
  }" -o none
  echo "  created federated credential for $FED_SUBJECT"
else
  echo "  federated credential already trusts $FED_SUBJECT"
fi

SP_OBJECT_ID=$(az ad sp show --id "$APP_ID" --query id -o tsv)
WEBAPP_ID=$(az webapp show -g "$RESOURCE_GROUP" -n "$WEBAPP_NAME" --query id -o tsv)
if ! az role assignment list --assignee-object-id "$SP_OBJECT_ID" --scope "$WEBAPP_ID" --query "[?roleDefinitionName=='Website Contributor']" -o tsv | grep -q .; then
  az role assignment create --assignee-object-id "$SP_OBJECT_ID" --assignee-principal-type ServicePrincipal \
    --role "Website Contributor" --scope "$WEBAPP_ID" -o none
  echo "  granted Website Contributor on $WEBAPP_NAME"
else
  echo "  Website Contributor role already assigned"
fi

TENANT_ID=$(az account show --query tenantId -o tsv)

if [[ $WITH_CODE -eq 1 ]]; then
  log "Building and zip-deploying app code"
  npm ci --omit=dev
  npm --prefix client ci
  npm --prefix client run build
  rm -rf /tmp/o4aa-deploy && mkdir -p /tmp/o4aa-deploy/client
  cp -r server node_modules package.json package-lock.json /tmp/o4aa-deploy/
  cp -r client/dist /tmp/o4aa-deploy/client/dist
  (cd /tmp/o4aa-deploy && zip -qr /tmp/o4aa-release.zip .)
  az webapp deploy -g "$RESOURCE_GROUP" -n "$WEBAPP_NAME" --src-path /tmp/o4aa-release.zip --type zip -o none
  rm -rf /tmp/o4aa-deploy /tmp/o4aa-release.zip
  echo "  deployed"
fi

log "Done"
cat <<EOF
Web App:      https://${WEBAPP_NAME}.azurewebsites.net
Key Vault:    $KEYVAULT_NAME

If these GitHub repo variables (Settings -> Secrets and variables -> Actions -> Variables)
aren't set yet for pushes to trigger deploys, set them now:
  AZURE_CLIENT_ID       = $APP_ID
  AZURE_TENANT_ID       = $TENANT_ID
  AZURE_SUBSCRIPTION_ID = $SUBSCRIPTION_ID
  AZURE_WEBAPP_NAME     = $WEBAPP_NAME

Also confirm the Okta redirect URI is registered:
  https://${WEBAPP_NAME}.azurewebsites.net/api/callback
EOF
