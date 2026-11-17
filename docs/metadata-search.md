# File discovery with Athena and S3 Metadata

`search_note_metadata` finds Markdown paths across the configured vault or an
explicit folder and its descendants. It matches literal path text and optional
inclusive `modifiedAfter`, `modifiedBefore`, `minSize`, and `maxSize` filters.
Date inputs accept ISO 8601 offsets and are compared in UTC; sizes are in bytes.
Results sort by S3 key, with up to 100 notes per page (20 by default).

It queries the AWS-maintained live inventory. It does not read note bodies,
extract frontmatter, index Obsidian tags, or recursively list S3 folders.
`list_notes` still browses a single S3 folder and `read_note` fetches the selected
current S3 object. Existing selected-note body search is unchanged.

## Requests and continuation

Example tool input:

```json
{
  "query": "design",
  "folder": "Learning",
  "modifiedAfter": "2026-11-01T00:00:00Z",
  "maxSize": 262144,
  "limit": 20
}
```

An empty query accepts any Markdown path. An empty folder explicitly searches
the configured vault prefix. A `state: "pending"` response has no matches yet:
repeat the same input with `cursor: nextCursor` to resume the same execution.
Do not restart a pending search. A completed page returns `notes` and
`scannedBytes`. If `complete` is false, its cursor starts a bounded query after
the last returned key. Pagination is not a snapshot across multiple pages.
Changing filters, limit, owner, bucket or prefix invalidates the cursor. The
adapter verifies a saved execution's exact SQL and workgroup before reading
results; a client-edited query ID cannot select an unrelated query result.

The existing MCP deadline is five seconds. The adapter polls briefly and returns
a pending cursor instead of waiting for the full Athena execution. An abandoned
execution can still finish and incur a scan charge. The workgroup caps each
query at 256 MiB; exceeding the cap fails rather than returning partial matches.
Restart expired/failed searches without their cursor. Athena-managed results
expire after 24 hours.

## Infrastructure and deployment order

`metadataSearch` in `config/mcp-runtime.json` enables the tool and IaC definitions.
The schema defaults to false when omitted. The versioned configuration proposes
enabling it; this PR does not deploy it.

- Storage stack: enable V2 MetadataConfiguration only on the vault, with live
  inventory, AES256 encryption, and the required journal retained for seven days.
  The library is unchanged. No custom resource, indexer or note-object write.
- MCP stack: add the native regional `s3tablescatalog` Glue integration with IAM
  access controls, retained on removal; add the on-demand Athena engine v3
  workgroup `obsidian-mcp-metadata`. Athena manages encrypted results and deletes
  them after 24 hours. There is no additional results bucket.
- Permission foundation: propose scoped configuration and query grants. Runtime
  Athena access is limited to the workgroup and S3 Tables reads to this vault's
  inventory table and namespace. SQL and path validation enforce the configured
  prefix. The separate CloudFormation MCP execution role receives the regional
  S3 Tables and Glue read prerequisites for registering the regional catalog,
  whose federated identifier is `bucket/*`. It cannot write table data. Namespace
  creation is restricted to the managed `aws-s3` bucket without an unsupported
  namespace condition; table creation retains its vault namespace condition.
  Note reads and practice writes remain separate responsibilities.

Before applying, check whether the regional `s3tablescatalog` already exists.
If so, inspect ownership and access mode, then import the native catalog into
the MCP stack or resolve ownership before deployment. Do not delete/recreate it
or reset existing Lake Formation grants. This is a shared regional integration;
runtime data access remains restricted to the vault inventory. A previously
retained catalog also requires import before re-enabling the feature.

Review the actual IAM/CDK diff and apply the permission foundation through the
existing approved SSO procedure first. Then use the existing Plan, approval,
Apply workflow for storage and MCP. Wait for inventory status Active before
accepting search. Bucket identities and note data are unchanged. Disabling the
tool does not automatically delete managed metadata tables; inspect retained
AWS data and charges separately.

The inventory contains versions and delete markers. Queries rank the newest
sequence per key before excluding markers and filtering date/size, so an old
version cannot resurrect a changed or deleted note. Updates typically appear
within one hour, without a strict maximum guarantee. Stale paths can temporarily
remain after renames/deletes; a current-object read can fail. Initial backfill
takes at least 15 minutes and can take hours.

## Cost and acceptance checks

Sydney on-demand SQL costs US$5/TB, with a 10 MB minimum per query. At that
minimum, 10,000 executed queries cost about US$0.48. Pending continuations reuse
an execution; later result pages start another query. Scans read metadata,
not Markdown bodies. Backfill, journal updates, table storage, requests,
maintenance and catalog usage are separate. No provisioned Athena capacity,
application cache or secondary database is introduced.

Local tests exercise the real MCP client with synthetic Athena data, pending
continuation, version-aware SQL, escaping, cursor isolation and prefix checks.
IaC tests inspect native resources and IAM. They do not prove live AWS handler
permissions, inventory readiness or performance. After approved deployment,
measure first/repeated search latency, pending rounds, scanned bytes and API
requests for representative filename/date/size searches. Compare metadata-only
S3 listing; removing body downloads alone is not an Athena speedup.

Official references:

- [Configuration and required journal](https://docs.aws.amazon.com/AmazonS3/latest/userguide/metadata-tables-create-configuration.html)
- [Inventory schema and freshness](https://docs.aws.amazon.com/AmazonS3/latest/userguide/metadata-tables-inventory-schema.html)
- [Version-aware query examples](https://docs.aws.amazon.com/AmazonS3/latest/userguide/metadata-tables-example-queries.html)
- [IAM-based regional integration](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-integrating-aws.html)
- [Athena-managed results](https://docs.aws.amazon.com/athena/latest/ug/managed-results.html)
- [Athena pricing](https://aws.amazon.com/athena/pricing/), [S3 pricing](https://aws.amazon.com/s3/pricing/)
