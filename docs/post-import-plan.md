# Post-import configuration plan

The user selected the following retention policy on 2026-11-13. These settings
are planned, not deployed or enabled by the import baseline.

- Both buckets: expire noncurrent versions after they have been noncurrent for
  90 days, using native `NoncurrentVersionExpiration.NoncurrentDays`.
- Do not specify `NewerNoncurrentVersions`. There is no count-based floor that
  would retain old or deleted-key versions indefinitely.
- Do not set current-version `Expiration` or expired-delete-marker cleanup.
- Keep current files; do not add a scheduled cleanup Lambda.
- Library versioning remains off during import. Enabling it is a separate
  reviewed update before its future historical versions can be retained.

Before activation, complete the version-metadata inventory and review the
historical versions affected by the 90-day window. Age is measured from when a
successor version made a version noncurrent, not from its original upload time.
Lifecycle processing is asynchronous; this is a recovery window, not an
instantaneous limit on version count or total storage.

Existing eligible historical versions can be permanently deleted after this
rule is enabled. Retain policies do not protect versions from lifecycle expiry.
The user must review the concrete post-import diff and impact and explicitly
confirm before activation. The import template deliberately contains no lifecycle
rules, and selecting this plan does not authorize running deletion now.
The permission foundation now declares `s3:PutLifecycleConfiguration` on exactly
the two existing bucket ARNs. This grant does not enable any lifecycle rule.
After this permission PR is reviewed and merged, apply its IAM-only change set
through the [local SSO permission-update procedure](github-actions.md#permission-scope-and-future-changes).
Confirm the deployed execution-role policy contains the grant before opening
the separate versioning/retention PR. Ordinary CI cannot update this IAM policy.

Although this role still has no direct object-delete permission, lifecycle
configuration can cause S3 to permanently delete historical versions. Review
the resource PR and impact report before approving its production Apply. This
grant is not a policy-level restriction to 90 days; that limit is defined in
the separately reviewed bucket template. No resource retention changes are
activated by the permission update itself.

Reference: [S3 lifecycle elements](https://docs.aws.amazon.com/AmazonS3/latest/userguide/intro-lifecycle-rules.html).
