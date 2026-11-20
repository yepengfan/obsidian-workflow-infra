import { AthenaClient, GetQueryExecutionCommand, GetQueryResultsCommand, StartQueryExecutionCommand } from '@aws-sdk/client-athena';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, it, vi } from 'vitest';
import { AthenaMetadataQuery, inventorySql } from '../src/athena.js';
import { createFetchHandler } from '../src/handler.js';
import { METADATA_WORKGROUP, MetadataSearch, metadataInput, type MetadataLookup, type MetadataQuery } from '../src/metadata-search.js';
import { metadataSkill } from '../src/metadata-tools.js';
import { decodeCursor, encodeCursor } from '../src/paths.js';
import { z } from 'zod';
import { MemoryStore, owner, runtimeSettings } from './runtime-fixtures.js';

const id = '11111111-1111-4111-8111-111111111111';
const row = (key = 'Vault/Nested/Plan.md') => ({ key, size: 100, modified: '2026-11-17T01:00:00.000Z' });

it('discovers nested metadata through the real MCP client, resumes a pending query, and reads only the selected note', async () => {
  const settings = runtimeSettings(), store = new MemoryStore();
  store.files.set('Vault/Nested/Plan.md', 'Selected note');
  const executions: (string | undefined)[] = [];
  const query: MetadataQuery = { search: async (_lookup, queryId) => {
    executions.push(queryId);
    return queryId ? { state: 'complete', rows: [row()], scannedBytes: 2048 } : { state: 'pending', queryId: id };
  } };
  const handler = createFetchHandler(settings, { store, verify: async () => owner, skills: [metadataSkill(settings, query)] });
  const client = new Client({ name: 'metadata-e2e', version: '1' }); client.onerror = () => {};
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(settings.resource), { fetch: (input, init) => handler(new Request(input, init)) }));
    expect((await client.listTools()).tools.map(tool => tool.name)).toContain('search_note_metadata');
    const first = await client.callTool({ name: 'search_note_metadata', arguments: { query: 'Plan' } });
    expect(first.structuredContent).toMatchObject({ state: 'pending', complete: false, notes: [] });
    const second = await client.callTool({ name: 'search_note_metadata', arguments: { query: 'Plan', cursor: (first.structuredContent as { nextCursor: string }).nextCursor } });
    expect(second.structuredContent).toMatchObject({ state: 'complete', complete: true, notes: [{ path: 'Nested/Plan.md', size: 100 }], source: 's3_metadata_inventory' });
    expect(executions).toEqual([undefined, id]); expect(store.calls).toHaveLength(0);
    const read = await client.callTool({ name: 'read_note', arguments: { path: 'Nested/Plan.md' } });
    expect(read.structuredContent).toMatchObject({ text: 'Selected note' });
    expect(store.calls.map(call => call.kind)).toEqual(['read']);
  } finally { await client.close(); }
});

it('binds cursors to owner, filters and prefix, and advances by the last returned path', async () => {
  const lookups: MetadataLookup[] = [];
  const query: MetadataQuery = { search: async lookup => { lookups.push(lookup); return { state: 'complete', rows: [row('Vault/a.md'), row('Vault/b.md')], scannedBytes: 1 }; } };
  const settings = runtimeSettings();
  const search = new MetadataSearch(query, settings), signal = AbortSignal.timeout(1000);
  const input = metadataInput.parse({ limit: 1 });
  const result = await search.search(input, owner, signal);
  expect(result).toMatchObject({ complete: false, notes: [{ path: 'a.md' }] });
  const checkpoint = decodeCursor(result.nextCursor!, z.object({ after: z.string() })); expect(checkpoint.after).toBe('Vault/a.md');
  for (const [candidate, user] of [[{ ...input, query: 'changed' }, owner], [input, 'other-owner']] as const) {
    await expect(search.search({ ...candidate, cursor: result.nextCursor }, user, signal)).rejects.toThrow('invalid_cursor');
  }
  await expect(new MetadataSearch(query, { ...settings, prefix: 'Other/' }).search({ ...input, cursor: result.nextCursor }, owner, signal)).rejects.toThrow('invalid_cursor');
  expect(lookups).toHaveLength(1);
});

