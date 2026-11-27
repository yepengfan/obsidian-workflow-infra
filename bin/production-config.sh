#!/usr/bin/env bash
# Run from the repository root after AWS SSO or GitHub OIDC authentication.
set -euo pipefail
umask 077
mode=${1:-all}
[[ "$mode" == all || "$mode" == storage ]]
region=${AWS_REGION:-${AWS_DEFAULT_REGION:-}}
if [[ -z "$region" ]]; then
  region=$(aws configure get region) || {
    echo 'Set a default region for the AWS profile or export AWS_REGION.' >&2
    exit 1
  }
fi
tmp=$(mktemp -d config/.production-XXXXXX)
trap 'rm -rf "$tmp"' EXIT
read_parameter() {
  aws ssm get-parameter --region "$region" --with-decryption \
    --name "/obsidian-mcp/prod/$1:1" --query Parameter.Value --output text
}
read_parameter storage > "$tmp/settings"
account=$(aws sts get-caller-identity --region "$region" --query Account --output text)
jq -e --arg account "$account" --arg region "$region" \
  '.account == $account and .region == $region and ([.vaultBucketName,.libraryBucketName,.domainPrefix] | all(type == "string" and length > 0))' \
  "$tmp/settings" > /dev/null
jq --slurpfile s "$tmp/settings" '.account=$s[0].account | .region=$s[0].region |
  .buckets.vault.name=$s[0].vaultBucketName | .buckets.library.name=$s[0].libraryBucketName' \
  config/examples/storage.json > "$tmp/storage.json"
if [[ "$mode" == all ]]; then
  read_parameter app > "$tmp/callbacks"
  jq -e '(.callbackUrls | type == "array") and (.geminiCallbackUrls | type == "array")' "$tmp/callbacks" > /dev/null
  jq --slurpfile a "$tmp/callbacks" '.callbackUrls=$a[0].callbackUrls | .geminiCallbackUrls=$a[0].geminiCallbackUrls' \
    config/examples/mcp-runtime.json > "$tmp/mcp-runtime.json"
  jq --slurpfile s "$tmp/settings" '.domainPrefix=$s[0].domainPrefix' config/examples/cognito.json > "$tmp/cognito.json"
  jq --slurpfile s "$tmp/settings" 'map(.ResourceIdentifier.BucketName = (if .LogicalResourceId == "Vault" then $s[0].vaultBucketName
    elif .LogicalResourceId == "Library" then $s[0].libraryBucketName else error("Unknown import target") end))' \
    config/examples/import-resources.json > "$tmp/import-resources.json"
fi
if [[ "${GITHUB_ACTIONS:-}" == true ]]; then
  jq -r '.vaultBucketName, .libraryBucketName, .domainPrefix | "::add-mask::" + .' "$tmp/settings"
  if [[ "$mode" == all ]]; then
    jq -r '(.callbackUrls[], .geminiCallbackUrls[]) | "::add-mask::" + .' "$tmp/callbacks"
  fi
fi
for file in "$tmp"/*.json; do mv "$file" config/; done
