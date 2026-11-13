#!/usr/bin/env bash
set -euo pipefail

manifest=${1:-infrastructure-plan.json}
mkdir -p infrastructure-apply
artifacts=${CODE_ARTIFACT_DIR:-cdk.out}
jq -e --arg sha "$SOURCE_SHA" --arg repo "$GITHUB_REPOSITORY_ID" --arg account "$ACCOUNT" --arg region "$REGION" '
  .schemaVersion == 1 and .sourceSha == $sha and .repositoryId == $repo and .account == $account and .region == $region and (.stacks | type == "array") and
  ([.stacks[].name] | sort == ["ObsidianMcp","ObsidianWorkflowStorage"]) and
  all(.stacks[]; (.hasChanges | type == "boolean") and
    (if .name == "ObsidianWorkflowStorage" then (.operation == "import" or .operation == "update") else .operation == "update" end) and
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
    '.Status == "CREATE_COMPLETE" and .ExecutionStatus == "AVAILABLE" and .Description == $description and (.StackId | startswith($stack)) and ([.Changes[].ResourceChange] | all(.Replacement == null or .Replacement == "False"))' "$file"
  case "$stack:$operation" in
    ObsidianWorkflowStorage:import)
      jq -e '[.Changes[].ResourceChange] | length == 2 and all(.Action == "Import" and .ResourceType == "AWS::S3::Bucket") and ([.[].LogicalResourceId] | sort == ["Library","Vault"])' "$file" ;;
    ObsidianWorkflowStorage:update)
      jq -e '[.Changes[].ResourceChange] | all((.ResourceType == "AWS::S3::Bucket" and (.LogicalResourceId == "Vault" or .LogicalResourceId == "Library") and .Action == "Modify") or (.ResourceType == "AWS::S3::BucketPolicy" and (.Action == "Add" or .Action == "Modify")))' "$file" ;;
    ObsidianMcp:update)
      jq -e --slurpfile model "$artifacts/ObsidianMcp.template.json" '
        $model[0].Resources as $expected | [.Changes[].ResourceChange] |
        all(. as $r | ($r.Action == "Add" or $r.Action == "Modify") and $expected[$r.LogicalResourceId].Type == $r.ResourceType and
          ($r.ResourceType != "AWS::IAM::Role" and $r.ResourceType != "AWS::IAM::Policy"))' "$file" ;;

  esac
done < <(jq -c '.stacks[] | select(.hasChanges)' "$manifest")

# Every native plan has now been checked. Upload code only after production approval,
# and recheck main before the first S3 write as well as each stack execution.
if jq -e 'any(.stacks[]; .name == "ObsidianMcp" and .hasChanges)' "$manifest" > /dev/null; then
  [[ "$(gh api "repos/${GITHUB_REPOSITORY}/git/ref/heads/main" --jq '.object.sha')" == "$SOURCE_SHA" ]]
  jq -e --slurpfile code "$artifacts/CodeBundle.json" '.code == $code[0]' "$manifest"
  npm exec -- tsx bin/publish-code.ts "$artifacts"
fi

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
if jq -e 'any(.stacks[]; .name == "ObsidianMcp" and .hasChanges)' "$manifest" > /dev/null; then
  function_name=$(jq -er '.Resources.McpFunction.Properties.FunctionName' "$artifacts/ObsidianMcp.template.json")
  aws lambda get-function-configuration --function-name "$function_name" > infrastructure-apply/runtime-code.json
  expected_code=$(jq -r '.code.sha256Base64' "$manifest")
  jq -e --arg sha "$expected_code" '.CodeSha256 == $sha and .State == "Active" and .LastUpdateStatus == "Successful"' infrastructure-apply/runtime-code.json
  echo "Runtime code matches approved ZIP SHA-256: $(jq -r .code.sha256 "$manifest")" >> "$GITHUB_STEP_SUMMARY"
fi
echo 'Exact infrastructure change sets completed; modeled storage is IN_SYNC. Native Lambda code checksum is verified when changed. Live OAuth and ChatGPT verification remain separate.'  >> "$GITHUB_STEP_SUMMARY"
