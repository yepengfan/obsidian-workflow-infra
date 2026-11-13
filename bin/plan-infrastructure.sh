#!/usr/bin/env bash
set -euo pipefail

mkdir -p infrastructure-plan
jq -n --arg sha "$SOURCE_SHA" --arg repo "$GITHUB_REPOSITORY_ID" --arg account "$ACCOUNT" --arg region "$REGION" \
  '{schemaVersion:1, sourceSha:$sha, repositoryId:$repo, account:$account, region:$region, stacks:[]}' > infrastructure-plan.json
{
  echo '## Infrastructure plan'
  echo
  echo "Account: ${ACCOUNT} | Region: ${REGION} | Verified commit: ${SOURCE_SHA}"
  echo
  echo '| Stack | Operation | Action | Logical resource | Type | Replacement |'
  echo '| --- | --- | --- | --- | --- | --- |'
} >> "$GITHUB_STEP_SUMMARY"

# These are the existing deployment boundaries, not separate CI jobs. Adding a
# new stack still requires its reviewed IAM scope before ordinary CI can use it.
for stack in ObsidianWorkflowStorage ObsidianMcp; do
  state="infrastructure-plan/${stack}.stack.json"
  resources="infrastructure-plan/${stack}.resources.json"
  plan="infrastructure-plan/${stack}.change-set.json"
  if aws cloudformation describe-stacks --stack-name "$stack" > "$state" 2> infrastructure-plan/stack-error.txt; then
    status=$(jq -r '.Stacks[0].StackStatus' "$state")
    case "$status" in
      REVIEW_IN_PROGRESS) operation=initial ;;
      IMPORT_COMPLETE|CREATE_COMPLETE|UPDATE_COMPLETE|UPDATE_ROLLBACK_COMPLETE)
        aws cloudformation describe-stack-resources --stack-name "$stack" > "$resources"
        operation=update ;;
      *) echo "Unsupported stack state for ${stack}: ${status}. Inspect AWS before retrying." >&2; exit 1 ;;
    esac
  else
    error=$(cat infrastructure-plan/stack-error.txt)
    if [[ "$error" == *'(ValidationError)'* && "$error" == *"Stack with id ${stack} does not exist"* ]]; then
      operation=initial
    else
      cat infrastructure-plan/stack-error.txt >&2
      exit 1
    fi
  fi

  args=()
  case "$stack" in
    ObsidianWorkflowStorage)
      prefix=obsidian-storage; execution_role=$STORAGE_EXECUTION_ROLE
      types=(AWS::S3::Bucket AWS::S3::BucketPolicy)
      if [[ "$operation" == initial ]]; then
        operation=import; args+=(--resources-to-import file://config/import-resources.json)
      else
        jq -e --slurpfile expected config/import-resources.json \
          '[.StackResources[] | select(.ResourceType == "AWS::S3::Bucket") | {LogicalResourceId, ResourceType, ResourceIdentifier:{BucketName:.PhysicalResourceId}}] | sort_by(.LogicalResourceId) == ($expected[0] | sort_by(.LogicalResourceId))' "$resources"
      fi ;;
    ObsidianMcp)
      prefix=obsidian-mcp; execution_role=$MCP_EXECUTION_ROLE
      types=(AWS::Cognito::UserPool AWS::Cognito::UserPoolDomain AWS::S3::Bucket AWS::S3::BucketPolicy)
      if [[ "$operation" == initial ]]; then
        operation=create
        node --input-type=commonjs -e 'if (require("./config/github.json").mcpUserPoolId) { console.error("Pinned pool stack is absent; inspect retained identity resources."); process.exit(1); }'
      else
        code_bucket=$(node --input-type=commonjs -e 'process.stdout.write(require("./config/github.json").mcpRuntime?.codeBucketName ?? "")')
        jq -e --arg bucket "$code_bucket" '.StackResources |
          ([.[] | select(.LogicalResourceId == "UserPool" or .LogicalResourceId == "UserPoolDomain") | {LogicalResourceId,ResourceType}] | sort_by(.LogicalResourceId) == [{LogicalResourceId:"UserPool",ResourceType:"AWS::Cognito::UserPool"},{LogicalResourceId:"UserPoolDomain",ResourceType:"AWS::Cognito::UserPoolDomain"}]) and
          all(.[]; (.LogicalResourceId == "UserPool" and .ResourceType == "AWS::Cognito::UserPool") or
            (.LogicalResourceId == "UserPoolDomain" and .ResourceType == "AWS::Cognito::UserPoolDomain") or
            ($bucket != "" and .PhysicalResourceId == $bucket and ((.LogicalResourceId == "CodeArtifacts" and .ResourceType == "AWS::S3::Bucket") or (.LogicalResourceId == "CodeArtifactsPolicy" and .ResourceType == "AWS::S3::BucketPolicy"))))' "$resources"
        node --input-type=commonjs - "$resources" <<'NODE'
