# Obsidian workflow infrastructure

Manage the existing private S3 buckets and staged MCP identity infrastructure with AWS CDK.
Native CloudFormation resource import binds these definitions to the existing
buckets. Existing objects, version history, bucket names and Obsidian sync paths
stay in place. Notes and credentials never belong in this repository.

This repository defines the managed storage configuration, scoped permission
foundation and automatic GitHub Actions Plan/Apply workflow. Applying cloud
changes requires separate review and approval; no object copy or cleanup was
part of the initial import baseline.

## Resource definitions

- `infra/storage-stack.ts` declares two managed `AWS::S3::Bucket` resources.
  These are not `fromBucketName` references.
- `config/storage.json` contains the visible, editable account, region, names,
  encryption, public-access, ownership, versioning and retention settings.
- `config/import-resources.json` maps the stable logical IDs `Vault` and
  `Library` to the original physical bucket names. It is the native
  CloudFormation `--resources-to-import` format, not CDK's mapping format.

The initial import baseline matched the read-only audit on 2026-11-13:

| Resource | Existing bucket | Versioning | Encryption |
| --- | --- | --- | --- |
| Vault | `obsidian-vault-sync-391824190072` | Enabled | AES256, SSE-C blocked, BucketKeyEnabled true |
| Library | `obsidian-ebook-library-391824190072` | Never enabled | AES256, SSE-C blocked, BucketKeyEnabled false |

Both have all four public-access blocks enabled and BucketOwnerEnforced
ownership. At import, neither had a bucket policy, CORS, lifecycle rules, replication,
notifications, access logging, website hosting or Object Lock configured.
The observed BucketKeyEnabled values are preserved; Bucket Keys apply to
SSE-KMS, and these buckets currently use AES256.

The CloudFormation registry schema in Sydney was checked for native support of
`BlockedEncryptionTypes`. No custom resource or SDK-based configuration writer
is used. Retain policies protect both resources during stack deletion or
replacement. There is no auto-empty code or direct object deletion permission.
See [execution-role permission scope](docs/github-actions.md#permission-scope-and-future-changes)
for the lifecycle grant's indirect deletion capability.

## Local validation

Use Node 22.18 or newer within Node 22:

```sh
npm ci
npm run check
npm run synth
```

These commands validate types, lint and behavior, then synthesize the entire
infrastructure through `bin/infrastructure.ts` into one `cdk.out` assembly. It
contains the storage, Cognito and IAM foundation templates. They do not deploy.
The tests cover enabling Library versioning, expiring only noncurrent versions,
rejecting unsupported retention settings, removing lifecycle without changing
versioning, and preserving the original logical/physical resource definitions.

Do not hand-edit synthesized files. Edit TypeScript/configuration and synthesize
again. Review [the import procedure](docs/github-actions.md) before any AWS write.
`validate` runs without AWS credentials and publishes an offline infrastructure
preview, including OIDC and the scoped role definitions, in its Summary and
artifact. Successful main validation starts `plan and apply`: one combined
infrastructure Plan, one native production approval, then Apply of all exact
changed ARNs. Existing stack IDs and scoped roles remain stable; IAM permission
updates still require the reviewed local SSO procedure. AWS executes each stack
independently, so partial completion must be inspected before retrying. See [setup and review steps](docs/github-actions.md).

See [foundation setup and permission updates](docs/github-actions.md) for
versioned role configuration, the migration of existing CI roles, permission
boundaries and the required local SSO update procedure.

## Changes after import

See the [retention procedure](docs/retention.md) for the deployed policy,
initial activation safeguards, impact review and verification limits.
Bucket names and Region cannot change in place. Keep logical IDs stable.

Import was a separate operation from these improvements. No HTTPS bucket policy
or replication is introduced.

## Cognito compatibility probe

The separate `ObsidianMcp` stack probes Cognito issuer compatibility before
building the authenticated MCP application. It provides no MCP endpoint or
note access. Its template is included in the shared infrastructure assembly:

```sh
npm run synth
```

Read the [Cognito deployment and compatibility procedure](docs/cognito-preflight.md)
for configuration, resource safeguards, CI approval, discovery checks and the
required steps before OAuth or private-note access.

## GitHub identity

Follow [the identity guide](docs/github-app-identity.md) for the required GitHub
App identity, scoped credentials and PR review rules. No App key or AWS credential
belongs in Git or CI logs.

## Dependency audit

The minimatch override fixes the separately installed build-tool copy. The
pinned CDK library bundles another vulnerable minimatch copy, currently reported
as two moderate audit findings (minimatch and aws-cdk-lib). npm overrides do not
replace bundled dependencies. No dependency is deployed as application runtime
by these infrastructure-only stacks. Do not use `npm audit fix --force` to silently
downgrade CDK or claim the bundled finding is resolved. Recheck upstream before
publishing and report the remaining build-tool limitation.
