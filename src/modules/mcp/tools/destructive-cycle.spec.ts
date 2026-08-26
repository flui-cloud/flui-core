import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { ALL_TOOLS } from './tool-registry';
import { MCP_SCOPE, SCOPE_TIER } from '../constants/mcp-scopes';
import { ActionCycleService } from '../../action-cycle/action-cycle.service';
import { ActionCycleDecl } from '../../action-cycle/action-cycle.decorator';
import {
  ACTION_PROPOSAL_CODE,
  PROPOSAL_DECISION,
  argsDigest,
  bindingOf,
} from '../../action-cycle/action-cycle.core';
import { ActionProposalEntity } from '../../action-cycle/entities/action-proposal.entity';

/**
 * **Every act this product already calls destructive goes through the action
 * cycle, and the list of them is not written here.**
 *
 * The marking reused is the one that already exists: a tool's scope sits in the
 * `destructive` tier of `SCOPE_TIER`, which is what `MCP_ALLOW_DESTRUCTIVE`
 * gates and what the agent contract pins. Deriving the set from it rather than
 * listing it means a destructive tool added tomorrow arrives already inside
 * this assertion — and a second hand-kept list of "what counts as destroying
 * something" never comes into existence.
 *
 * The cut is deliberately narrower than "writes": restarting, stopping,
 * starting, scaling, installing and connecting a repository are not here, and
 * the last block below pins their absence so that widening the cut has to be a
 * decision somebody takes out loud.
 */

const MODULES = join(__dirname, '..', '..');

function controllerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...controllerFiles(full));
    else if (entry.endsWith('.controller.ts')) out.push(full);
  }
  return out;
}

interface Declared {
  action: string;
  bind: string[];
  sentence: string;
}

/**
 * Every `@ActionCycle` in the tree, read as text — the same second parser
 * `infrastructure-operations.tools.spec.ts` uses, and allowed to be one for the
 * same reason: importing the controllers drags the Kubernetes client in, and
 * what is being asked is what is *written* on the handler.
 */
function declarations(): Map<string, Declared> {
  const found = new Map<string, Declared>();
  for (const file of controllerFiles(MODULES)) {
    const source = readFileSync(file, 'utf8');
    for (const rest of source.split('@ActionCycle({').slice(1)) {
      const block = rest.slice(0, rest.indexOf('\n  })'));
      const action = /action:\s*\n?\s*'([^']+)'/.exec(block)?.[1];
      if (!action) continue;
      const bindList = /bind:\s*\[([^\]]*)\]/.exec(block)?.[1] ?? '';
      // One chunk per declared key, so a sentence spread over concatenated
      // literals is read whole and an `estimate` after it is not read as part
      // of it.
      const chunks = block.split(/\n {4}(?=\w+:)/);
      const sentence = chunks.find((c) =>
        c.trimStart().startsWith('sentence:'),
      );
      found.set(action, {
        action,
        bind: [...bindList.matchAll(/'([^']+)'/g)].map((m) => m[1]),
        sentence: [...(sentence ?? '').matchAll(/'([^']*)'/g)]
          .map((m) => m[1])
          .join(''),
      });
    }
  }
  return found;
}

const CYCLED = declarations();

const destructiveTools = ALL_TOOLS.filter(
  (tool) => SCOPE_TIER[tool.scope] === 'destructive',
);

