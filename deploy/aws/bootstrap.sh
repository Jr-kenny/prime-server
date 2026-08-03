#!/usr/bin/env bash
set -Eeuo pipefail

exec > >(tee -a /var/log/prime-server-bootstrap.log | logger -t prime-server-bootstrap) 2>&1

readonly REGION="__AWS_REGION__"
readonly CONFIG_PARAM="__CONFIG_PARAM__"
readonly IDENTITIES_PARAM="__IDENTITIES_PARAM__"
readonly IMAGE_URI="__IMAGE_URI__"
readonly IMAGE_TAG="__IMAGE_TAG__"
readonly LOG_GROUP="__LOG_GROUP__"
readonly DATA_ROOT="/var/lib/prime-server/providers"
readonly RUNTIME_ROOT="/var/lib/prime-server"
readonly CONFIG_FILE="/opt/prime-server/.env"

dnf install -y docker jq curl
systemctl enable --now docker

install -d -m 0750 /opt/prime-server "$RUNTIME_ROOT" "$DATA_ROOT"

aws ssm get-parameter \
  --name "$CONFIG_PARAM" \
  --with-decryption \
  --query 'Parameter.Value' \
  --output text > "$CONFIG_FILE"
chown 10001:10001 "$CONFIG_FILE"
chmod 0600 "$CONFIG_FILE"

identity_bundle="$(mktemp)"
trap 'rm -f "$identity_bundle"' EXIT
aws ssm get-parameter \
  --name "$IDENTITIES_PARAM" \
  --with-decryption \
  --query 'Parameter.Value' \
  --output text > "$identity_bundle"

for provider_number in 1 2 3 4; do
  provider_id="provider-${provider_number}"
  provider_dir="$DATA_ROOT/$provider_id"
  install -d -m 0700 "$provider_dir"
  jq -e --arg provider_id "$provider_id" '.[$provider_id]' "$identity_bundle" > "$provider_dir/identity.json"
  chown -R 10001:10001 "$provider_dir"
  chmod 0600 "$provider_dir/identity.json"
done

aws ecr get-login-password --region "$REGION" | docker login \
  --username AWS \
  --password-stdin "$(printf '%s' "$IMAGE_URI" | cut -d/ -f1)"

docker pull "$IMAGE_URI:$IMAGE_TAG"
docker rm -f prime-server 2>/dev/null || true

docker run -d \
  --name prime-server \
  --restart unless-stopped \
  --publish 8080:8080 \
  --volume "$CONFIG_FILE:/opt/prime-server/.env:ro" \
  --volume "$RUNTIME_ROOT:$RUNTIME_ROOT" \
  --log-driver=awslogs \
  --log-opt "awslogs-region=$REGION" \
  --log-opt "awslogs-group=$LOG_GROUP" \
  --log-opt 'awslogs-stream=prime-server-node' \
  --env "PRIME_SERVER_DATA_ROOT=$DATA_ROOT" \
  --env "PRIME_SERVER_OPERATIONAL_STATE_PATH=$RUNTIME_ROOT/operational-state.json" \
  "$IMAGE_URI:$IMAGE_TAG"

docker image inspect "$IMAGE_URI:$IMAGE_TAG" --format '{{.Id}}' > "$RUNTIME_ROOT/image-id"
chown 10001:10001 "$RUNTIME_ROOT/image-id"
chmod 0600 "$RUNTIME_ROOT/image-id"

echo '{"event":"prime_server_bootstrap_complete"}'
