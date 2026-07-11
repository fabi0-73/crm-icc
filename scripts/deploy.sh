#!/usr/bin/env bash
# Deploy the committed state (git HEAD) to the VPS.
#
# Usage (Git Bash):
#   ICC_SSH_PASS='...' scripts/deploy.sh          # password auth via PuTTY tools
#   ICC_SSH_KEY=~/.ssh/icc_vps_ed25519 scripts/deploy.sh   # key auth via OpenSSH
#
# The server's .env.local is never touched (it is not in the archive).
set -euo pipefail

HOST="${ICC_HOST:-72.62.42.52}"
USER="${ICC_USER:-root}"
APP_DIR="/srv/apps/crm-icc"
SERVICE="crm-icc"
BUNDLE="deploy-bundle.tgz"

cd "$(git rev-parse --show-toplevel)"

if ! git diff --quiet HEAD -- . ':!*.md'; then
  echo "warning: uncommitted changes are NOT deployed (git archive uses HEAD)" >&2
fi

git archive --format=tar.gz -o "$BUNDLE" HEAD
echo "bundle: $(du -h "$BUNDLE" | cut -f1)"

if [ -n "${ICC_SSH_KEY:-}" ]; then
  SCP=(scp -i "$ICC_SSH_KEY" -o BatchMode=yes)
  SSH=(ssh -i "$ICC_SSH_KEY" -o BatchMode=yes)
elif [ -n "${ICC_SSH_PASS:-}" ]; then
  SCP=("/c/Program Files/PuTTY/pscp.exe" -batch -pw "$ICC_SSH_PASS")
  SSH=("/c/Program Files/PuTTY/plink.exe" -batch -ssh -pw "$ICC_SSH_PASS")
else
  echo "error: set ICC_SSH_KEY or ICC_SSH_PASS" >&2
  exit 1
fi

"${SCP[@]}" "$BUNDLE" "$USER@$HOST:/tmp/$BUNDLE"

"${SSH[@]}" "$USER@$HOST" "
  set -e
  cd $APP_DIR
  # remove code dirs so deleted files don't linger; env/node_modules survive
  rm -rf src supabase scripts docs public ops
  tar xzf /tmp/$BUNDLE -C $APP_DIR
  rm -f /tmp/$BUNDLE
  npm ci --no-audit --no-fund 2>&1 | tail -1
  npx next build 2>&1 | tail -5
  # keep files owned by the service user once it exists (Step 6 hardening)
  id -u crmicc >/dev/null 2>&1 && chown -R crmicc: $APP_DIR
  systemctl restart $SERVICE
  sleep 3
  code=\$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3010/)
  echo \"health: HTTP \$code\"
  [ \"\$code\" = 307 ] || [ \"\$code\" = 200 ] || { echo 'DEPLOY FAILED health check'; exit 1; }
"

rm -f "$BUNDLE"
echo "deployed $(git rev-parse --short HEAD) to $HOST"
