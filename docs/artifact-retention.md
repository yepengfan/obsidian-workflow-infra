# Resource retention

`config/storage.json` is the versioned retention configuration. This change is
a proposal until the permission foundation and native resource plans have each
been reviewed and approved. Merging source alone does not grant AWS permissions.

| Data | Policy | Mechanism |
| --- | --- | --- |
| Notes and books, including version history | [Existing retention and recovery policy](retention.md) | Native S3 lifecycle |
| Incomplete multipart uploads, all three buckets | Abort after 7 days | Proposed native S3 lifecycle |
| Unused code ZIP versions | 90 days after first observed unused | Proposed daily GitHub workflow |
| Deployed and immediate rollback code | Preserve while protected | Native deployment state and object tags |
| Lambda log events | 14 days | Explicit CloudWatch retention in the runtime template |
| GitHub review and cleanup artifacts | 7 days | Actions artifact retention |

See the [rollout guide](mcp-rollout.md#runtime-stage) for the current stage,
resource deletion/replacement policies and separate runtime deployment approval.
Resource retention does not disable event expiration or data-retention cleanup.
Current primary data intentionally has no age-based expiry. A retained empty
resource or IAM role does not itself accumulate stored history. Review any new
storage-producing resource's retention when adding it.

## Why code cleanup needs deployment awareness

An age-only S3 expiration rule could delete a ZIP still used by Lambda or needed
for rollback. A reused content-addressed key can also become active again after
it was marked unused. Code objects therefore have **no native object expiration**.
`artifact retention` and `plan and apply` use the same repository-wide concurrency
group with `queue: max` and no cancellation of in-progress runs. GitHub queues
these runs together; an approved Apply and cleanup cannot overlap.

Before publication, `bin/publish-code.ts` verifies current main, the stable native
MCP stack, its bucket/function binding and the actual Lambda code hash. Stable
states include `UPDATE_ROLLBACK_COMPLETE`, allowing a corrective publication or
cleanup only when the native template and actual function still match. In-progress
and failed rollback states are rejected; see the
[boundary tests](../test/code-deployment-state.test.ts).
A newly uploaded ZIP receives protection tags atomically with its conditional, encrypted
upload. A verified existing object receives version-specific protection tags.
Publication clears that object's unused timestamp. Configuration-only deployment
preserves the previous rollback key; a different target records the current key
as its immediate rollback key. Failed publication or deployment may leave extra
unused code, but cannot cause a cleanup run to expire the active/rollback keys.

`bin/retain-code.ts` verifies that same deployed state and protects **all versions**
of its current and immediate rollback keys, regardless of their ages. It does
not follow an unbounded rollback chain. Other managed ZIP versions are first
tagged `obsidian-unused-since`; only a later run, at least 90 days after that
observation, may delete their explicit version IDs. Original upload age does not
start this clock. A new unused artifact therefore gets a full observed window.
Unknown objects, unclassified versions and delete markers are counted and
skipped. They can remain indefinitely until separately reviewed. Version-specific
deletion creates no new delete marker.

The default limits are 5,000 listed versions/markers and 1,000 mutations per run,
four concurrent tag reads and a four-minute SDK deadline. AWS metadata subprocesses
have 15-second timeouts and the workflow has a ten-minute timeout. Cleanup completes
the entire bounded listing and validates candidate metadata before any mutation.
Overflow, malformed/missing protection metadata, unstable stacks, hash mismatch
or an unrecognized retained function fail closed. Main and deployment revision are
rechecked before each write. Expired deletions take priority over new unused marks.
Do not raise a limit blindly after a failure; inspect the aggregate counts first.

Each successful mutation updates an aggregate receipt. The workflow uploads that
receipt even after a later failure. Operations are not transactional: a network
failure can leave a completed operation without a confirmed receipt. Inspect AWS
before retrying. Receipts contain counts/bytes, never note keys, bodies or tokens.

## Permissions and activation order

The new `codeRetentionRoleName` is separate from Plan and Deploy. It trusts only
the existing immutable repository subject in `production-plan`, which must remain
restricted to main. It can list versions under the code bucket's `releases/` prefix,
read/write their tags and delete explicit versions there. It can read only the
MCP stack template/state and the named Lambda configuration. It has no note-bucket
access, code-body download, unversioned delete, bucket delete, infrastructure write
or IAM-update permission. Plan and Deploy gain no version-deletion permission.

1. Merge the reviewed source PR. Keep production Apply unapproved while reviewing
   activation. Read-only CI plans can run; they do not activate retention.
2. Prepare the IAM foundation UPDATE using the existing local SSO procedure in
   [github-actions.md](github-actions.md). Review the concrete CDK/native diff:
   the dedicated cleanup role, code-only deployment tagging grants and
   `s3:PutLifecycleConfiguration` on the code bucket for MCP execution.
3. **Approving and executing this IAM update activates scheduled code cleanup.**
   Scheduled runs on main apply the reviewed policy without an additional daily
   approval. Approval must explicitly cover version tagging and eventual permanent
   deletion of unused code after 90 days. Do not apply this IAM plan merely to fix
   a red maintenance job before the owner approves activation. Before the role
   exists, its scheduled/manual workflow fails authentication without mutations.
4. Review the business infrastructure Plan and approve its native production Apply
   separately. Expect only in-place lifecycle additions on Vault, Library and
   CodeArtifacts. The new rule aborts multipart uploads more than seven days old,
   including already unfinished uploads. It does not delete completed objects or
   change the existing 90-day note history rule. Inventory unfinished upload
   metadata and account for long-running uploads before approval.
5. Run manual `artifact retention` with its default **dry_run: true**. Verify actual
   OIDC, protected counts and receipts. The initial code bucket was empty during
   the read-only audit; first code publication also requires verification after
   the later runtime rollout. Do not upload/delete canary objects implicitly.

No GitHub repository variables, static AWS keys, new Lambda, database or CDK
bootstrap stack are needed. An IAM approval and a resource Apply remain separate
because ordinary CI cannot widen its own privileges.

## Preview and verification

```sh
npm ci
npm run check
npm run synth
# Metadata/tag reads only, using an already authorized local AWS session:
AWS_PROFILE=obsidian-admin node_modules/.bin/tsx bin/retain-code.ts --dry-run
```

The CLI defaults to dry-run and does not even mark unused objects in that mode.
`--apply` requires trusted current-main Actions context and the dedicated assumed
cleanup role; a local SSO session cannot use it. Manual workflow execution also
defaults to dry-run; setting `dry_run: false` applies the already approved policy.
After native Apply, use `get-bucket-lifecycle-configuration` on all three configured
buckets and verify the seven-day abort rule, with the existing 90-day rule still
present on both note buckets. CloudWatch `describe-log-groups` must show 14-day
retention once the runtime exists. Inspect the daily workflow receipts for backlog
or skipped/unclassified versions.

Unit tests exercise elapsed-time deletion, reactivation, rollback protection,
pagination, bounds, malformed metadata, partial writes and deployment changes.
They do not prove hosted OIDC, production deletion, native lifecycle timing or
recovery. Those remain live-validation limits until separately approved and
observed. No data has been deleted by preparing this PR.

References: [S3 lifecycle actions](https://docs.aws.amazon.com/AmazonS3/latest/userguide/intro-lifecycle-rules.html),
[version tagging](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObjectTagging.html),
[GitHub concurrency and queueing](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).
GitHub supports `queue: max`; pinned actionlint 1.7.12 does not yet recognize that
single key ([upstream issue](https://github.com/rhysd/actionlint/issues/657)). CI
suppresses only that diagnostic and tests the parsed shared concurrency contract.
