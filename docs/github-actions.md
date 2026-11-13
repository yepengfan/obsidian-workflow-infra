# GitHub Actions: automatic Plan, approval, Apply

The repository uses two workflows. `CI` checks pull requests and main without
AWS credentials. After a successful CI **push on main**, `Deploy storage`
automatically plans the exact verified commit, waits for the owner's native
GitHub environment approval, then applies that same CloudFormation change set.
There is no routine Run workflow action, operation input, ARN copy, or second
manual Apply trigger. First import is planned automatically too.

No AWS foundation, import, deployment, object copy or lifecycle cleanup has been
executed as part of preparing these workflows. The user reviews and merges
App-authored PRs, and separately approves concrete AWS changes.

## What to review in CI

Open a CI run's Summary. It includes the synthesized storage definitions and
GitHub OIDC / IAM diff against `config/empty-template.json`, plus the standard
CDK bootstrap template and its default AdministratorAccess execution-role
warning. Download `cloudformation-review` for the full templates and diff files.
Artifacts are retained for seven days.

This is an **offline first-adoption preview**, not a live AWS plan or a diff
against the PR's base commit. Added bucket definitions mean definitions to
import, not permission to create replacement buckets. CI has only Contents read,
no AWS OIDC permission and no App private key. Type checking, lint, tests,
actionlint and dependency audit remain in Verify; see README for the known
moderate CDK-bundled dependency findings.

## One-time foundation and GitHub environment setup

Before cloud planning can run, separately review the CI bootstrap template and
GitHub trust diff. Use the local `obsidian-admin` SSO session only for the
reviewed initial AWS foundation; do not upload a local profile to GitHub.
The standard bootstrap CloudFormation execution role defaults to
AdministratorAccess. Review or narrow this material permission explicitly;
the separate GitHub Plan / Deploy roles do not reduce the execution role's
permissions. Do not silently deploy or broaden it.

Only after the user confirms the concrete foundation plan, typical commands are:

```sh
npx --no-install cdk bootstrap aws://391824190072/ap-southeast-2 \
  --profile obsidian-admin
npx --no-install cdk deploy ObsidianGitHubTrust \
  --app 'npx --no-install tsx bin/github.ts' \
  --profile obsidian-admin --no-lookups --require-approval broadening \
  --outputs-file cdk-outputs-github.json
```

Set `AWS_PLAN_ROLE_ARN` and `AWS_DEPLOY_ROLE_ARN` from the actual stack outputs.
No static AWS key or GitHub App private key is used in the AWS jobs.

Configure repository Settings > Environments:

- `production-plan`: only the `main` branch; no manual reviewer gate.
- `production`: only `main`; Required reviewers must include repository owner
  `yepengfan`. This public repository supports native environment reviewers.
- If the owner initiates the upstream main push and is the sole approver, enabling
  Prevent self-review can prevent that owner from approving the deployment.
  Choose that option consistently with the actual approval participants.
- Disable administrator bypass if all deployments must use the reviewer gate.

The last read-only audit found no Required reviewers on `production`, and no
AWS role variables. These settings still need to be configured; workflow YAML
alone does not create environment protection. Both Plan and Apply check for the
owner's reviewer rule before AWS authentication and stop if it is absent or
cannot be read. This addresses the observed missing-rule configuration; it is
not a substitute for the native environment approval itself.

`infra/github-stack.ts` defines native OIDC trust for the exact immutable
repository/environment subjects and `sts.amazonaws.com` audience. PlanRole can
create an unexecuted change set and pass only the fixed CDK execution role.
DeployRole can execute reviewed change sets but cannot create substitute plans
or pass roles. Neither GitHub role has direct GetObject, PutObject or DeleteObject
permissions on the note buckets.

## Automatic deployment run

`deploy-storage.yml` listens to successful completed `CI` runs. It accepts only
pushes to main in this repository, never PR or fork runs. It checks out the
upstream run's exact `head_sha`, rejects a superseded main revision before AWS
authentication, and binds that SHA into the native change-set description.
It does not download or execute artifacts from untrusted PR runs.

### Plan

The Plan job uses the unapproved `production-plan` environment and PlanRole:

1. Synthesize storage from the verified commit.
2. Read actual `ObsidianWorkflowStorage` state. An exact stack-not-found response
   or an unexecuted `REVIEW_IN_PROGRESS` placeholder selects IMPORT. A stable
   imported/created/updated stack selects UPDATE only after its two bucket
   physical IDs match the versioned import mapping. Unsupported states,
   permission failures and network errors stop; they never default to import.
3. Create an unexecuted native CloudFormation change set. IMPORT passes
   `config/import-resources.json`; no object copying or note reads are involved.
4. Publish account, region, stack, full SHA, operation, ARN, resource actions,
   replacement indicators and original bucket mapping in the job Summary.
   Full plan/template/mapping are attached to this run's artifact.

A no-change UPDATE is reported without requesting approval or running Apply.
Other change-set creation failures fail the run. Plan creates metadata and may
create an empty stack placeholder; it does not execute changes to bucket
configuration. An IMPORT plan must contain only the two original buckets.
Library versioning, policies and lifecycle changes remain separate updates.

### Approval and Apply

For a plan with changes, Apply depends on Plan and references `production`.
GitHub waits for Required reviewers before starting that job. In the deployment
run, read the **Plan** Summary/artifact, then use **Review deployments** to
approve or reject. Approval starts Apply automatically; no ARN needs copying.

Apply receives the exact ARN and operation through job outputs. It checks the
native plan's available status, stack, repository, verified SHA and allowed
resource actions. IMPORT is exactly Vault / Library; UPDATE rejects removals,
replacements, new buckets and non-S3 resources, while permitting a later reviewed
BucketPolicy addition. Immediately before execution it queries live main again,
rejecting a superseded commit even on a rerun. It executes that ARN without
resynthesizing, waits for AWS completion, enables termination protection, and
checks modeled resource drift with a bounded poll.

The workflow concurrency group does not interrupt an in-flight deployment.
A newer main can queue while an old run awaits approval: reject or cancel the
superseded waiting run so the current one can plan. Approving an old run cannot
bypass the live-main check. If a deployment needs replanning, rerun CI for the
current main commit; successful CI completion automatically triggers deployment.
An old CI rerun is rejected if main advanced.

## Recovery and successful adoption

An AWS operation may complete even if a later waiter or drift check fails.
Inspect stack and change-set status before retrying; do not blindly re-import.
Successful adoption requires IMPORT_COMPLETE, the original physical bucket IDs,
IN_SYNC modeled properties and read-only client access / sync-preview checks.
Drift does not inspect unmodeled properties or validate note contents. Do not
create canary notes or activate sync as an implicit test.

Keep bucket names, Region and logical IDs stable. Later configuration changes use
reviewed PRs and the same automatic Plan / approved Apply flow. See
[the post-import plan](post-import-plan.md) for the selected, not-yet-enabled
historical retention policy and its separate impact review.

References: [GitHub workflow_run](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run),
[environment approval](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments),
[CloudFormation change sets](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-updating-stacks-changesets.html).
