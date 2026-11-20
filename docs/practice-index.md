# Practice review index

The MCP practice queue is moving from a per-request S3 scan to a DynamoDB index
that reads in one query. Notes stay the source of truth. Each table row is a
rebuildable projection of one note's frontmatter. Local tools (`review.py`, the
vault Dashboard) keep reading the files directly.

This guide covers the indexer, its deployment order and its operation. Switching
`practice_reviews` to the index is a separate change; until then the index is
written but not read.

## Design

```text
note change ─ S3 (EventBridge enabled on the vault)
            ─ rule obsidian-mcp-index-changes (vault, indexed folders only)
            ─ SQS FIFO obsidian-mcp-index.fifo, one message group
            ─ Lambda obsidian-mcp-indexer: re-read note, put or delete row
            ─ DynamoDB obsidian-mcp-index-<module>

03:00 Brisbane ─ rule obsidian-mcp-index-reconcile ─ indexer {"action":"reconcile"}
                 compares ETags and queues each difference to the same FIFO
```

- **Re-read, never replay.** A message only names a key. The indexer reads the
  current note and writes what it finds, or deletes the row when the note is
  gone. Duplicate, late or reordered events converge on the current state.
- **One writer.** EventBridge can set only a fixed FIFO message group, so every
  change shares group `index` and a single consumer applies them in order.
  Reconcile and rebuild never write rows; they queue keys to the same group.
  At a few dozen changes a day, serial processing is not a bottleneck.
- **Eventual consistency.** A row normally follows its note within seconds.
  Reconcile repairs anything missed, at most a day later.
- **Invalid notes.** A note that fails its module's schema, or exceeds 256 KiB,
  removes its row and logs `invalid_source`. Reconcile retries it daily until
  the note is fixed.
- **Encryption.** DynamoDB uses its AWS owned key and SQS uses SQS-managed SSE.
  No customer managed KMS key is involved.

## Module declarations

A module opts in by declaring an `IndexedModule` in `src/index-modules/` and
adding it to `indexedModules`. See `src/index-modules/types.ts` for the contract
and `practice-review.ts` for the first declaration:

| Field | Practice review |
|---|---|
| `id` | `practice-review`, table `obsidian-mcp-index-practice-review` |
| `sourcePrefix` | `Learning/Practice/Review/Items/`, flat `<id>.md` notes only |
| `metadata` | id, domain, title, status, review_count, stage, last_review, next_review, archived_on |
| `indexes.queue` | partition `<domain>#<status>`, sort `next_review` (`0000-00-00` when unstarted) |

Prompts, attempt IDs and history stay in the note. Adding a module adds its
table, event filter prefix and IAM grants through the same list, so a new
module needs the foundation update below before its resources deploy.

The rule matches raw S3 keys. Indexed paths use only letters, digits, `/`, `-`
and `.`, so they are identical whether or not a key is URL-encoded. Keep note
prefixes and module folders within that character set.

## Deployment order

Permissions are part of the IAM foundation and follow
[the local SSO procedure](github-actions.md):

1. **Foundation PR.** Adds the `obsidian-mcp-indexer` role, the
   `obsidian-mcp-index-deployment` managed policy for the MCP CloudFormation
   role, `s3:PutBucketNotification` on the vault for the storage role, the MCP
   runtime's read-only `dynamodb:Query` on index GSIs, and the new MCP resource
   types for Plan. After merge, apply the foundation UPDATE with local SSO.
2. **Resources PR.** After the foundation update succeeds: enables EventBridge
   on the vault and adds the table, queues, rules, indexer function, event
   source mapping and alarms. Before approving Apply, confirm the vault has no
   other bucket notifications, because `NotificationConfiguration` replaces the
   whole configuration:

   ```sh
   aws s3api get-bucket-notification-configuration --profile obsidian-admin \
     --bucket obsidian-vault-sync-391824190072
   ```

   An empty response or only `EventBridgeConfiguration` is safe.
3. **Backfill.** After Apply, run one rebuild (below). The table is complete
   when the `rebuild` log's `queued` count has been indexed and the queue is empty.
4. **Read switch.** A later PR moves `practice_reviews` to the GSI and removes
   the S3 scan path. Recovery is a rebuild, not a fallback.

## Operation

Use the `obsidian-admin` SSO profile.

**Rebuild** queues every indexed note:

```sh
aws lambda invoke --profile obsidian-admin --function-name obsidian-mcp-indexer \
  --cli-binary-format raw-in-base64-out --payload '{"action":"rebuild"}' /dev/stdout
```

`{"action":"reconcile"}` queues only differences, exactly like the schedule.

**Dead letters.** A change that fails five times moves to
`obsidian-mcp-index-dlq.fifo` and the `obsidian-mcp-index-dead-letters` alarm
fires. Messages hold only keys, so there is nothing to replay. Read the
indexer's `index_failed` log, fix the cause, then purge and reconcile:

```sh
aws sqs purge-queue --profile obsidian-admin --queue-url \
  "$(aws sqs get-queue-url --profile obsidian-admin --queue-name obsidian-mcp-index-dlq.fifo --query QueueUrl --output text)"
```

Then run the reconcile command above.

**Alarms** are visible in the CloudWatch console and send no notifications:

| Alarm | Meaning |
|---|---|
| `obsidian-mcp-index-dead-letters` | A change reached the dead-letter queue |
| `obsidian-mcp-index-backlog` | The oldest queued change is over 30 minutes old |
| `obsidian-mcp-index-errors` | An indexer or reconcile invocation failed |

Indexer logs are kept for 30 days at `/aws/lambda/obsidian-mcp-indexer`. Each
change logs `indexed`, `removed` or `invalid_source`, and each reconcile logs
source, row and queued counts.

## Cost

On-demand DynamoDB, a FIFO queue, the indexer and the alarms cost well under
one US dollar a month at this volume, mostly the three standard alarms. S3
events to the default event bus are free.
