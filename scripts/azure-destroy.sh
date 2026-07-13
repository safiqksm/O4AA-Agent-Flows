#!/usr/bin/env bash
# One-command teardown of everything scripts/azure-deploy.sh created:
# the resource group (Web App, Plan, Key Vault) AND the GitHub OIDC Entra app
# (which lives outside the resource group, so `az group delete` alone won't remove it).
#
# Usage:
#   ./scripts/azure-destroy.sh          # asks you to type the resource group name to confirm
#   ./scripts/azure-destroy.sh --yes    # no prompt (CI / non-interactive use)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

SUBSCRIPTION_ID="${SUBSCRIPTION_ID:-7e86c522-de98-4ca6-b435-5bf823da37f8}"
RESOURCE_GROUP="${RESOURCE_GROUP:-rg-o4aa-agent-flows}"
RESOURCE_LOCATION="${RESOURCE_LOCATION:-centralus}"  # where the Key Vault actually lives, for purge
BASE_NAME="${BASE_NAME:-o4aa-agent-flows}"
OIDC_APP_NAME="${OIDC_APP_NAME:-gh-oidc-${BASE_NAME}}"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

az account show >/dev/null 2>&1 || { echo "Run 'az login' first."; exit 1; }
az account set --subscription "$SUBSCRIPTION_ID"

if ! az group show -n "$RESOURCE_GROUP" >/dev/null 2>&1; then
  echo "Resource group '$RESOURCE_GROUP' doesn't exist — nothing to delete there."
  RG_EXISTS=0
else
  RG_EXISTS=1
fi

if [[ "${1:-}" != "--yes" ]]; then
  echo "This permanently deletes:"
  [[ $RG_EXISTS -eq 1 ]] && echo "  - resource group '$RESOURCE_GROUP' (Web App, App Service Plan, Key Vault + all secrets)"
  echo "  - Entra app registration '$OIDC_APP_NAME' (GitHub OIDC federated credential)"
  read -rp "Type the resource group name ($RESOURCE_GROUP) to confirm: " CONFIRM
  [[ "$CONFIRM" == "$RESOURCE_GROUP" ]] || { echo "Confirmation didn't match — aborting."; exit 1; }
fi

# Grab the Key Vault name before the group (and the vault) are gone, so we can purge it after.
KEYVAULT_NAME=""
if [[ $RG_EXISTS -eq 1 ]]; then
  KEYVAULT_NAME=$(az keyvault list -g "$RESOURCE_GROUP" --query "[0].name" -o tsv)
fi

log "Deleting Entra app registration ($OIDC_APP_NAME)"
APP_ID=$(az ad app list --display-name "$OIDC_APP_NAME" --query "[0].appId" -o tsv)
if [[ -n "$APP_ID" ]]; then
  az ad app delete --id "$APP_ID"
  echo "  deleted app $APP_ID (federated credential + service principal go with it)"
else
  echo "  no app named $OIDC_APP_NAME — already gone"
fi

if [[ $RG_EXISTS -eq 1 ]]; then
  log "Deleting resource group $RESOURCE_GROUP (this can take a few minutes)"
  az group delete -n "$RESOURCE_GROUP" --yes
  echo "  deleted"

  if [[ -n "$KEYVAULT_NAME" ]]; then
    log "Purging soft-deleted Key Vault $KEYVAULT_NAME"
    # Without this, the vault stays in soft-delete for its retention window and blocks
    # reusing the same name on the next deploy.
    az keyvault purge --name "$KEYVAULT_NAME" --location "$RESOURCE_LOCATION" || \
      echo "  purge failed or already purged — check 'az keyvault list-deleted'"
  fi
fi

log "Done. Nothing in this subscription should be billing for $BASE_NAME anymore."
