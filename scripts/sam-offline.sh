#!/usr/bin/env bash
set -euo pipefail
# Local validation only: ignore unavailable inherited account profiles without
# changing the caller's deployment configuration or using real account credentials.
case "${1:-}" in
  validate|build) ;;
  *) echo 'Usage: bash scripts/sam-offline.sh validate|build' >&2; exit 2 ;;
esac
sam_tmp=$(mktemp -d)
trap 'rm -rf "$sam_tmp"' EXIT
touch "$sam_tmp/config" "$sam_tmp/credentials"
env -u AWS_PROFILE -u AWS_DEFAULT_PROFILE \
  -u AWS_ROLE_ARN -u AWS_WEB_IDENTITY_TOKEN_FILE -u AWS_SESSION_TOKEN \
  -u AWS_CONTAINER_CREDENTIALS_FULL_URI -u AWS_CONTAINER_CREDENTIALS_RELATIVE_URI \
  AWS_CONFIG_FILE="$sam_tmp/config" AWS_SHARED_CREDENTIALS_FILE="$sam_tmp/credentials" \
  AWS_ACCESS_KEY_ID=localonly AWS_SECRET_ACCESS_KEY=localonly \
  AWS_EC2_METADATA_DISABLED=true AWS_DEFAULT_REGION=us-east-1 AWS_REGION=us-east-1 \
  SAM_CLI_TELEMETRY=0 __SAM_CLI_APP_DIR="$sam_tmp/sam" \
  sam "$@"
