# Post-import configuration plan

The user selected the following retention policy on 2026-11-13. These settings
are planned, not deployed or enabled by the import baseline.

- Both buckets: expire noncurrent versions after they have been noncurrent for
  90 days, using native `NoncurrentVersionExpiration.NoncurrentDays`.
- Do not specify `NewerNoncurrentVersions`. There is no count-based floor that
  would retain old or deleted-key versions indefinitely.
- Do not set current-version `Expiration` or expired-delete-marker cleanup.
- Keep current files; do not add a scheduled cleanup Lambda.
- Library versioning was off during import. The separate resource update now
  requests enabled versioning so its future historical versions can be retained.

Before activation, complete the version-metadata inventory and review the
historical versions affected by the 90-day window. Age is measured from when a
successor version made a version noncurrent, not from its original upload time.
Lifecycle processing is asynchronous; this is a recovery window, not an
instantaneous limit on version count or total storage.

Existing eligible historical versions can be permanently deleted after this
rule is enabled. Retain policies do not protect versions from lifecycle expiry.
The user must review the concrete post-import diff and impact and explicitly
confirm before activation. The initial import baseline contained no lifecycle
rules; selecting this plan does not authorize running deletion now.

Before opening the separate versioning/retention PR, complete the
[local SSO permission-update procedure](github-actions.md#permission-scope-and-future-changes),
which describes the execution-role scope and its indirect deletion capability.
Confirm the deployed execution-role policy contains the reviewed lifecycle grant.
Then follow the [activation and verification procedure](retention.md), including
the first-time Library versioning propagation window and recovery limitations.

Reference: [S3 lifecycle elements](https://docs.aws.amazon.com/AmazonS3/latest/userguide/intro-lifecycle-rules.html).
