import { z } from 'zod';
import type { Settings } from './config.js';
import { MetadataSearch, metadataInput, type MetadataQuery } from './metadata-search.js';
import { readToolSecurity, type McpSkill } from './skill.js';

export function metadataSkill(settings: Settings, query: MetadataQuery): McpSkill {
  const search = new MetadataSearch(query, settings);
  return {
    instructions: 'Use search_note_metadata for explicit filename/path, date or size discovery across the configured vault or a chosen folder and its descendants. This queries S3 Metadata, never note bodies. Inventory can lag about an hour. If pending, continue with the same filters and nextCursor; do not start a duplicate search. Read selected results with read_note.',
    scopes: [],
    register: ({ server, owner, signal, result }) => {
      server.registerTool('search_note_metadata', {
        description: 'Search Markdown file metadata across an explicit folder and descendants using Athena over S3 Metadata. Matches literal path text; optional inclusive UTC modification-date and byte-size ranges. Results sort by path. No note content or frontmatter search. A pending result has no matches yet; resume unchanged filters with nextCursor. Inventory is eventually consistent, typically within one hour.',
        ...readToolSecurity(settings),
        inputSchema: metadataInput,
        outputSchema: z.object({ folder: z.string(), scope: z.literal('descendants'), source: z.literal('s3_metadata_inventory'),
          freshness: z.string(), state: z.enum(['pending', 'complete']), complete: z.boolean(), nextCursor: z.string().optional(), scannedBytes: z.number().optional(),
          notes: z.array(z.object({ path: z.string(), size: z.number(), modified: z.string() })) }),
      }, input => result(() => search.search(input, owner, signal)));
    },
  };
}
