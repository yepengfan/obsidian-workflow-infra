import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, it } from 'vitest';
import { createFetchHandler } from '../src/handler.js';
import { MemoryStore, owner, runtimeSettings } from './runtime-fixtures.js';

it('exports tool patterns that non-JavaScript metadata validators can compile', async () => {
  const settings = runtimeSettings({ practice: { enabled: true, writesEnabled: true, timeZone: 'Australia/Brisbane' } });
  const store = new MemoryStore();
  const handler = createFetchHandler(settings, { store, verify: async () => owner });
  const client = new Client({ name: 'refresh-schema-test', version: '1' });
  client.onerror = () => {};
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(settings.resource), {
      fetch: (input, init) => handler(new Request(input, init)),
    }));
    const { tools } = await client.listTools();
    expect(tools.some(tool => tool.name === 'practice_design_template')).toBe(true);
    // Python's standard regex engine reproduces the rejected Unicode property
    // escapes without adding a runtime or third-party validation dependency.
    execFileSync('python3', ['-c', `
import json, re, sys
def check(schema, path):
    if isinstance(schema, dict):
        if isinstance(schema.get("pattern"), str):
            try:
                re.compile(schema["pattern"])
            except re.error as error:
                raise ValueError(path + ": " + str(error)) from error
        for key, value in schema.items():
            check(value, path + "." + key)
    elif isinstance(schema, list):
        for index, value in enumerate(schema):
            check(value, path + "[" + str(index) + "]")
for tool in json.load(sys.stdin):
    for field in ("inputSchema", "outputSchema"):
        check(tool.get(field), tool["name"] + "." + field)
`], { input: JSON.stringify(tools), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    for (const short_topic of ['../escape', 'Bad/Name']) {
      const result = await client.callTool({ name: 'practice_design_template', arguments: { topic: 'Design a cache', short_topic } });
      expect(result.isError).toBe(true);
    }
    expect(store.calls).toHaveLength(0);
  } finally { await client.close(); }
});
