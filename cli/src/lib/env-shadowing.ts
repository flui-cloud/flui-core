import * as fs from 'node:fs';

/**
 * The API loads `['.env.local', '.env']` and the first file wins, so a key
 * present in both never takes the value written to `.env`.
 *
 * Nothing keeps the two files in agreement, and the failure is silent: the
 * export reports success, the file on disk really did change, and the running
 * API goes on reading the other one. A provider URL pointing at a decommissioned
 * instance survived several correct exports that way.
 */
export function findShadowedKeys(
  envLocalPath: string,
  writtenKeys: readonly string[],
): string[] {
  if (!fs.existsSync(envLocalPath)) return [];

  const defined = readDefinedKeys(envLocalPath);
  return writtenKeys.filter((key) => defined.has(key));
}

function readDefinedKeys(filePath: string): Set<string> {
  const keys = new Set<string>();
  for (const raw of fs.readFileSync(filePath, 'utf-8').split('\n')) {
    const line = raw.trim();
    // A comment is not an assignment, and a line with no `=` is not either.
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator === -1) continue;
    // `export FOO=bar` is a valid line in these files and names the same key.
    const name = line
      .slice(0, separator)
      .replace(/^export\s+/, '')
      .trim();
    if (name) keys.add(name);
  }
  return keys;
}
