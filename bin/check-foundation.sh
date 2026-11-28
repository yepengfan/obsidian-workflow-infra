#!/usr/bin/env bash
# CI never applies the IAM foundation; the owner applies it through the reviewed
# local SSO change set (docs/github-actions.md). Refuse to plan while the
# deployed foundation differs from this commit's synthesized one, so that an
# application change never reaches production ahead of the permissions it needs.
set -euo pipefail

stack=ObsidianGitHubTrust
dir=infrastructure-plan/foundation
mkdir -p "$dir"
aws cloudformation get-template --stack-name "$stack" --template-stage Original \
  --query TemplateBody --output json > "$dir/body.json"
# A JSON template body is returned as an object, or as a string when it was submitted as text.
jq -S 'if type == "string" then fromjson else . end' "$dir/body.json" > "$dir/deployed.json"
jq -S . "cdk.out/${stack}.template.json" > "$dir/model.json"
if cmp -s "$dir/model.json" "$dir/deployed.json"; then
  echo "IAM foundation: the deployed ${stack} matches this commit." >> "$GITHUB_STEP_SUMMARY"
  exit 0
fi
changed=$(jq -rn --slurpfile model "$dir/model.json" --slurpfile live "$dir/deployed.json" '
  ($model[0].Resources // {}) as $m | ($live[0].Resources // {}) as $l |
  [($m + $l | keys[]) | select($m[.] != $l[.])] |
  if length == 0 then "template parameters, metadata or outputs" else join(", ") end')
message="The deployed IAM foundation ${stack} differs from this commit: ${changed}. Apply the reviewed foundation through the local SSO procedure in docs/github-actions.md, then re-run this workflow."
{ echo '## IAM foundation not applied'; echo; echo "$message"; } >> "$GITHUB_STEP_SUMMARY"
echo "$message" >&2
exit 1
