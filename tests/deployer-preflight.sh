#!/usr/bin/env bash
set -eu
script="$(cd "$(dirname "$0")/.." && pwd)/scripts/ops/deployer-preflight.sh"
: "${TEST_DATABASE_URL:?Set TEST_DATABASE_URL to a dedicated test database}"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cd "$tmp"

docker() {
  local query="${!#}"
  psql -XAtq "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -v selected="$SELECTED" -v enabled="$EPAY_ENABLED" <<SQL
    WITH settings(id, body) AS (VALUES (1, jsonb_build_object(
      'supportEmail', 'support@example.com', 'alipay', true, 'wechat', false,
      'crypto', false, 'fiatProvider', :'selected'))),
    integrations(provider, active, enabled, public) AS (VALUES
      ('xorpay', true, false, '{}'::jsonb), ('epay_v1', true, :'enabled'::boolean, '{}'::jsonb))
    $query
SQL
}
curl() { LC_ALL=C date -u '+date: %a, %d %b %Y %T GMT'; }
export -f docker curl
export ENCRYPTION_KEY=test-key APP_URL=https://1.1.1.1 SELECTED=xorpay EPAY_ENABLED=false

check() {
  local expected=$1 message=$2 status=0
  bash "$script" --deploy "${3:-bare}" > output || status=$?
  if [ "$status" != "$expected" ] || ! grep -Fq "$message" output; then
    cat output >&2
    exit 1
  fi
}

unset APP_MODE
check 0 'WARN  settings.alipay/wechat'
check 1 'FAIL  settings.alipay/wechat' container
printf 'APP_MODE="live" # production\n' > .env
check 1 'FAIL  settings.alipay/wechat'
APP_MODE=demo check 0 'WARN  settings.alipay/wechat'
export EPAY_ENABLED=true
check 1 'FAIL  settings.alipay/wechat'
SELECTED=epay_v1 check 0 'PASS  支付宝/微信'
SELECTED=unsupported check 1 'FAIL  settings.fiatProvider'
APP_MODE=invalid check 1 'FAIL  无法识别 APP_MODE'
