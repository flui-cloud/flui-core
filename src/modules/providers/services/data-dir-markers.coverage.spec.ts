/**
 * The client library ships ESM and this project's jest transforms only `jose`.
 * Nothing here reaches it — only the marker table is read.
 */
jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {},
  KubernetesObjectApi: { makeApiClient: () => ({}) },
  PatchStrategy: { MergePatch: 'application/merge-patch+json' },
}));

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROBEABLE_ENGINES } from './volume-export.service';

/**
 * The probe's marker table and the catalog's `engine:` declarations are two
 * lists that must agree, maintained in different files by different pieces of
 * work. Nothing else notices when they drift, and an engine the table does not
 * know is copied live while the ledger records "no data directory found" —
 * which is the shape of answer that looks correct.
 *
 * Adding a marker is cheap; discovering a missing one during a recovery is not.
 * A failure here means an engine can be installed whose data Flui cannot
 * recognise, and the fix is either a marker or an entry below saying why it
 * needs none.
 */
const SEED_DIR = join(__dirname, '..', '..', 'catalog', 'seed');

/**
 * Engines that legitimately need no marker, each with the reason.
 *
 * An entry here is a claim about the engine, not a way to silence the test:
 * it says the probe would have nothing useful to find, so a live copy of that
 * volume cannot mislead anyone.
 */
const NO_MARKER_NEEDED: Record<string, string> = {
  memcached: 'holds nothing on disk — there is no persistence to tear',
  ferretdb:
    'stores its data in a Postgres it composes with, so the volume that matters is that Postgres one and carries PG_VERSION',
};

function declaredEngines(): Set<string> {
  const engines = new Set<string>();
  for (const file of readdirSync(SEED_DIR)) {
    if (!file.endsWith('.flui.yaml')) continue;
    const text = readFileSync(join(SEED_DIR, file), 'utf-8');
    for (const line of text.split('\n')) {
      const match = /^\s+engine:\s*([a-z0-9-]+)\s*$/.exec(line);
      if (match) engines.add(match[1]);
    }
  }
  return engines;
}

describe('the probe recognises every engine the catalog can install', () => {
  it('has a marker, or a stated reason for having none', () => {
    const declared = [...declaredEngines()].sort();
    expect(declared.length).toBeGreaterThan(5);

    const unrecognised = declared.filter(
      (engine) =>
        !PROBEABLE_ENGINES.has(engine) && !(engine in NO_MARKER_NEEDED),
    );

    expect(unrecognised).toEqual([]);
  });

  it('does not carry exemptions for engines nobody installs any more', () => {
    const declared = declaredEngines();
    const stale = Object.keys(NO_MARKER_NEEDED).filter(
      (engine) => !declared.has(engine),
    );

    // An exemption outliving its engine is a claim nobody is checking.
    expect(stale).toEqual([]);
  });
});
