import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { MetadataScanner } from '@nestjs/core';
import { Controller, Get, Post } from '@nestjs/common';
import { ActionCycleRoutes } from './action-cycle-routes.service';
import { ActionCycle } from '../../action-cycle/action-cycle.decorator';
import { reachesActionCycle } from './action-cycle-reach';
import { ALL_TOOLS } from '../../mcp/tools/tool-registry';
import { SCOPE_TIER } from '../../mcp/constants/mcp-scopes';

@Controller()
class PausedController {
  @ActionCycle({
    action: 'POST /things/:id/deploy',
    bind: ['id'],
    sentence: 'deploy thing {id} whenever it asks',
  })
  @Post(':id/deploy')
  deploy(): void {}

  @Get()
  list(): void {}
}

@Controller()
class PlainController {
  @Post()
  create(): void {}
}

function routesOf(...instances: object[]): ActionCycleRoutes {
  const discovery = {
    getControllers: () => instances.map((instance) => ({ instance })),
  };
  const service = new ActionCycleRoutes(
    discovery as never,
    new MetadataScanner(),
  );
  service.onModuleInit();
  return service;
}

describe('the shapes the action cycle pauses', () => {
  it('reads them off the decorations, and nothing else off the controller', () => {
    const routes = routesOf(new PausedController(), new PlainController());
    expect([...routes.known()]).toEqual(['POST /things/:id/deploy']);
  });

  it('answers the loop’s one question from what it found', () => {
    const routes = routesOf(new PausedController());
    expect(routes.reaches(['POST /things/:id/deploy'])).toBe(true);
    expect(routes.reaches(['POST /things/:id/restart'])).toBe(false);
    expect(routes.reaches(undefined)).toBe(false);
  });

  it('finds nothing when nothing is decorated, and then pauses nothing', () => {
    const routes = routesOf(new PlainController());
    expect(routes.known().size).toBe(0);
    expect(routes.reaches(['POST /things/:id/deploy'])).toBe(false);
  });

  it('survives a controller wrapper with no instance behind it', () => {
    const discovery = { getControllers: () => [{ instance: undefined }] };
    const service = new ActionCycleRoutes(
      discovery as never,
      new MetadataScanner(),
    );
    expect(() => service.onModuleInit()).not.toThrow();
    expect(service.known().size).toBe(0);
  });
});

/**
 * The join, against the real two halves.
 *
 * Booting Nest here is not on — the controllers pull the Kubernetes client down
 * their tree — so the decorated shapes are read out of the controller sources
 * instead. That is a second parser and it is allowed to be one: it is not a
 * second source of truth, and what it catches is the failure that would
 * otherwise be silent. A route pattern renamed on either side does not break a
 * build and does not redden a test; it just quietly drops the tool out of the
 * predicate, and with it the request the person was supposed to read.
 */