describe('destroying something on an application waits for a person', () => {
  it('found the two halves at all, so an empty set cannot pass silently', () => {
    expect(destructiveTools.length).toBeGreaterThanOrEqual(7);
    expect(CYCLED.size).toBeGreaterThan(20);
  });

  it('sends every route of every destructive tool into the cycle', () => {
    const outside: string[] = [];
    for (const tool of destructiveTools) {
      for (const route of tool.routes ?? []) {
        if (!CYCLED.has(route)) outside.push(`${tool.name} → ${route}`);
      }
    }
    expect(outside.sort()).toEqual([]);
  });

  /**
   * A destructive tool that declares no route at all would satisfy the
   * assertion above with an empty loop — the same silence the sandbox filter
   * treats as "no".
   */
  it('leaves no destructive tool without a route to be measured against', () => {
    expect(
      destructiveTools.filter((t) => !t.routes?.length).map((t) => t.name),
    ).toEqual([]);
  });

  /**
   * The doors that reach the same act without going through a tool.
   *
   * `DELETE /applications/:id` is "remove exactly this application" and
   * `DELETE /catalog/installs/:id` is the install-id door onto the act
   * `DELETE /applications/:id/install` performs — the catalog controller says
   * so in its own words, having already been bitten once by the two not being
   * guarded alike. `mcp:app:destructive` allows `app:delete`, which is what all
   * three ask for, so an agent key holds every one of them: decorating only the
   * route a tool happens to call would have left two open doors onto the same
   * deletion.
   */
  it.each(['DELETE /applications/:id', 'DELETE /catalog/installs/:id'])(
    '%s is inside too, being the same act by another door',
    (action) => {
      expect(CYCLED.has(action)).toBe(true);
    },
  );

  /**
   * The property the round turns on, and the reason none of these declarations
   * omits `bind` — see the digest block below for what omitting it would do.
   */
  it('binds every parameter its own route pattern carries', () => {
    const unbound: string[] = [];
    for (const route of destructiveRoutes()) {
      const decl = CYCLED.get(route) as Declared;
      const params = [...route.matchAll(/:(\w+)/g)].map((m) => m[1]);
      const missing = params.filter((p) => !decl.bind.includes(p));
      if (missing.length) unbound.push(`${route} misses ${missing.join()}`);
    }
    expect(unbound.sort()).toEqual([]);
  });

  /**
   * The sentence is stored verbatim and read back months later, so it is asked
   * to be prose: no route pattern, no HTTP verb, and every `{param}` it names
   * actually filled from the binding — an unbound placeholder reaches a person
   * as the literal characters `{id}`.
   */
  it('says what it does in words a person can read', () => {
    for (const route of destructiveRoutes()) {
      const decl = CYCLED.get(route);
      expect(decl).toBeDefined();
      const sentence = decl?.sentence ?? '';
      expect(sentence.length).toBeGreaterThan(20);
      expect(sentence).not.toMatch(/DELETE |POST |\/applications|\/catalog/);
      for (const [, key] of sentence.matchAll(/\{(\w+)\}/g)) {
        expect({ route, key, bound: decl?.bind.includes(key) }).toEqual({
          route,
          key,
          bound: true,
        });
      }
    }
  });
});

function destructiveRoutes(): string[] {
  return [
    ...new Set([
      ...destructiveTools.flatMap((t) => t.routes ?? []),
      'DELETE /applications/:id',
      'DELETE /catalog/installs/:id',
    ]),
  ].filter((route) => CYCLED.has(route));
}

/**
 * Why every declaration above binds, stated as a fact about the machinery
 * rather than as a preference.
 *
 * `bind` reads as a question about *offering "always"* — the decorator's own
 * words are that a request which cannot state its edge is "only ever offered
 * allow once", which sounds like the safe side. It is also, and silently, what
 * gives an attempt its identity: the proposal is upserted on
 * `argsDigest(shape, binding, body)`, and a `DELETE` carries no body. So on a
 * parameterised route an unbound declaration gives *every resource the same
 * digest*, and the "allow once" a person granted for one application is spent
 * by the next call naming another.
 */
