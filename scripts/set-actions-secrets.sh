#!/usr/bin/env bash
#
# Push the Tradier credentials from .env.local into GitHub Actions secrets.
#
# YOU run this, not the assistant. The value goes from your disk straight to
# GitHub over stdin — it never appears on a command line, so it never lands in
# shell history, a process list, or a log.
#
# The record-spreads workflow reads these. Until they exist it will run on
# schedule, find no key, capture nothing, and say so.
#
#   bash scripts/set-actions-secrets.sh
#
set -euo pipefail

REPO="MidnightMittt/Crypto-Dashboard"
ENV_FILE="$(dirname "$0")/../.env.local"

if ! command -v gh >/dev/null 2>&1; then
  cat <<'MSG'
gh is not installed. Either:

  brew install gh && gh auth login

or set the two secrets by hand at:

  https://github.com/MidnightMittt/Crypto-Dashboard/settings/secrets/actions

  TRADIER_API_KEY   (the value in .env.local)
  TRADIER_ENV       sandbox   — or production, if you have a live token
MSG
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "gh is installed but not authenticated. Run: gh auth login"
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "No .env.local at $ENV_FILE"
  exit 1
fi

# Read one key's value without printing it or exporting it to the environment.
read_env() {
  sed -n "s/^$1=//p" "$ENV_FILE" | head -1 | sed 's/^["'"'"']//; s/["'"'"']$//'
}

for NAME in TRADIER_API_KEY TRADIER_ENV; do
  VALUE="$(read_env "$NAME")"
  if [ -z "$VALUE" ]; then
    echo "  $NAME missing from .env.local — skipped"
    continue
  fi
  # --body is deliberately NOT used: it would put the secret in argv.
  printf '%s' "$VALUE" | gh secret set "$NAME" --repo "$REPO"
  echo "  $NAME set (${#VALUE} chars)"
done

echo
echo "Done. Confirm with:  gh secret list --repo $REPO"
echo "Then trigger a capture manually:"
echo "  gh workflow run record-spreads.yml --repo $REPO -f window=entry"
