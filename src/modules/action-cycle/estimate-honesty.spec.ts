import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * What a declared `estimate` is allowed to point at.
 *
 * The field names a GET that prices this action or previews its impact, and the
 * two readers of a proposal both take it at its word: the person deciding is
 * offered "the estimate", and the agent is told — by `ESTIMATE_WITHHELD_NOTE` —
 * that *"this action has a price you cannot see"*.
 *
 * Six declarations pointed at something else entirely: the storage in use, the
 * current billing period, the list of platform components, the list of DNS
 * issuers, the list of certificates. For those, the person clicked through to a
 * list and the agent told its user the action had a price, which was simply
 * untrue. The declarations are gone and each of those routes says what it does
 * through `consequence` instead.
 *
 * Kept as a list with a reason per entry rather than as a shape rule, because
 * no rule can tell a pricing route from a listing route by its path — only by
 * what it answers, which a person has to have read.
 */
const PRICES_OR_PREVIEWS: Record<string, string> = {
  '/infrastructure/clusters/:id/capacity-plan':
    'returns resize candidates with a monthly cost delta',
  '/infrastructure/clusters/:id/nodes/:nodeId/scale/preview':
    'returns the affected workloads and the expected downtime',
};

const controllers = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return controllers(path);
    return entry.name.endsWith('.controller.ts') ? [path] : [];
  });

interface Declaration {
  action: string;
  estimate?: string;
  consequence?: string;
}

function declarations(): Declaration[] {
  const found: Declaration[] = [];
  for (const file of controllers(join(__dirname, '..'))) {
    const source = readFileSync(file, 'utf8');
    for (const block of source.split('@ActionCycle({').slice(1)) {
      const body = block.split('\n  })')[0];
      const action = /action:\s*'([^']+)'/.exec(body);
      if (!action) continue;
      const estimate = /\n\s*estimate:\s*'([^']+)'/.exec(body);
      found.push({
        action: action[1],
        estimate: estimate?.[1],
        // One chunk per declared key, so a consequence spread over concatenated
        // literals is read whole and the field after it is not read as part of
        // it — the same reading `destructive-cycle.spec.ts` does of `sentence`.
        consequence: fieldOf(body, 'consequence'),
      });
    }
  }
  return found;
}

function fieldOf(body: string, key: string): string | undefined {
  const chunk = body
    .split(/\n {4}(?=\w+:)/)
    .find((part) => part.trimStart().startsWith(`${key}:`));
  if (!chunk) return undefined;
  const value = chunk.slice(chunk.indexOf(':') + 1).trim();
  // A declaration may name a shared constant instead of writing the prose
  // inline; then the expression stands in for it, which is enough to say the
  // field is not silent.
  const literals = [...value.matchAll(/'([^']*)'/g)].map((m) => m[1]).join('');
  return literals || value;
}

describe('an estimate points at a price, or it is not an estimate', () => {
  const all = declarations();

  it('read the decorations at all', () => {
    expect(all.length).toBeGreaterThan(20);
  });

  /**
   * The one that would otherwise be silent. A new route copies the decoration
   * off the one above it, keeps its `estimate`, and every proposal it raises
   * tells a person there is a price to read where there is a list.
   */
  it('declares no estimate that is not on the list, and none that is not explained', () => {
    const pointed = [
      ...new Set(all.map((d) => d.estimate).filter(Boolean)),
    ].sort();
    expect(pointed).toEqual(Object.keys(PRICES_OR_PREVIEWS).sort());
    for (const [route, why] of Object.entries(PRICES_OR_PREVIEWS)) {
      expect({ route, why: why.length > 20 }).toEqual({ route, why: true });
    }
  });

  /**
   * Silence here is allowed, and for a stated reason: these fourteen declare a
   * sentence that already carries the effect — "delete application {id} for
   * good, **and the data it holds**", "abort migration {id}, **and tear down
   * the destination**". Adding a `consequence` beside those would be a second
   * copy of one fact, and two copies drift.
   *
   * What the field is for is the other shape, where the sentence names the ask
   * and stops: "create a new cluster at a cloud provider" does not say that
   * servers start being billed, and "enable the firewall of cluster X" does not
   * say that it can shut you out of your own cluster. Twelve carry one now: six
   * that had a false estimate and lost it, and six that had nothing at all.
   *
   * Pinned by name rather than by count so that a new decoration landing silent
   * has to be looked at — and so that closing one of these reddens exactly one
   * line, which is the cheapest possible reminder to delete it from here.
   */
  it('leaves silent only the actions whose sentence already says the effect', () => {
    const silent = all
      .filter((d) => !d.estimate && !d.consequence)
      .map((d) => d.action)
      .sort();

    expect(silent).toEqual([
      'DELETE /app-migrations/:id',
      'DELETE /applications/:id',
      'DELETE /applications/:id/gateway/routes/:endpointId',
      'DELETE /applications/:id/install',
      'DELETE /applications/:id/schedules/:name',
      'DELETE /catalog/installs/:id',
      'DELETE /db-migrations/:id',
      'DELETE /full-migrations/:id',
      'DELETE /operating-context/:id',
      'PATCH /operating-context/:id',
      'POST /app-migrations/:id/destroy-source',
      'POST /full-migrations/:id/destroy-source',
      'POST /operating-context',
      'POST /operating-context/:id/confirm',
    ]);
  });
});