describe('an approval is about one resource, and binding is what makes it so', () => {
  const shape = 'DELETE /applications/:id/install';
  const A = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
  const B = { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' };

  it('collapses two different applications onto one question when unbound', () => {
    expect(argsDigest(shape, bindingOf(undefined, A), {})).toBe(
      argsDigest(shape, bindingOf(undefined, B), {}),
    );
  });

  it('tells them apart once the declaration binds the parameter', () => {
    expect(argsDigest(shape, bindingOf(['id'], A), {})).not.toBe(
      argsDigest(shape, bindingOf(['id'], B), {}),
    );
  });

  it('spends an unbound "allow once" on an application it was never about', async () => {
    const { service, proposals } = cycle();
    const decl: ActionCycleDecl = {
      action: shape,
      sentence: 'remove an application and the data it holds',
    };
    const raised = await refusal(service, decl, A);
    await service.decideProposal(raised, 'owner', PROPOSAL_DECISION.ONCE);

    // Same declaration, a different application, and no refusal at all.
    await expect(service.authorize(attempt(decl, B))).resolves.toBeDefined();
    expect(proposals.rows).toHaveLength(1);
  });

  it('raises a second question for the second application when bound', async () => {
    const { service, proposals } = cycle();
    const decl: ActionCycleDecl = {
      action: shape,
      bind: ['id'],
      sentence: 'remove application {id} and the data it holds',
    };
    const raised = await refusal(service, decl, A);
    await service.decideProposal(raised, 'owner', PROPOSAL_DECISION.ONCE);

    await expect(service.authorize(attempt(decl, B))).rejects.toMatchObject({
      response: { code: ACTION_PROPOSAL_CODE },
    });
    expect(proposals.rows).toHaveLength(2);
  });
});

/** The real declarations, read off the controllers, put through the same test. */
describe('the declarations this round shipped, against the same machinery', () => {
  it.each(destructiveRoutes())('%s tells two resources apart', (route) => {
    const decl = CYCLED.get(route) as Declared;
    const params = [...route.matchAll(/:(\w+)/g)].map((m) => m[1]);
    const first = Object.fromEntries(params.map((p) => [p, `${p}-one`]));
    const second = Object.fromEntries(params.map((p) => [p, `${p}-two`]));
    expect(argsDigest(route, bindingOf(decl.bind, first), {})).not.toBe(
      argsDigest(route, bindingOf(decl.bind, second), {}),
    );
  });
});

/**
 * The other half of the cut, and the half that is easiest to lose.
 *
 * Decision 180 measured that no write tool on an application touched a
 * decorated route. This round moved the destructive ones and deliberately not
 * the rest: restarting, stopping, starting, scaling, installing, connecting a
 * repository, creating a schedule, adding a gateway route, running a backup,
 * starting a migration and administering access all still reach a person only
 * through the surface they were called from. Pinned so that widening the cut is
 * a decision, never a drift.
 */
describe('and only the destructive ones', () => {
  it.each([
    'app_restart',
    'app_scale',
    'app_stop',
    'app_start',
    'app_install',
    'repo_connect',
    'schedule_create',
    'schedule_trigger',
    'gateway_route_add',
    'gateway_set_policy',
    'backup_run',
    'backup_policy_pause',
    'backup_policy_resume',
    'migrate_app',
    'migrate_db',
    'migrate_full',
    'migration_cutover',
    'access_grant_add',
    'access_grant_remove',
  ])('%s stays outside the cycle', (name) => {
    const tool = ALL_TOOLS.find((t) => t.name === name);
    expect(tool).toBeDefined();
    expect(SCOPE_TIER[tool?.scope ?? MCP_SCOPE.APP_READ]).not.toBe(
      'destructive',
    );
    for (const route of tool?.routes ?? []) {
      expect({ name, route, cycled: CYCLED.has(route) }).toEqual({
        name,
        route,
        cycled: false,
      });
    }
  });
});

// ── Enough of a repository to run the cycle against ──────────────────

class Rows<T extends { id?: string }> {
  rows: T[] = [];
  private seq = 0;

  create(partial: Partial<T>): T {
    return { ...partial } as T;
  }

  save(entity: T): Promise<T> {
    const row = entity as Record<string, unknown>;
    if (!row.id) {
      row.id = `row-${++this.seq}`;
      row.createdAt = new Date();
      this.rows.push(row as T);
    }
    return Promise.resolve(row as T);
  }

  find(): Promise<T[]> {
    return Promise.resolve([]);
  }

  findOne(options: { where: Record<string, unknown> }): Promise<T | null> {
    const hit = this.rows.filter((row) =>
      Object.entries(options.where).every(
        ([key, value]) => (row as Record<string, unknown>)[key] === value,
      ),
    );
    return Promise.resolve(hit.length ? hit[hit.length - 1] : null);
  }

  update(
    criteria: Record<string, unknown> | string,
    patch: Partial<T>,
  ): Promise<{ affected: number }> {
    const where =
      typeof criteria === 'string' ? { id: criteria } : (criteria ?? {});
    const hits = this.rows.filter((row) =>
      Object.entries(where).every(
        ([key, value]) => (row as Record<string, unknown>)[key] === value,
      ),
    );
    for (const row of hits) Object.assign(row as object, patch);
    return Promise.resolve({ affected: hits.length });
  }
}

function cycle(): {
  service: ActionCycleService;
  proposals: Rows<ActionProposalEntity>;
} {
  const proposals = new Rows<ActionProposalEntity>();
  const service = new ActionCycleService(
    proposals as never,
    new Rows() as never,
    new Rows() as never,
    { get: () => 'https://console.test' } as never,
  );
  return { service, proposals };
}

function attempt(decl: ActionCycleDecl, params: Record<string, string>) {
  return {
    decl,
    ownerUserId: 'owner',
    keyId: 'key-1',
    method: 'DELETE',
    path: `/applications/${params.id}/install`,
    params,
    body: {},
  };
}

/** Run one attempt, expect the wait, and hand back the proposal id it carries. */
async function refusal(
  service: ActionCycleService,
  decl: ActionCycleDecl,
  params: Record<string, string>,
): Promise<string> {
  try {
    await service.authorize(attempt(decl, params));
  } catch (error) {
    const body = (error as { response: { proposalId: string; code: string } })
      .response;
    expect(body.code).toBe(ACTION_PROPOSAL_CODE);
    return body.proposalId;
  }
  throw new Error('the attempt was not stopped');
}