it('escapes literal search input, ranks current versions before filtering, and normalizes UTC dates', async () => {
  let sql = '';
  const query: MetadataQuery = { search: async lookup => { sql = inventorySql(lookup); return { state: 'complete', rows: [], scannedBytes: 0 }; } };
  await new MetadataSearch(query, runtimeSettings()).search(metadataInput.parse({ query: "O'Reilly_%", folder: "Team's", minSize: 12, maxSize: 999,
    modifiedAfter: '2026-11-17T12:00:00+10:00', modifiedBefore: '2026-11-18T00:00:00Z' }), owner, AbortSignal.timeout(1000));
  expect(sql).toContain("starts_with(key, 'Vault/Team''s/')");
  expect(sql).toContain("lower('O''Reilly_%')");
  expect(sql).toContain('ROW_NUMBER() OVER (PARTITION BY key ORDER BY sequence_number DESC)');
  const outer = sql.indexOf('FROM current_objects WHERE');
  for (const predicate of ['NOT COALESCE(is_delete_marker, FALSE)', 'size >= 12', 'size <= 999', "last_modified_date >= TIMESTAMP '2026-11-17 02:00:00.000'"]) expect(sql.indexOf(predicate)).toBeGreaterThan(outer);
});

it.each(['Outside/secret.md', 'Vault/../secret.md', 'Vault/secret.txt'])('rejects malformed or outside-vault adapter rows: %s', async key => {
  const query: MetadataQuery = { search: async () => ({ state: 'complete', rows: [row(key)], scannedBytes: 0 }) };
  await expect(new MetadataSearch(query, runtimeSettings()).search(metadataInput.parse({}), owner, AbortSignal.timeout(1000))).rejects.toThrow();
});

it('uses one Athena execution and verifies query ownership before reading results', async () => {
  const commands: unknown[] = [];
  const client = { send: async (command: unknown) => {
    commands.push(command);
    if (command instanceof StartQueryExecutionCommand) return { QueryExecutionId: id };
    if (command instanceof GetQueryExecutionCommand) return { QueryExecution: { WorkGroup: METADATA_WORKGROUP, Query: 'SELECT expected', Status: { State: 'SUCCEEDED' }, Statistics: { DataScannedInBytes: 20 } } };
    if (command instanceof GetQueryResultsCommand) return { ResultSet: { Rows: [{ Data: [{ VarCharValue: 'key' }] }, { Data: ['Vault/a.md', '10', '2026-11-17T00:00:00.000'].map(VarCharValue => ({ VarCharValue })) }] } };
    throw Error('Unexpected command');
  } } as unknown as AthenaClient;
  const adapter = new AthenaMetadataQuery(client), signal = AbortSignal.timeout(1000);
  expect(await adapter.run('SELECT expected', 21, undefined, signal)).toMatchObject({ state: 'complete', rows: [{ key: 'Vault/a.md', size: 10, modified: '2026-11-17T00:00:00.000Z' }], scannedBytes: 20 });
  expect((commands[0] as StartQueryExecutionCommand).input).toEqual({ QueryString: 'SELECT expected', WorkGroup: METADATA_WORKGROUP });
  commands.length = 0;
  await expect(adapter.run('SELECT other-owner', 21, id, signal)).rejects.toThrow('invalid_cursor');
  expect(commands).toHaveLength(1); expect(commands[0]).toBeInstanceOf(GetQueryExecutionCommand);
});

it('returns a continuation for slow queries rather than starting another scan', async () => {
  vi.useFakeTimers();
  try {
    const send = vi.fn(async () => ({ QueryExecution: { WorkGroup: METADATA_WORKGROUP, Query: 'SELECT expected', Status: { State: 'RUNNING' } } }));
    const pending = new AthenaMetadataQuery({ send } as unknown as AthenaClient).run('SELECT expected', 21, id, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1250);
    expect(await pending).toEqual({ state: 'pending', queryId: id });
    expect(send.mock.calls.length).toBeLessThanOrEqual(6);
  } finally { vi.useRealTimers(); }
});

it('rejects invalid ranges and expired/cancelled executions without exposing Athena errors', async () => {
  expect(metadataInput.safeParse({ minSize: 10, maxSize: 1 }).success).toBe(false);
  expect(metadataInput.safeParse({ modifiedAfter: '2026-11-18T00:00:00Z', modifiedBefore: '2026-11-17T00:00:00Z' }).success).toBe(false);
  for (const state of ['CANCELLED', 'FAILED']) {
    const client = { send: async () => ({ QueryExecution: { WorkGroup: METADATA_WORKGROUP, Query: 'SELECT expected', Status: { State: state } } }) } as unknown as AthenaClient;
    await expect(new AthenaMetadataQuery(client).run('SELECT expected', 21, id, new AbortController().signal)).rejects.toThrow('note_unavailable');
  }
  // Client-edited execution IDs must retain the cursor schema contract.
  const query: MetadataQuery = { search: async () => ({ state: 'pending', queryId: id }) };
  await expect(new MetadataSearch(query, runtimeSettings()).search(metadataInput.parse({ cursor: encodeCursor({ v: 1, context: 'wrong', queryId: id }) }), owner, new AbortController().signal)).rejects.toThrow('invalid_cursor');
});
