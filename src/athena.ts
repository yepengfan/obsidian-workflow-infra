import { AthenaClient, GetQueryExecutionCommand, GetQueryResultsCommand, StartQueryExecutionCommand } from '@aws-sdk/client-athena';
import { setTimeout as delay } from 'node:timers/promises';
import { METADATA_CATALOG, METADATA_WORKGROUP, type MetadataLookup, type MetadataQuery } from './metadata-search.js';
import { NoteError } from './paths.js';

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const timestamp = (value: string) => `TIMESTAMP ${literal(new Date(value).toISOString().replace('T', ' ').replace('Z', ''))}`;

export function inventorySql({ bucket, vaultPrefix, folderPrefix, filters, context, after }: MetadataLookup) {
  // Rank versions BEFORE applying size/date/delete filters: an older matching
  // version must not resurrect a changed or deleted current note.
  const conditions = ["version_rank = 1", 'NOT COALESCE(is_delete_marker, FALSE)', 'size IS NOT NULL', 'last_modified_date IS NOT NULL', "ends_with(lower(key), '.md')",
    `strpos(lower(substr(key, ${Array.from(vaultPrefix).length + 1})), lower(${literal(filters.query)})) > 0`];
  if (filters.minSize !== undefined) conditions.push(`size >= ${filters.minSize}`);
  if (filters.maxSize !== undefined) conditions.push(`size <= ${filters.maxSize}`);
  if (filters.modifiedAfter) conditions.push(`last_modified_date >= ${timestamp(filters.modifiedAfter)}`);
  if (filters.modifiedBefore) conditions.push(`last_modified_date <= ${timestamp(filters.modifiedBefore)}`);
  if (after) conditions.push(`key > ${literal(after)}`);
  const database = `b_${bucket}`.replaceAll('"', '""');
  return `-- MCP metadata ${context}\nWITH current_objects AS (
  SELECT key, size, last_modified_date, is_delete_marker,
    ROW_NUMBER() OVER (PARTITION BY key ORDER BY sequence_number DESC) AS version_rank
  FROM "${METADATA_CATALOG}"."${database}"."inventory"
  WHERE bucket = ${literal(bucket)} AND starts_with(key, ${literal(folderPrefix)})
)
SELECT key, CAST(size AS varchar), to_iso8601(last_modified_date)
FROM current_objects WHERE ${conditions.join(' AND ')}
ORDER BY key ASC LIMIT ${filters.limit + 1}`;
}

export class AthenaMetadataQuery implements MetadataQuery {
  constructor(private readonly client: AthenaClient) {}
  search(lookup: MetadataLookup, queryId: string | undefined, signal: AbortSignal) {
    return this.run(inventorySql(lookup), lookup.filters.limit + 1, queryId, signal);
  }

  async run(sql: string, limit: number, queryId: string | undefined, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!queryId) {
      const started = await this.client.send(new StartQueryExecutionCommand({ QueryString: sql, WorkGroup: METADATA_WORKGROUP }), { abortSignal: signal });
      queryId = started.QueryExecutionId;
      if (!queryId) throw new NoteError('note_unavailable');
    }
    // Do not make MCP wait for a long Athena query. Return its cursor and let
    // another stateless request resume the same execution without another scan.
    const waitUntil = Date.now() + 1000;
    while (true) {
      const response = await this.client.send(new GetQueryExecutionCommand({ QueryExecutionId: queryId }), { abortSignal: signal });
      const execution = response.QueryExecution;
      // A cursor is not a credential. Verify the saved query against this owner,
      // vault, filters and workgroup before exposing any results.
      if (execution?.WorkGroup !== METADATA_WORKGROUP || execution.Query !== sql) throw new NoteError('invalid_cursor');
      if (execution.Status?.State === 'SUCCEEDED') {
        const result = await this.client.send(new GetQueryResultsCommand({ QueryExecutionId: queryId, MaxResults: limit + 1 }), { abortSignal: signal });
        if (result.NextToken) throw new NoteError('note_unavailable');
        const rows = result.ResultSet?.Rows;
        if (!rows?.length) throw new NoteError('note_unavailable');
        return { state: 'complete' as const, rows: rows.slice(1).map(row => {
          const [key, size, modified] = (row.Data ?? []).map(value => value.VarCharValue);
          if (row.Data?.length !== 3 || key === undefined || !/^\d+$/u.test(size ?? '') || !modified) throw new NoteError('note_unavailable');
          return { key, size: Number(size), modified: modified.endsWith('Z') ? modified : `${modified}Z` };
        }), scannedBytes: execution.Statistics?.DataScannedInBytes ?? 0 };
      }
      if (execution.Status?.State !== 'QUEUED' && execution.Status?.State !== 'RUNNING') throw new NoteError('note_unavailable');
      if (Date.now() >= waitUntil) return { state: 'pending' as const, queryId };
      await delay(250, undefined, { signal });
    }
  }
}

export const createMetadataQuery = (region: string): MetadataQuery => new AthenaMetadataQuery(new AthenaClient({ region, maxAttempts: 2 }));
