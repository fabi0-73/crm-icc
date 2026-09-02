#!/bin/bash
# Writes /srv/supabase/.env with real values. Run once, on the server.
#
# ANON_KEY and SERVICE_ROLE_KEY are not random strings: they are HS256
# JWTs signed with JWT_SECRET. A random value here starts fine and then
# 401s every request, so this script signs them and verifies them.
set -euo pipefail

STACK=${STACK:-/srv/supabase}
cd "$STACK"
[ -f .env ] && { echo "refusing to overwrite existing $STACK/.env"; exit 1; }
[ -f .env.example ] || { echo "missing $STACK/.env.example"; exit 1; }

JWT_SECRET=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 24)
SECRET_KEY_BASE=$(openssl rand -hex 32)
VAULT_ENC_KEY=$(openssl rand -hex 16)

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

mkjwt() {
  local role="$1" now exp header payload sig
  now=$(date +%s)
  exp=$((now + 315360000))   # 10 years
  header=$(printf '{"alg":"HS256","typ":"JWT"}' | b64url)
  payload=$(printf '{"iss":"supabase","role":"%s","iat":%s,"exp":%s}' "$role" "$now" "$exp" | b64url)
  sig=$(printf '%s.%s' "$header" "$payload" \
        | openssl dgst -sha256 -mac HMAC -macopt "hexkey:$(printf '%s' "$JWT_SECRET" | od -An -tx1 | tr -d ' \n')" -binary \
        | b64url)
  printf '%s.%s.%s' "$header" "$payload" "$sig"
}

ANON_KEY=$(mkjwt anon)
SERVICE_ROLE_KEY=$(mkjwt service_role)

sed -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$POSTGRES_PASSWORD|" \
    -e "s|^JWT_SECRET=.*|JWT_SECRET=$JWT_SECRET|" \
    -e "s|^ANON_KEY=.*|ANON_KEY=$ANON_KEY|" \
    -e "s|^SERVICE_ROLE_KEY=.*|SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY|" \
    -e "s|^SECRET_KEY_BASE=.*|SECRET_KEY_BASE=$SECRET_KEY_BASE|" \
    -e "s|^VAULT_ENC_KEY=.*|VAULT_ENC_KEY=$VAULT_ENC_KEY|" \
    .env.example > .env
chmod 600 .env
chown root:root .env

# Prove the keys verify against the secret before anything depends on them.
python3 - <<'PY'
import base64, hmac, hashlib, json, os, sys
env = {}
for line in open('/srv/supabase/.env'):
    if '=' in line and not line.startswith('#'):
        k, v = line.rstrip('\n').split('=', 1)
        env[k] = v
def check(name):
    tok = env[name]
    h, p, s = tok.split('.')
    expect = base64.urlsafe_b64encode(
        hmac.new(env['JWT_SECRET'].encode(), f"{h}.{p}".encode(), hashlib.sha256).digest()
    ).rstrip(b'=').decode()
    payload = json.loads(base64.urlsafe_b64decode(p + '=' * ((4 - len(p) % 4) % 4)))
    ok = hmac.compare_digest(s, expect)
    print(f"{name}: signature {'OK' if ok else 'BAD'}, role={payload.get('role')}")
    return ok
if not (check('ANON_KEY') and check('SERVICE_ROLE_KEY')):
    sys.exit("keys do not verify — do not start the stack")
PY

echo "wrote $STACK/.env (chmod 600)"
