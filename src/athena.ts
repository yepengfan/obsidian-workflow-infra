import { AthenaClient, GetQueryExecutionCommand, GetQueryResultsCommand, StartQueryExecutionCommand } from '@aws-sdk/client-athena';
import { setTimeout as delay } from 'node:timers/promises';
import { METADATA_WORKGROUP, type MetadataQuery } from './metadata-search.js';
import { NoteError } from './paths.js';

/** Runs only fixed application-generated SELECTs in the dedicated workgroup. */
export class AthenaMetadataQuery implements MetadataQuery {
  constructor(private readonly client: AthenaClient) {}
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
