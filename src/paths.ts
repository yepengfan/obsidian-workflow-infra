const forbidden = /[\\%*?$]/u;

export const hasControlChars = (value: string) => [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

export function validatePath(path: string): string {
  if (!path || Buffer.byteLength(path) > 512 || hasControlChars(path) || forbidden.test(path) ||
      path.split('/').some((part) => !part || part.startsWith('.') || part.includes(':'))) {
    throw new Error('Invalid vault-relative path');
  }
  return path;
}

export function normalizePrefix(prefix: string): string {
  if (prefix === '') return '';
  return `${validatePath(prefix.replace(/\/$/u, ''))}/`;
}

export function notePath(path: string): string {
  validatePath(path);
  if (!/\.(md|markdown)$/iu.test(path)) throw new Error('Only Markdown notes are readable');
  return path;
}
