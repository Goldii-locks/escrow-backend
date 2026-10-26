#!/usr/bin/env bash
# /opt/escrow/deploy.sh — invoked by SSM from GitHub Actions.
# Usage: deploy.sh <backend|frontend> <image-tag>

set -euo pipefail

SERVICE="${1:?usage: deploy.sh <backend|frontend> <tag>}"
TAG="${2:?usage: deploy.sh <backend|frontend> <tag>}"

cd /opt/escrow
# shellcheck disable=SC1091
source /opt/escrow/deploy.env     # AWS_REGION, ECR_REGISTRY

case "$SERVICE" in
  backend)  KEY=BACKEND_TAG  ;;
  frontend) KEY=FRONTEND_TAG ;;
  *) echo "unknown service: ${SERVICE}" >&2; exit 2 ;;
esac

echo "==> deploying ${SERVICE}:${TAG}"

PREVIOUS=$(grep "^${KEY}=" .env 2>/dev/null | cut -d= -f2 || true)
echo "previous ${KEY}=${PREVIOUS:-<none>}"

touch .env
if grep -q "^${KEY}=" .env; then
  sed -i "s|^${KEY}=.*|${KEY}=${TAG}|" .env
else
  echo "${KEY}=${TAG}" >> .env
fi
grep -q "^ECR_REGISTRY=" .env || echo "ECR_REGISTRY=${ECR_REGISTRY}" >> .env

aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$ECR_REGISTRY"

docker compose pull "$SERVICE"
docker compose up -d --remove-orphans

# ── Health check (Issue 3) ──────────────────────────────────────────────────
#
# The old probe used `curl /healthz`, which nginx answers directly.  That let
# a backend container that crashed on boot pass the health check because nginx
# was still up.  The fix uses two complementary checks for the backend:
#
#   1. Poll `docker compose ps` until the container's own HEALTHCHECK reports
#      "healthy" (the Compose healthcheck hits 127.0.0.1:3001/health inside
#      the container network, bypassing nginx entirely).
#
#   2. Probe /health through nginx to confirm end-to-end connectivity.
#
# For the frontend service the original /healthz probe is sufficient (nginx
# serving static assets does not have a separate backend container to verify).
#
# Both paths trigger the rollback on failure and exit non-zero.

rollback() {
  echo "!! health check failed for ${SERVICE}:${TAG}" >&2
  echo "!! last 40 lines of ${SERVICE} logs:" >&2
  docker compose logs --tail=40 "${SERVICE}" >&2
  if [ -n "${PREVIOUS:-}" ]; then
    echo "!! rolling back to ${PREVIOUS}" >&2
    sed -i "s|^${KEY}=.*|${KEY}=${PREVIOUS}|" .env
    docker compose up -d
  fi
  exit 1
}

if [ "${SERVICE}" = "backend" ]; then
  # ── Step 1: wait for the container HEALTHCHECK to report "healthy" ──────
  echo "==> waiting for backend container to become healthy"
  HEALTH="starting"
  for i in $(seq 1 30); do
    # `docker compose ps --format json` emits one JSON object per service.
    # Extract the Health field with python3 (available on every EC2 AMI).
    HEALTH=$(docker compose ps --format json "${SERVICE}" 2>/dev/null \
      | python3 -c \
          "import sys, json; data=sys.stdin.read().strip()
lines=[l for l in data.splitlines() if l.strip()]
obj=json.loads(lines[-1]) if lines else {}
print(obj.get('Health', ''))" 2>/dev/null \
      || echo "")
    echo "  attempt ${i}/30: Health=${HEALTH:-unknown}"
    if [ "${HEALTH}" = "healthy" ]; then
      break
    fi
    sleep 3
  done

  if [ "${HEALTH}" != "healthy" ]; then
    echo "!! container did not reach healthy state (last: ${HEALTH:-unknown})" >&2
    rollback
  fi

  # ── Step 2: probe /health through nginx for end-to-end confirmation ─────
  echo "==> probing /health through nginx"
  NGINX_OK=0
  for i in $(seq 1 12); do
    # Port 80 only answers /healthz and 301s everything else to HTTPS, so
    # probe the TLS server; --resolve keeps SNI and the certificate valid.
    RESPONSE=$(curl -sS --max-time 5 --resolve milestonepay.app:443:127.0.0.1 \
      https://milestonepay.app/health 2>/dev/null || true)
    if echo "${RESPONSE}" | grep -q '"status":"ok"'; then
      echo "  /health OK"
      NGINX_OK=1
      break
    fi
    echo "  attempt ${i}/12: waiting for /health  response=${RESPONSE}"
    sleep 5
  done

  if [ "${NGINX_OK}" -ne 1 ]; then
    echo '!! /health did not return {"status":"ok"} within 60 s' >&2
    rollback
  fi

else
  # ── Frontend: nginx healthz is sufficient ────────────────────────────────
  echo "==> waiting for nginx /healthz"
  NGINX_OK=0
  for i in $(seq 1 12); do
    if curl -fsS --max-time 5 http://127.0.0.1/healthz >/dev/null 2>&1; then
      echo "  /healthz OK"
      NGINX_OK=1
      break
    fi
    echo "  attempt ${i}/12: waiting for /healthz"; sleep 5
  done

  if [ "${NGINX_OK}" -ne 1 ]; then
    echo "!! /healthz did not respond within 60 s" >&2
    rollback
  fi
fi

docker image prune -f >/dev/null
echo "==> ${SERVICE}:${TAG} deployed successfully"
