jest.mock('@kubernetes/client-node', () => ({}));

import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { getMetadataArgsStorage } from 'typeorm';
import { entities } from './entities';

function entityFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return entityFiles(path);
    return name.endsWith('.entity.ts') ? [path] : [];
  });
}

// A class decorated with @Entity but missing here boots fine and then fails at
// the first query with "No metadata for X was found".
const KNOWN_UNREGISTERED = [
  'DeploymentEntity',
  'BuildLogEntity',
  'FrameworkTemplateEntity',
  'InstanceEntity',
];

describe('entities', () => {
  it('registers every @Entity class under src/modules', async () => {
    for (const file of entityFiles(join(__dirname, '..', 'modules'))) {
      await import(file);
    }
    const registered = new Set<unknown>(entities as unknown[]);
    const missing = getMetadataArgsStorage()
      .tables.filter(
        (t) => t.type === 'regular' && typeof t.target === 'function',
      )
      .map((t) => t.target as { name: string })
      .filter((target) => !registered.has(target))
      .map((target) => target.name)
      .filter((name) => !KNOWN_UNREGISTERED.includes(name));
    expect(missing).toEqual([]);
  });
});
