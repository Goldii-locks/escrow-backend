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

echo "==> waiting for containers to settle"
sleep 8
docker compose ps

if ! curl -fsS --max-time 5 http://127.0.0.1/healthz >/dev/null; then
  echo "!! healthz failed after deploying ${SERVICE}:${TAG}" >&2
  echo "!! last 40 lines:" >&2
  docker compose logs --tail=40 "$SERVICE" >&2
  if [ -n "${PREVIOUS:-}" ]; then
    echo "!! rolling back to ${PREVIOUS}" >&2
    sed -i "s|^${KEY}=.*|${KEY}=${PREVIOUS}|" .env
    docker compose up -d
  fi
  exit 1
fi

docker image prune -f >/dev/null
echo "==> ${SERVICE}:${TAG} deployed"