describe('the tools whose request the chat can show', () => {
  const controllers = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return controllers(path);
      return entry.name.endsWith('.controller.ts') ? [path] : [];
    });

  const declared = new Set<string>();
  for (const file of controllers(join(__dirname, '..', '..'))) {
    const source = readFileSync(file, 'utf8');
    for (const block of source.split('@ActionCycle({').slice(1)) {
      const action = /^[^']*action:[^']*'([^']+)'/.exec(block);
      if (action) declared.add(action[1]);
    }
  }

  it('found the decorations at all', () => {
    expect(declared.size).toBeGreaterThan(10);
  });

  it.each([
    'app_deploy',
    'cluster_create',
    'cluster_node_add',
    'cluster_node_remove',
    'cluster_power',
    'cluster_storage_expand',
    'cluster_autoscale_set',
    'cluster_firewall_enable',
    'platform_component_redeploy',
    'dns_issuer_configure',
    'san_certificate_create',
    'mail_domain_publish',
  ])('%s carries the cycle’s request into the chat’s card', (name) => {
    const tool = ALL_TOOLS.find((t) => t.name === name);
    expect(tool).toBeDefined();
    expect(reachesActionCycle(tool?.routes, declared)).toBe(true);
  });

  /**
   * The census, and it is the point of this file rather than a flourish.
   *
   * A control is measured by counting **where it is applied**, not by proving
   * that it works — the cycle's own tests were green through the whole period
   * in which it stood on seven routes. So: every write and destructive tool in
   * the registry, sorted into the two piles, every time this suite runs.
   *
   * At the time of writing: **46 write/destructive tools, 20 inside the cycle,
   * 26 outside it.** For those 26 a coding agent meets nothing at all, and the
   * chat's own tier confirmation is the only question asked — which is the half
   * of the assimilation that no lane inside the assistant can close, because
   * closing it means decorating controllers.
   *
   * Asserted as inclusions and not as equalities, on purpose: another round
   * decorating one of these routes moves a name from the second list to the
   * first and must not redden anything. What reddens is the two things that
   * would be silent — a **new** write tool published outside the cycle, and a
   * decoration **removed** from one that is inside it.
   */
  const tiered = (name: string) =>
    SCOPE_TIER[ALL_TOOLS.find((t) => t.name === name)!.scope];

  const writeTier = ALL_TOOLS.filter(
    (t) =>
      SCOPE_TIER[t.scope] === 'write' || SCOPE_TIER[t.scope] === 'destructive',
  );

  /**
   * Write-tier scope, every declared route a GET: it hands over, it does not
   * write.
   *
   * The tier is read off the scope, and a scope is chosen to clear the
   * *route's* permission — so a tool that only looks can still need a write
   * scope to be allowed to look. `user_invite_request` is the first: listing
   * the accounts on this instance is gated on `iam:assign-role`, which only
   * `mcp:iam:write` carries, and the tool's entire purpose is that the
   * invitation is issued by a person and not by it.
   *
   * Excluded by what it declares rather than by name, so the exclusion cannot
   * rot: the day one of these grows a POST it rejoins the pile and this suite
   * says so.
   */
  const handsOverOnly = writeTier.filter((t) =>
    (t.routes ?? []).every((r) => r.startsWith('GET ')),
  );
  const writeTools = writeTier.filter((t) => !handsOverOnly.includes(t));
  const sorted = () => {
    const inside: string[] = [];
    const outside: string[] = [];
    for (const tool of writeTools) {
      (reachesActionCycle(tool.routes, declared) ? inside : outside).push(
        tool.name,
      );
    }
    const byName = (a: string, b: string) => a.localeCompare(b);
    return {
      inside: [...inside].sort(byName),
      outside: [...outside].sort(byName),
    };
  };

  /** Every write tool the cycle governs today. Losing one of these is a regression. */
  const GOVERNED = [
    'app_delete',
    'app_deploy',
    'app_uninstall',
    'cluster_autoscale_set',
    'cluster_create',
    'cluster_firewall_enable',
    'cluster_node_add',
    'cluster_node_remove',
    'cluster_node_resize',
    'cluster_node_uncordon',
    'cluster_power',
    'cluster_storage_expand',
    'dns_issuer_configure',
    'gateway_route_remove',
    'mail_domain_publish',
    'migration_abort',
    'migration_destroy_source',
    'platform_component_redeploy',
    'san_certificate_create',
    // A scaling group is not a node, it is the standing figure a cluster may
    // grow and spend to unattended — which is the class of thing the cycle
    // exists for even though nothing is bought at the moment it is written.
    'scaling_group_set',
    'schedule_delete',
  ];

  /**
   * Every write tool the cycle does **not** govern today — the open half of
   * decision 180, named so it can be counted instead of rediscovered.
   *
   * Note what the pairs say: `app_deploy` is inside and `app_deploy_from_yaml`
   * is not; `gateway_route_remove` is inside and `gateway_route_add` is not;
   * `schedule_delete` is inside and `schedule_create` is not. Whatever decided
   * these was not a rule about writing.
   */
  const UNGOVERNED = [
    'access_grant_add',
    'access_grant_remove',
    'app_deploy_from_yaml',
    'app_install',
    'app_reconcile',
    'app_restart',
    'app_rollback',
    'app_scale',
    'app_set_resources',
    'app_start',
    'app_stop',
    'app_variable_request',
    'app_variable_set',
    'backup_policy_pause',
    'backup_policy_resume',
    'backup_run',
    'dns_wildcard_publish',
    'gateway_route_add',
    'gateway_set_policy',
    'migrate_app',
    'migrate_db',
    'migrate_full',
    'migration_cutover',
    'repo_connect',
    'schedule_create',
    'schedule_trigger',
  ];

  it('counts every write the registry publishes, on both sides of the line', () => {
    const { inside, outside } = sorted();
    expect(inside.length + outside.length).toBe(writeTools.length);
    expect(inside.length + outside.length + handsOverOnly.length).toBe(
      writeTier.length,
    );
    expect(writeTools.length).toBeGreaterThan(40);
    // Every tool answers the question — none is left out for want of a route.
    expect(writeTier.filter((t) => !t.routes?.length)).toEqual([]);
  });

  /**
   * Named so the exclusion is a list somebody reads, not a filter nobody sees.
   * A second entry appearing here is worth a look; a genuine write appearing
   * here would mean its declared routes are wrong.
   */
  it('excludes only the hand-offs that declare nothing but reads', () => {
    expect(handsOverOnly.map((t) => t.name).sort()).toEqual([
      'user_invite_request',
    ]);
  });

  it('never loses a write the cycle already governs', () => {
    expect(sorted().inside).toEqual(expect.arrayContaining(GOVERNED));
  });

  it('publishes no write outside the cycle that is not named here', () => {
    // The one that would otherwise be silent: a new write tool lands, the
    // coding agent meets nothing on it, and no build and no test says so.
    expect(UNGOVERNED).toEqual(expect.arrayContaining(sorted().outside));
  });

  it('sorts destructive tools no differently from the rest', () => {
    // Stated because it is tempting to assume otherwise: being destructive does
    // not put a tool inside the cycle, and being inside does not require it.
    expect(tiered('app_delete')).toBe('destructive');
    expect(tiered('app_install')).toBe('write');
    expect(sorted().inside).toContain('app_delete');
    expect(sorted().outside).toContain('app_install');
  });

  /**
   * The other side of the same line. `app_restart` writes and is not inside the
   * cycle, so the chat keeps its own card for it — and, because the predicate
   * says no, must not answer a request on the person's behalf either.
   */
  it.each(['app_restart', 'app_scale', 'repo_connect'])(
    '%s stays with the chat’s own confirmation',
    (name) => {
      const tool = ALL_TOOLS.find((t) => t.name === name);
      expect(tool).toBeDefined();
      expect(reachesActionCycle(tool?.routes, declared)).toBe(false);
    },
  );
});
