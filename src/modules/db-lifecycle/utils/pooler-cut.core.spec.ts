import { load } from 'js-yaml';
import {
  DEFAULT_PAUSE_DEADLINE_MS,
  cutSnapshot,
  forwardEgressManifest,
  forwardHbaScript,
  forwardsToSource,
  heldServers,
  parseWhoami,
  pauseBudgetMs,
  killCommand,
  pauseCommand,
  resumeCommand,
  pauseDeadlineMs,
  pauseWaitSeconds,
  pgbouncerTime,
  raiseWaitCommands,
  reachesPromotedDestination,
  whoamiProbeScript,
} from './pooler-cut.core';
import { parseShow } from '../../database-console/engine/pgbouncer-show.core';

describe('pooler cut, pure parts', () => {
  describe('the pause deadline and its budget', () => {
    it('defaults to five seconds and takes one to sixty', () => {
      expect(pauseDeadlineMs()).toBe(DEFAULT_PAUSE_DEADLINE_MS);
      expect(pauseDeadlineMs(12)).toBe(12_000);
      expect(() => pauseDeadlineMs(0)).toThrow(/between 1 and 60/);
      expect(() => pauseDeadlineMs(61)).toThrow(/between 1 and 60/);
    });

    it('raises the client wait above the whole pause, login included', () => {
      const budget = pauseBudgetMs(5_000, 120_000);
      expect(budget).toBe(5_000 + 10_000 + 120_000 + 60_000 + 15_000);
      const s = pauseWaitSeconds(budget);
      expect(s).toBe(240);
      expect(raiseWaitCommands(s)).toEqual([
        'SET query_wait_timeout = 240;',
        'SET client_login_timeout = 240;',
      ]);
    });

    it('refuses a budget the pooler would not hold, before anything stops', () => {
      expect(() =>
        pauseWaitSeconds(pauseBudgetMs(60_000, 120_000), 200),
      ).toThrow(/does not fit the 200s/);
    });

    it('names the database it pauses and refuses one that would break the command', () => {
      // The admin console reads a name with a dash only when it is double-quoted.
      expect(pauseCommand('postgresql-1a53e2')).toBe(
        'PAUSE "postgresql-1a53e2";',
      );
      expect(killCommand('app_db')).toBe('KILL "app_db";');
      expect(resumeCommand('app_db')).toBe('RESUME "app_db";');
      expect(() => pauseCommand('x; SHUTDOWN')).toThrow();
    });
  });

  describe('the cut snapshot', () => {
    const servers = parseShow(
      [
        'type|user|database|state|addr|port|connect_time|request_time|ptr|link|remote_pid',
        'S|app|app_db|active|10.43.0.5|5432|2026-10-12 10:00:00 UTC|2026-10-12 10:00:01 UTC|0xs1|0xc1|4242',
        'S|app|app_db|used|10.43.0.5|5432|2026-10-12 10:00:00 UTC|2026-10-12 10:00:02 UTC|0xs2||4243',
        'S|flui_pooler_admin|pgbouncer|active|||||0xs9||',
      ].join('\n'),
    );
    const clients = parseShow(
      [
        'type|user|database|state|addr|port|request_time|ptr|link|id|application_name',
        'C|app|app_db|active|10.42.1.7|51000|2026-10-12 10:00:03 UTC|0xc1|0xs1|17|worker - 10.42.1.7:51000',
        'C|app|app_db|waiting|10.42.1.8|51001|2026-10-12 10:00:04 UTC|0xc2||18|api',
      ].join('\n'),
    );

    it('ignores the admin console when counting held servers', () => {
      expect(heldServers(servers)).toHaveLength(2);
    });

    it('links each held server to its client and counts how long it was held', () => {
      const at = new Date('2026-10-12T10:00:08Z');
      expect(
        cutSnapshot('pg-pooler-1', 'destination', servers, clients, at),
      ).toEqual([
        {
          pod: 'pg-pooler-1',
          role: 'destination',
          remotePid: 4242,
          clientId: 17,
          user: 'app',
          database: 'app_db',
          clientAddr: '10.42.1.7',
          clientApp: 'worker',
          heldMs: 5000,
        },
        {
          pod: 'pg-pooler-1',
          role: 'destination',
          remotePid: 4243,
          clientId: null,
          user: 'app',
          database: 'app_db',
          clientAddr: null,
          clientApp: null,
          heldMs: 6000,
        },
      ]);
    });

    it('reads PgBouncer timestamps', () => {
      expect(pgbouncerTime('2026-10-12 10:00:01 UTC')).toBe(
        Date.parse('2026-10-12T10:00:01Z'),
      );
      expect(pgbouncerTime('')).toBeNull();
      expect(pgbouncerTime('garbage')).toBeNull();
    });
  });

  describe('the forward', () => {
    it('puts a block on top of pg_hba that admits the destination node for the database only', () => {
      const script = forwardHbaScript(
        'flui:fwd:0123456789ab',
        'app_db',
        '10.250.0.3',
      );
      expect(script).toContain(
        "printf '# flui:fwd:0123456789ab:begin\\nhost app_db all 10.250.0.3/32 scram-sha-256\\n# flui:fwd:0123456789ab:end\\n'",
      );
      expect(script).toContain("if ! grep -qx '# flui:fwd:0123456789ab:begin'");
      expect(() => forwardHbaScript('m', 'app_db', 'not-an-ip')).toThrow();
    });

    it('lets only the destination pooler pods dial the source endpoint', () => {
      const doc = load(
        forwardEgressManifest(
          'p1',
          'dst',
          'flui-db-fwd-0123456789ab',
          '10.250.0.2',
          15432,
        ),
      ) as any;
      expect(doc.spec.podSelector.matchLabels).toEqual({
        'flui.cloud/pooler-of': 'dst',
      });
      expect(doc.spec.egress[0].to[0].ipBlock.cidr).toBe('10.250.0.2/32');
      expect(doc.spec.egress[0].ports[0].port).toBe(15432);
    });

    it('keeps DNS and the cluster reachable for the pods it selects', () => {
      const doc = load(
        forwardEgressManifest(
          'p1',
          'dst',
          'flui-db-fwd-0123456789ab',
          '10.250.0.2',
          15432,
          ['10.42.0.0/16', '10.43.0.0/16', '10.0.0.0/16'],
        ),
      ) as any;
      const dns = doc.spec.egress[1];
      expect(dns.to[0].namespaceSelector.matchLabels).toEqual({
        'kubernetes.io/metadata.name': 'kube-system',
      });
      expect(dns.ports).toEqual([
        { protocol: 'UDP', port: 53 },
        { protocol: 'TCP', port: 53 },
      ]);
      expect(doc.spec.egress[2].to.map((t: any) => t.ipBlock.cidr)).toEqual([
        '10.42.0.0/16',
        '10.43.0.0/16',
        '10.0.0.0/16',
      ]);
      const byDefault = load(
        forwardEgressManifest('p1', 'dst', 'n', '10.250.0.2', 15432),
      ) as any;
      expect(
        byDefault.spec.egress[2].to.map((t: any) => t.ipBlock.cidr),
      ).toEqual(['10.42.0.0/16', '10.43.0.0/16']);
    });

    it('probes through the upstream Service with the password read inside the pod', () => {
      const script = whoamiProbeScript(
        'pg-pooler-upstream.p1.svc.cluster.local',
        'app_db',
      );
      expect(script).toContain('/etc/pgbouncer/userlist.txt');
      expect(script).toContain(
        'host=pg-pooler-upstream.p1.svc.cluster.local port=5432 dbname=app_db',
      );
      expect(script).toContain('flui_pooler.whoami()');
      expect(() => whoamiProbeScript('x;rm -rf /', 'app_db')).toThrow();
    });
  });

  describe('the probe verdicts', () => {
    const source = { systemIdentifier: '7301', timeline: 3 };
    it('reads the probe row', () => {
      expect(parseWhoami('f|7301|3|10.42.0.9\n')).toEqual({
        inRecovery: false,
        systemIdentifier: '7301',
        timeline: 3,
        serverAddr: '10.42.0.9',
      });
      expect(parseWhoami('psql: error')).toBeNull();
    });

    it('forwards only when a primary on the source timeline answers', () => {
      expect(forwardsToSource(parseWhoami('f|7301|3|10.42.0.9'), source)).toBe(
        true,
      );
      expect(forwardsToSource(parseWhoami('t|7301|3|10.42.5.5'), source)).toBe(
        false,
      );
      expect(forwardsToSource(parseWhoami('f|9999|3|10.42.0.9'), source)).toBe(
        false,
      );
      expect(forwardsToSource(null, source)).toBe(false);
    });

    it('sees the promoted destination by its next timeline or by its own pod address', () => {
      const expected = {
        systemIdentifier: '7301',
        sourceTimeline: 3,
        dstPodIp: '10.42.5.5',
      };
      expect(
        reachesPromotedDestination(parseWhoami('f|7301|4|10.42.0.1'), expected),
      ).toBe(true);
      expect(
        reachesPromotedDestination(parseWhoami('f|7301|3|10.42.5.5'), expected),
      ).toBe(true);
      expect(
        reachesPromotedDestination(parseWhoami('f|7301|3|10.42.0.9'), expected),
      ).toBe(false);
      expect(
        reachesPromotedDestination(parseWhoami('t|7301|4|10.42.5.5'), expected),
      ).toBe(false);
    });
  });
});
