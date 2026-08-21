import {
  SANDBOX_STAND_INS,
  findSandboxStandIn,
  isStandInArea,
} from './sandbox-stand-in';
import { exampleFirewalls, exampleInstances } from './sandbox-world';
import { exampleBackupPolicies } from './sandbox-world-backups';
import { exampleIamGrants, exampleUsers } from './sandbox-world-people';
import {
  exampleMailConnections,
  exampleMailOverview,
} from './sandbox-world-mail';
import { APPS, ZONE_NAME } from './sandbox-world-core';

const NOW = Date.parse('2026-08-18T12:00:00.000Z');

/** Every object the example world hands out, flattened. */
function everyObject(now: number): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if ('id' in record || 'sandboxExample' in record) out.push(record);
      Object.values(record).forEach(walk);
    }
  };
  SANDBOX_STAND_INS.forEach((rule) => walk(rule.build(now)));
  return out;
}

describe('the example world', () => {
  /**
   * Constraint 2, and the one that decides whether the sections read as a
   * demonstration or as three broken screens. A guest who opens Access, then
   * Mail, then Backup must come away with one organisation — the same people,
   * the same domain, the same applications.
   */
  describe('is one world', () => {
    it('grants every person Access lists, and lists every person granted', () => {
      const people = exampleUsers(NOW).map((u) => u.email);
      const granted = exampleIamGrants(NOW)
        .filter((g) => g.principalType === 'user')
        .map((g) => g.principalRef);
      for (const ref of granted) expect(people).toContain(ref);
    });

    it('sends mail from the organisation\u2019s own zone', () => {
      const overview = exampleMailOverview(NOW) as {
        senders: Array<{ from: string; domain: string }>;
      };
      const connection = exampleMailConnections(NOW)[0];
      expect(connection.sendingDomain).toBe(ZONE_NAME);
      for (const sender of overview.senders) {
        expect(sender.domain).toBe(ZONE_NAME);
        expect(sender.from.endsWith(`@${ZONE_NAME}`)).toBe(true);
      }
    });

    it('protects an application the rest of the world knows about', () => {
      const ids = APPS.map((a) => a.id);
      const scoped = (
        exampleBackupPolicies(NOW) as Array<{
          scopeSelector?: { applicationIds?: string[] };
        }>
      ).flatMap((p) => p.scopeSelector?.applicationIds ?? []);
      expect(scoped.length).toBeGreaterThan(0);
      for (const id of scoped) expect(ids).toContain(id);
    });
  });

  /**
   * Constraint 3. A window the caller picks that the answer ignores is the same
   * failure as a date pinned to a fixed day: the screen and the control in the
   * visitor's hand stop agreeing.
   */
  it('answers the window it was asked for', () => {
    const day = exampleMailOverview(NOW, { window: '24h' }) as {
      bucket: string;
      volume: unknown[];
    };
    const month = exampleMailOverview(NOW, { window: '30d' }) as {
      bucket: string;
      volume: unknown[];
    };
    expect(day.bucket).toBe('hour');
    expect(month.bucket).toBe('day');
    expect(month.volume).toHaveLength(30);
    expect(day.volume).toHaveLength(24);
  });

  // Constraint 4: no silent stand-in. A caller reading a single element out of a
  // list must still be able to tell it is an example.
  it('marks every object it hands out', () => {
    for (const object of everyObject(NOW)) {
      expect(object.sandboxExample).toBe(true);
    }
  });

  /**
   * Constraint 5. A fake credential is still a string shaped like a credential:
   * it teaches the interface to print one, and in a screenshot it cannot be told
   * from a real leak.
   */
  it('never invents a secret', () => {
    const serialised = JSON.stringify(
      SANDBOX_STAND_INS.map((r) => r.build(NOW)),
    );

    for (const forbidden of [
      'accessKey',
      'secretKey',
      'privateKey',
      'kubeconfig',
      'password',
      'token',
      'BEGIN OPENSSH',
      'BEGIN RSA',
    ]) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  // Constraint 3: a world pinned to fixed dates is the oldest thing in the demo
  // within a week.
  it('computes its dates from now', () => {
    const early = JSON.stringify(SANDBOX_STAND_INS.map((r) => r.build(NOW)));
    const later = JSON.stringify(
      SANDBOX_STAND_INS.map((r) => r.build(NOW + 86_400_000)),
    );
    expect(later).not.toEqual(early);
  });

  // Constraint 2: sections that do not agree with each other read as broken
  // rather than as a demonstration.
  it('points the firewall at the machines the fleet actually lists', () => {
    const machines = exampleInstances(NOW).data.map((m) => m.name);
    const [firewall] = exampleFirewalls(NOW);
    const covered = firewall.clusterInfo.nodes.map((n) => n.serverName);

    expect(covered.sort()).toEqual(machines.sort());
  });

  it('writes its rules against the network the machines are on', () => {
    const [firewall] = exampleFirewalls(NOW);
    const internal = firewall.desiredRules.filter((r) =>
      r.sourceIps.some((ip) => ip.startsWith('10.10.')),
    );

    expect(internal.map((r) => r.port).sort()).toEqual(['22', '6443']);
  });

  describe('which routes it answers', () => {
    it.each([
      ['GET', '/instances'],
      ['GET', '/firewalls'],
      ['GET', '/dns/zones'],
      ['GET', '/backup-policies'],
    ])('answers %s %s', (verb, path) => {
      expect(findSandboxStandIn(verb, path)).toBeDefined();
    });

    it('answers nothing on a verb that would change something', () => {
      expect(findSandboxStandIn('POST', '/backup-policies')).toBeUndefined();
    });

    // So a write gets the section's own wording rather than "this is disabled".
    it.each([
      '/backup-policies',
      '/backup-policies/example-policy-1/run',
      '/dns/zones/example-zone-1',
    ])('recognises %s as part of an example section', (path) => {
      expect(isStandInArea(path)).toBe(true);
    });

    it.each(['/applications/app-1', '/catalog', '/sandbox/session'])(
      'leaves %s outside the example world',
      (path) => {
        expect(isStandInArea(path)).toBe(false);
      },
    );
  });
});