const fs = require('node:fs');
const pinned = require('./config/github.json').mcpUserPoolId;
const resources = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).StackResources;
if (pinned && resources.find(r => r.LogicalResourceId === 'UserPool').PhysicalResourceId !== pinned) process.exit(1);
NODE
      fi ;;
  esac
  name="${prefix}-${operation}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
  description="repo=${GITHUB_REPOSITORY_ID} sha=${SOURCE_SHA} operation=${operation}"
  case "$operation" in import) type=IMPORT ;; create) type=CREATE ;; update) type=UPDATE ;; *) exit 1 ;; esac
  arn=$(aws cloudformation create-change-set --stack-name "$stack" --change-set-name "$name" \
    --change-set-type "$type" --description "$description" \
    --template-body "file://cdk.out/${stack}.template.json" --role-arn "$execution_role" \
    --resource-types "${types[@]}" "${args[@]}" --query Id --output text)
  has_changes=true
  if ! aws cloudformation wait change-set-create-complete --change-set-name "$arn"; then
    aws cloudformation describe-change-set --change-set-name "$arn" > "$plan"
    if [[ "$operation" == update ]] && jq -e '.Status == "FAILED" and ((.StatusReason | startswith("The submitted information didn\u0027t contain changes.")) or (.StatusReason | startswith("No updates are to be performed")))' "$plan"; then
      has_changes=false
    else
      cat "$plan" >&2; exit 1
    fi
  else
    aws cloudformation describe-change-set --change-set-name "$arn" > "$plan"
  fi
  jq --arg name "$stack" --arg operation "$operation" --arg arn "$arn" --argjson changed "$has_changes" \
    '.stacks += [{name:$name,operation:$operation,arn:$arn,hasChanges:$changed}]' infrastructure-plan.json > infrastructure-plan/next.json
  mv infrastructure-plan/next.json infrastructure-plan.json
  if [[ "$has_changes" == true ]]; then
    jq -r --arg stack "$stack" --arg operation "$operation" '.Changes[].ResourceChange | "| \($stack) | \($operation) | \(.Action) | \(.LogicalResourceId) | \(.ResourceType) | \(.Replacement // "n/a") |"' "$plan" >> "$GITHUB_STEP_SUMMARY"
  else
    echo "| ${stack} | ${operation} | No changes | | | |" >> "$GITHUB_STEP_SUMMARY"
  fi
done

{
  echo
  echo '### Exact change sets'
  jq -r '.stacks[] | "- \(.name): \(.arn) (changes: \(.hasChanges))"' infrastructure-plan.json
  echo
  echo '### Existing storage binding'
  echo '| Logical resource | Original bucket |'
  echo '| --- | --- |'
  jq -r '.[] | "| \(.LogicalResourceId) | \(.ResourceIdentifier.BucketName) |"' config/import-resources.json
  echo
  echo 'Review the entire infrastructure plan and template artifact. One production approval authorizes Apply of these exact changed ARNs. AWS executes each stack independently; partial completion is possible and must be inspected before retrying.'
  echo 'The IAM foundation is included in the assembly preview but is never deployed by ordinary CI. Permission changes still require the reviewed local SSO procedure. Code storage contains deployment ZIPs only. No users, OAuth clients, MCP endpoint or note access are enabled by this stage.'
} >> "$GITHUB_STEP_SUMMARY"
echo "plan=$(jq -c . infrastructure-plan.json)" >> "$GITHUB_OUTPUT"
echo "has_changes=$(jq 'any(.stacks[]; .hasChanges)' infrastructure-plan.json)" >> "$GITHUB_OUTPUT"
