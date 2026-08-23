import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * The red line under the conversion of the `@Admin()` sites.
 *
 * `@Admin()` reads a boolean; every gate that could name a permission or a
 * section now does. What is left is not a leftover — it is one group that was
 * deliberately not moved, with its reason written next to it. This test lists
 * it by name, so putting the boolean back on a route (or adding a new route
 * behind it) turns red and asks for a decision instead of quietly growing the
 * surface back.
 */
const SRC = join(__dirname, '..', '..');

/**
 * Every `@Admin()` mark left in the tree, by file, and why it is still there.
 *
 * Marks, not routes: `BrandingController` carries its one at class level. Today
 * the two numbers happen to agree — six marks, six routes — because that class
 * has a single route.
 *
 * The two `DELETE` routes of the repositories controller used to be listed here
 * as a second group. They are gone rather than converted: the question they
 * asked was "is this repository yours", the service already answers it with a
 * 404, and the admin gate on top only refused the owner.
 *
 * The two cluster-wide log reads were a third group, and they are gone too —
 * converted rather than removed. They now carry `@RequireSection(infrastructure)`,
 * and `flui app logs` no longer calls them at all: it goes to
 * `GET /observability/applications/:id/logs`, which asks whose application it
 * is. The two halves had to land together, which is why they waited.
 */
const STILL_ON_THE_BOOLEAN: Record<string, number> = {
  // Installation bootstrap — six routes. They move together with the split of
  // the two installation credentials; applying `platform:bootstrap` to them
  // alone stops `flui env create` halfway through provisioning.
  'modules/auth/controllers/auth.controller.ts': 4,
  'modules/auth/controllers/branding.controller.ts': 1,
  'modules/access/controllers/ca.controller.ts': 1,
};

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...tsFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

function countAdminMarks(): Record<string, number> {
  const found: Record<string, number> = {};
  for (const file of tsFiles(join(SRC, 'modules'))) {
    const body = readFileSync(file, 'utf8');
    const marks = body
      .split('\n')
      .filter((line) => line.trim() === '@Admin()').length;
    if (marks > 0) {
      found[file.slice(SRC.length + 1).replace(/\\/g, '/')] = marks;
    }
  }
  return found;
}

describe('what is still gated on the platform-admin boolean', () => {
  it('is exactly the one group that was deliberately left behind', () => {
    expect(countAdminMarks()).toEqual(STILL_ON_THE_BOOLEAN);
  });

  /**
   * `AdminGuard` only enforces where `@Admin()` marks the route — its first line
   * is `if (!requireAdmin) return true`. A controller that imports the guard and
   * no longer marks anything is therefore carrying decoration that always says
   * yes, which is how five routes ended up looking guarded and answering to
   * everybody.
   */
  it('leaves no controller importing AdminGuard without marking a route', () => {
    const marks = countAdminMarks();
    const decorative: string[] = [];
    for (const file of tsFiles(join(SRC, 'modules'))) {
      const rel = file.slice(SRC.length + 1).replace(/\\/g, '/');
      if (!readFileSync(file, 'utf8').includes('AdminGuard')) continue;
      if (rel.endsWith('guards/admin.guard.ts')) continue;
      if (rel.endsWith('auth.module.ts')) continue;
      if (!rel.includes('controller')) continue;
      if (!marks[rel]) decorative.push(rel);
    }
    expect(decorative).toEqual([]);
  });
});
