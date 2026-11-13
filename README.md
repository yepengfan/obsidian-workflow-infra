# Obsidian workflow infrastructure

Manage the existing private S3 buckets with explicit AWS CDK resource definitions.
Native CloudFormation resource import binds these definitions to the existing
buckets. Existing objects, version history, bucket names and Obsidian sync paths
stay in place. Notes and credentials never belong in this repository.

This repository defines the import baseline, scoped permission foundation and
automatic GitHub Actions Plan/Apply workflow. Applying cloud changes requires
separate review and approval; no object copy or cleanup is part of the baseline.

## Resource definitions

- `infra/storage-stack.ts` declares two managed `AWS::S3::Bucket` resources.
  These are not `fromBucketName` references.
- `config/storage.json` contains the visible, editable account, region, names,
  encryption, public-access, ownership and versioning settings.
- `config/import-resources.json` maps the stable logical IDs `Vault` and
  `Library` to the original physical bucket names. It is the native
  CloudFormation `--resources-to-import` format, not CDK's mapping format.

The baseline matches the read-only audit on 2026-11-13:

| Resource | Existing bucket | Versioning | Encryption |
| --- | --- | --- | --- |
| Vault | `obsidian-vault-sync-391824190072` | Enabled | AES256, SSE-C blocked, BucketKeyEnabled true |
| Library | `obsidian-ebook-library-391824190072` | Never enabled | AES256, SSE-C blocked, BucketKeyEnabled false |

Both have all four public-access blocks enabled and BucketOwnerEnforced
ownership. Neither has a bucket policy, CORS, lifecycle rules, replication,
notifications, access logging, website hosting or Object Lock configured.
The observed BucketKeyEnabled values are preserved; Bucket Keys apply to
SSE-KMS, and these buckets currently use AES256.

The CloudFormation registry schema in Sydney was checked for native support of
`BlockedEncryptionTypes`. No custom resource or SDK-based configuration writer
is used. Retain policies protect both resources during stack deletion or
replacement. There is no auto-empty code or object deletion permission here.

## Local validation

Use Node 22.18 or newer within Node 22:

```sh
npm ci
npm run check
npm run synth
```

These commands validate types, lint, test the synthesized resource semantics,
and produce `cdk.out/ObsidianWorkflowStorage.template.json`. They do not deploy.
The tests also demonstrate that changing Library versioning produces an update
to the same logical and physical resource definitions.

Do not hand-edit synthesized files. Edit TypeScript/configuration and synthesize
again. Review [the import procedure](docs/github-actions.md) before any AWS write.
PR CI runs without AWS credentials and publishes an offline infrastructure
preview, including OIDC and all three scoped role definitions, in its Summary and
artifact. Successful main CI automatically starts one deployment run: Plan
selects first import or later update, publishes the actual native change set,
and Apply waits for the owner's production environment approval before
automatically executing that exact ARN. See [setup and review steps](docs/github-actions.md).

All three IAM role names are defined in `config/github.json`. CI calculates
role ARNs from that configuration and the account in `config/storage.json`,
so no AWS Repository variables or static AWS keys are required. The permission
foundation uses a dedicated execution role scoped to the two configured buckets. See [foundation setup and permission updates](docs/github-actions.md)
for its permission boundaries and the required local SSO update procedure.

## Changes after import

After import succeeds and drift is checked, modify the same managed definitions
through a reviewed PR and the Actions deployment workflow. For example,
`buckets.library.versioning` can change from `unversioned` to `enabled`.
Bucket names and Region cannot change in place. Keep logical IDs stable.

Import is a separate operation from improvements. The baseline deliberately
does not enable HTTPS policies, library versioning, lifecycle expiry or IAM
changes. See [the post-import plan](docs/post-import-plan.md) for the selected
retention policy and required historical-impact review before activation.

## GitHub identity

All AI commits, pushes and new PRs use `yepeng-ai-developer[bot]` and the scoped
GitHub App installation token. The user reviews and merges PRs. Follow
[the identity guide](docs/github-app-identity.md); never fall back to personal
credentials. No App key or AWS credential belongs in Git or CI logs.

MCP and Cognito work remains on its existing branch and follows after storage
adoption. This storage baseline deploys no Lambda or public endpoint.

## Dependency audit

The minimatch override fixes the separately installed build-tool copy. The
pinned CDK library bundles another vulnerable minimatch copy, currently reported
as two moderate audit findings (minimatch and aws-cdk-lib). npm overrides do not
replace bundled dependencies. No dependency is deployed as application runtime
by this storage-only stack. Do not use `npm audit fix --force` to silently
downgrade CDK or claim the bundled finding is resolved. Recheck upstream before
publishing and report the remaining build-tool limitation.
