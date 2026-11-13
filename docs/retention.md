# Versioning and 90-day historical retention

This change keeps the original `Vault` and `Library` bucket names and logical
IDs. Both use versioning. Each has one native S3 lifecycle rule that expires
versions 90 days after they become noncurrent. Current versions have no expiry
action. There is no count-based retention floor, expired-current-delete-marker
cleanup, scheduled Lambda, replication or separate backup bucket.

This is version history in the original buckets. It does not provide an
independent account/Region copy or protection against someone with permission
to permanently delete versions or change lifecycle configuration.

## Activation order

1. Review and merge the separate IAM permission PR. Apply its foundation UPDATE
   change set through the local SSO procedure in [github-actions.md](github-actions.md).
   Verify the deployed storage execution role allows
   `s3:PutLifecycleConfiguration` on exactly the original two bucket ARNs.
2. Complete a read-only, fully paginated version-metadata inventory. Include data
   versions and delete markers when identifying each version's successor.
   Report eligible noncurrent data-version counts/bytes and eligible noncurrent
   delete-marker counts separately. Save only aggregates in the review report,
   not note keys, bodies or credentials. A paginated scan is not a point-in-time
   snapshot; refresh it before activation if writers remain active.
3. Review and merge this resource PR. CI plans the merged revision against the
   live storage stack. Expect only in-place `Vault`/`Library` modifications:
   lifecycle configuration on both, plus enabled Library versioning. Reject
   bucket creation, deletion, replacement, renamed physical IDs or unrelated
   configuration changes.
4. Before production approval, pause Library sync/uploads/deletes. First-time
   versioning enablement can take up to 15 minutes to propagate. Keep writers
   paused for at least 15 minutes after AWS reports versioning enabled.
5. Explicitly approve the native production Apply only after reviewing the
   current impact report and exact change set. Existing eligible history can
   then be permanently deleted by S3. Retain policies do not prevent lifecycle
   expiry. The workflow applies that exact reviewed change set; no direct S3
   write command or separate manual Apply trigger is needed.

Previously unversioned Library files are not given historical copies
retroactively. Their existing null versions become noncurrent when later
overwritten or deleted after versioning is enabled. Existing lost versions
cannot be reconstructed by enabling versioning now.

## Timing and delete markers

Use the immediate successor's creation time, add 90 days and round up to the
next midnight UTC to estimate lifecycle eligibility. Do not use the old
version's original upload time. S3 processes eligible versions asynchronously.
The 90-day period starts at supersession, not at deployment.

Noncurrent delete markers can also expire under the native noncurrent-version
rule. A current delete marker is not removed by this configuration, even after
all its older versions expire. This preserves the deleted state and avoids
resurrecting an older version. No `Expiration` or `ExpiredObjectDeleteMarker`
action is configured.

## Read-only verification

After Apply completes, run these commands using an authorized local profile;
they do not read note bodies or modify objects:

```sh
for bucket in obsidian-vault-sync-391824190072 obsidian-ebook-library-391824190072; do
  aws s3api get-bucket-versioning --bucket "$bucket" \
    --profile obsidian-admin --region ap-southeast-2
  aws s3api get-bucket-lifecycle-configuration --bucket "$bucket" \
    --profile obsidian-admin --region ap-southeast-2
done
aws cloudformation describe-stacks --stack-name ObsidianWorkflowStorage \
  --profile obsidian-admin --region ap-southeast-2 \
  --query 'Stacks[0].{Status:StackStatus,Protection:EnableTerminationProtection,Drift:DriftInformation}'
```

Expect `Enabled` for both versioning responses and exactly the reviewed rule
with `NoncurrentDays: 90`. The CI Apply includes drift detection; require
`UPDATE_COMPLETE`, termination protection enabled and `IN_SYNC`. Version
metadata can demonstrate history exists, but it is not a restore test.
Do not upload/delete a test note or restore over an existing file without
separate authorization.

For recovery, list the affected key's versions and download the chosen version
to a separate local file with `aws s3api get-object --version-id ...` using an
identity permitted to read that version. Inspect it locally before deciding
whether to restore it. The CI execution role deliberately has no object-body
access. Expired versions cannot be recovered by removing the lifecycle rule.

## Reversing the policy

To stop future expiry, remove `noncurrentVersionRetentionDays` from both config
entries, keep versioning enabled, and review a new resource PR/change set.
This removes the lifecycle configuration; it cannot undo deletions already
processed by S3. First-time versioning enablement cannot return a bucket to
the never-versioned state. Do not use `unversioned` as a rollback setting.

References:
[Lifecycle elements and timing](https://docs.aws.amazon.com/AmazonS3/latest/userguide/intro-lifecycle-rules.html),
[noncurrent delete markers](https://docs.aws.amazon.com/AmazonS3/latest/userguide/lifecycle-configuration-examples.html#lifecycle-config-conceptual-ex8),
[first-time versioning propagation](https://docs.aws.amazon.com/AmazonS3/latest/userguide/manage-versioning-examples.html).
