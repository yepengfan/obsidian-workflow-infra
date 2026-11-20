import { parseDocument } from 'yaml';

/** Splits a Markdown note into a YAML mapping and its body, or undefined when malformed. */
export function parseFrontmatter(value: string): { metadata: Record<string, unknown>; body: string } | undefined {
  const match = value.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u);
  if (!match) return undefined;
  const document = parseDocument(match[1]!, { uniqueKeys: true });
  if (document.errors.length) return undefined;
  const data: unknown = document.toJS({ maxAliasCount: 20 });
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  return { metadata: data as Record<string, unknown>, body: match[2]! };
}
