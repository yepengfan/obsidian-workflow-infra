#!/usr/bin/env bash
set -euo pipefail

manifest=${1:-infrastructure-plan.json}
mkdir -p infrastructure-apply
jq -e --arg sha "$SOURCE_SHA" --arg repo "$GITHUB_REPOSITORY_ID" --arg account "$ACCOUNT" --arg region "$REGION" '
  .schemaVersion == 1 and .sourceSha == $sha and .repositoryId == $repo and .account == $account and .region == $region and (.stacks | type == "array") and
  ([.stacks[].name] | sort == ["ObsidianMcp","ObsidianWorkflowStorage"]) and
  all(.stacks[]; (.hasChanges | type == "boolean") and
    (if .name == "ObsidianWorkflowStorage" then (.operation == "import" or .operation == "update") else (.operation == "create" or .operation == "update") end) and
    (.arn | type == "string"))' "$manifest"

# Validate every changed native plan before executing any stack in the group.
while IFS= read -r entry; do
  stack=$(jq -r .name <<< "$entry"); operation=$(jq -r .operation <<< "$entry"); arn=$(jq -r .arn <<< "$entry")
  case "$stack" in ObsidianWorkflowStorage) prefix=obsidian-storage ;; ObsidianMcp) prefix=obsidian-mcp ;; *) exit 1 ;; esac
  [[ "$arn" == "arn:aws:cloudformation:${REGION}:${ACCOUNT}:changeSet/${prefix}-${operation}-"* ]]
  file="infrastructure-apply/${stack}.reviewed-plan.json"
  aws cloudformation describe-change-set --change-set-name "$arn" > "$file"
  expected="repo=${GITHUB_REPOSITORY_ID} sha=${SOURCE_SHA} operation=${operation}"
  jq -e --arg description "$expected" --arg stack "arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/${stack}/" \
    '.Status == "CREATE_COMPLETE" and .ExecutionStatus == "AVAILABLE" and .Description == $description and (.StackId | startswith($stack)) and ([.Changes[].ResourceChange] | length > 0 and all(.Replacement == null or .Replacement == "False"))' "$file"
  case "$stack:$operation" in
    ObsidianWorkflowStorage:import)
      jq -e '[.Changes[].ResourceChange] | length == 2 and all(.Action == "Import" and .ResourceType == "AWS::S3::Bucket") and ([.[].LogicalResourceId] | sort == ["Library","Vault"])' "$file" ;;
    ObsidianWorkflowStorage:update)
      jq -e '[.Changes[].ResourceChange] | all((.ResourceType == "AWS::S3::Bucket" and (.LogicalResourceId == "Vault" or .LogicalResourceId == "Library") and .Action == "Modify") or (.ResourceType == "AWS::S3::BucketPolicy" and (.Action == "Add" or .Action == "Modify")))' "$file" ;;
    ObsidianMcp:*)
      jq -e '[.Changes[].ResourceChange] | all((.LogicalResourceId == "UserPool" and .ResourceType == "AWS::Cognito::UserPool") or (.LogicalResourceId == "UserPoolDomain" and .ResourceType == "AWS::Cognito::UserPoolDomain") or (.LogicalResourceId == "CodeArtifacts" and .ResourceType == "AWS::S3::Bucket") or (.LogicalResourceId == "CodeArtifactsPolicy" and .ResourceType == "AWS::S3::BucketPolicy"))' "$file"
      if [[ "$operation" == create ]]; then
        jq -e '[.Changes[].ResourceChange] | length == 2 and all(.Action == "Add") and ([.[].LogicalResourceId] | sort == ["UserPool","UserPoolDomain"])' "$file"
      else
        jq -e '[.Changes[].ResourceChange] | all((.Action == "Modify") or (.Action == "Add" and (.LogicalResourceId == "CodeArtifacts" or .LogicalResourceId == "CodeArtifactsPolicy")))' "$file"
        if jq -e 'any(.Changes[].ResourceChange; .LogicalResourceId == "CodeArtifacts" or .LogicalResourceId == "CodeArtifactsPolicy")' "$file" > /dev/null; then
          node --input-type=commonjs -e 'if (!require("./config/github.json").mcpRuntime?.codeBucketName) process.exit(1)'
        fi
      fi ;;
  esac
done < <(jq -c '.stacks[] | select(.hasChanges)' "$manifest")

while IFS= read -r entry; do
  stack=$(jq -r .name <<< "$entry"); operation=$(jq -r .operation <<< "$entry"); arn=$(jq -r .arn <<< "$entry")
  [[ "$(gh api "repos/${GITHUB_REPOSITORY}/git/ref/heads/main" --jq '.object.sha')" == "$SOURCE_SHA" ]]
  case "$operation" in import) waiter='stack-import-complete' ;; create) waiter='stack-create-complete' ;; update) waiter='stack-update-complete' ;; *) exit 1 ;; esac
  aws cloudformation update-termination-protection --enable-termination-protection --stack-name "$stack"
  aws cloudformation execute-change-set --change-set-name "$arn"
  aws cloudformation wait "$waiter" --stack-name "$stack"
  aws cloudformation describe-stacks --stack-name "$stack" > "infrastructure-apply/${stack}.stack.json"
  jq -e '.Stacks[0].EnableTerminationProtection == true' "infrastructure-apply/${stack}.stack.json"
  echo "Applied ${stack} (${operation}): ${arn}. This stack has completed even if a later operation or check fails." >> "$GITHUB_STEP_SUMMARY"
done < <(jq -c '.stacks[] | select(.hasChanges)' "$manifest")

# Preserve the existing storage drift check. It never reads note bodies.
detection=$(aws cloudformation detect-stack-drift --stack-name ObsidianWorkflowStorage --query StackDriftDetectionId --output text)
complete=false
for _ in {1..30}; do
  aws cloudformation describe-stack-drift-detection-status --stack-drift-detection-id "$detection" > infrastructure-apply/drift.json
  status=$(jq -r .DetectionStatus infrastructure-apply/drift.json)
  case "$status" in
    DETECTION_COMPLETE) jq -e '.StackDriftStatus == "IN_SYNC"' infrastructure-apply/drift.json; complete=true; break ;;
    DETECTION_FAILED) cat infrastructure-apply/drift.json >&2; exit 1 ;;
  esac
  sleep 5
done
[[ "$complete" == true ]] || { echo 'Storage drift check timed out. Inspect AWS before retrying.' >&2; exit 1; }
aws cloudformation describe-stacks --stack-name ObsidianMcp > infrastructure-apply/ObsidianMcp.stack.json
echo 'Infrastructure change sets completed; modeled storage is IN_SYNC. Live Cognito discovery is checked next. OAuth and note access remain disabled.' >> "$GITHUB_STEP_SUMMARY"