/**
 * The other half of honesty, and the half no machinery can check on its own: a
 * `consequence` is prose, read once by a person immediately before they say
 * yes, and nothing downstream ever compares it with the code.
 *
 * Three of them said something the code does not do — a stop that restores the
 * replica count it never kept, and two migrations that described staging while
 * their own default carries straight on through the cutover. Each case is
 * pinned here against the source that decides it, so that the day the code
 * changes its mind the sentence is looked at rather than left behind.
 */
describe('a consequence says what the code does', () => {
  const all = declarations();
  const consequenceOf = (action: string): string => {
    const decl = all.find((d) => d.action === action);
    expect(decl?.consequence).toBeDefined();
    return decl?.consequence ?? '';
  };
  const sourceOf = (...parts: string[]): string =>
    readFileSync(join(__dirname, '..', ...parts), 'utf8');

  /**
   * `stop()` scales to zero through `applyReplicas`, which persists the zero;
   * `start()` then reads that zero back and floors it at one. An application
   * stopped at three replicas comes back at one, so the sentence must not
   * promise otherwise.
   */
  it('does not promise a stopped application its replica count back', () => {
    const service = sourceOf(
      'applications',
      'services',
      'app-management.service.ts',
    );
    expect(service).toContain(
      'await this.applicationsRepository.update(appId, { replicas });',
    );
    expect(service).toContain('this.applyReplicas(appId, 0)');
    expect(service).toContain('current.replicas > 0 ? current.replicas : 1');

    const stop = consequenceOf('POST /applications/:id/stop');
    expect(stop).toContain('a single replica');
    expect(stop).not.toMatch(/count it had|replica count it/);
  });

  /**
   * `cutover` defaults to AUTO on both migrations and the processors park only
   * on MANUAL, so the default yes to either of these also moves production
   * onto the destination and takes the source out of service.
   */
  it('tells a default migration request that it also cuts over', () => {
    const dbService = sourceOf(
      'db-lifecycle',
      'services',
      'db-migration.service.ts',
    );
    const dbProcessor = sourceOf(
      'db-lifecycle',
      'processors',
      'db-migration.processor.ts',
    );
    expect(dbService).toContain('dto.cutover ?? DbCutoverMode.AUTO');
    expect(dbProcessor).toContain(
      'if (mig.cutoverMode === DbCutoverMode.MANUAL)',
    );

    const db = consequenceOf('POST /db-migrations');
    expect(db).toContain('manual cutover');
    expect(db).toContain('without asking again');

    const fullService = sourceOf(
      'full-migration',
      'services',
      'full-migration.service.ts',
    );
    const fullProcessor = sourceOf(
      'full-migration',
      'processors',
      'full-migration.processor.ts',
    );
    expect(fullService).toContain('dto.cutover ?? FullCutoverMode.AUTO');
    expect(fullProcessor).toContain(
      'if (fm.cutoverMode === FullCutoverMode.MANUAL)',
    );

    const full = consequenceOf('POST /full-migrations');
    expect(full).toContain('manual cutover');
    expect(full).toContain('without asking again');
  });

  /**
   * Restore mode takes a PITR copy out of the backup repository: no replication
   * link is opened and nothing is repointed at the copy, so a sentence that
   * says the new database is kept in step with the live one is false for half
   * the modes this route advertises.
   */
  it('does not claim a restore is kept in step with the live database', () => {
    const processor = sourceOf(
      'db-lifecycle',
      'processors',
      'db-migration.processor.ts',
    );
    expect(processor).toContain('if (mig.mode === DbMigrationMode.RESTORE)');
    expect(processor).toContain('await this.runRestoreMode(mig)');

    const db = consequenceOf('POST /db-migrations');
    expect(db).toContain('restore-mode');
    expect(db).not.toContain('kept in step with the live one');
  });
});
