import * as http from 'node:http';
import axios from 'axios';
import {
  EgressRefusedError,
  assertUrlAllowed,
  blockedReason,
  egressPolicyFromEnv,
  guardedRequest,
  guardedRequestOptions,
} from './egress-guard';

/**
 * F-004, F-014 and F-061 of the September 2026 register.
 *
 * The cases below are the ones a guard written from memory gets wrong: the
 * IPv4-mapped IPv6 forms of loopback, the decimal and dotted-short literals, and
 * the rebind — a name that answers with a public address and a private one.
 */

describe('which addresses this installation will connect to', () => {
  describe('the address itself', () => {
    it.each([
      ['127.0.0.1', 'loopback'],
      ['127.1.2.3', 'loopback'],
      ['0.0.0.0', 'this host'],
      ['10.1.2.3', 'the private network'],
      ['172.16.0.1', 'the private network'],
      ['172.31.255.255', 'the private network'],
      ['192.168.1.1', 'the private network'],
      ['100.64.0.1', 'carrier-grade NAT'],
      ['169.254.169.254', 'link-local'],
      ['224.0.0.1', 'multicast'],
      ['::1', 'loopback'],
      ['::', 'unspecified'],
      ['fd00::1', 'unique local'],
      ['fe80::1', 'link-local'],
      ['::ffff:127.0.0.1', 'loopback'],
      ['::ffff:7f00:1', 'loopback'],
      ['::ffff:169.254.169.254', 'link-local'],
      ['::ffff:a9fe:a9fe', 'link-local'],
      // The same addresses written out in full. A check on the compressed
      // spelling alone reads these as ordinary public addresses.
      ['0:0:0:0:0:ffff:7f00:1', 'loopback'],
      ['0000:0000:0000:0000:0000:ffff:a9fe:a9fe', 'link-local'],
      ['::127.0.0.1', 'loopback'],
      ['::ffff:0:7f00:1', 'loopback'],
      // NAT64 and 6to4 both carry a v4 address that a gateway will deliver.
      ['64:ff9b::7f00:1', 'loopback'],
      ['64:ff9b::a9fe:a9fe', 'link-local'],
      ['2002:7f00:1::', 'loopback'],
      ['2002:a9fe:a9fe::', 'link-local'],
      ['fec0::1', 'site-local'],
    ])('refuses %s', (address, because) => {
      expect(blockedReason(address)).toContain(because);
    });

    it.each([
      '1.1.1.1',
      '8.8.8.8',
      '172.32.0.1',
      '172.15.255.255',
      '99.64.0.1',
      '2606:4700:4700::1111',
    ])('allows %s', (address) => {
      expect(blockedReason(address)).toBeNull();
    });
  });

  describe('the URL, before any request is made', () => {
    it.each([
      'http://127.0.0.1/v1',
      'http://[::1]:11434/v1',
      'https://169.254.169.254/latest/meta-data/',
      'http://[::ffff:127.0.0.1]/v1',
    ])('refuses the literal %s', (url) => {
      // Node connects straight to a literal without consulting any resolver, so
      // a guard that lives only in the lookup never sees these.
      expect(() => assertUrlAllowed(url, {})).toThrow(EgressRefusedError);
    });

    it.each(['file:///etc/passwd', 'gopher://x/', 'ftp://example.test/'])(
      'refuses the scheme in %s',
      (url) => {
        expect(() => assertUrlAllowed(url, {})).toThrow(/only http and https/);
      },
    );

    it('allows an ordinary public endpoint', () => {
      expect(assertUrlAllowed('https://api.openai.com/v1', {}).hostname).toBe(
        'api.openai.com',
      );
    });

    it('lets the installation name an exception, and only the one it named', () => {
      const policy = { allowedHosts: ['ollama.flui-apps.svc'] };

      expect(
        assertUrlAllowed('http://ollama.flui-apps.svc:11434/v1', policy)
          .hostname,
      ).toBe('ollama.flui-apps.svc');
      // A literal the exception does not cover is still refused here; a *name*
      // it does not cover is refused later, on what it resolves to.
      expect(() =>
        assertUrlAllowed('http://10.0.0.5:11434/v1', policy),
      ).toThrow(EgressRefusedError);
    });

    it('reads the exceptions from the environment, never from a request', () => {
      expect(
        egressPolicyFromEnv({
          FLUI_EGRESS_ALLOWED_HOSTS: ' a.test , b.test ',
        } as NodeJS.ProcessEnv).allowedHosts,
      ).toEqual(['a.test', 'b.test']);
      expect(egressPolicyFromEnv({} as NodeJS.ProcessEnv).allowedHosts).toEqual(
        [],
      );
    });
  });

  describe('a real request through axios', () => {
    let server: http.Server;
    let port: number;
    let reached: string[];

    beforeAll(async () => {
      reached = [];
      server = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"data":[]}');
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      port = (server.address() as { port: number }).port;
    });

    beforeEach(() => {
      reached = [];
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('reaches a loopback server without the guard', async () => {
      // The control: the target really is reachable, so the refusal below is the
      // guard doing something and not the request failing on its own.
      const res = await axios.get(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(200);
    });

    it('is refused by literal only through guardedRequest', async () => {
      // The trap this exists to close: Node connects straight to an address
      // without consulting any resolver, so spreading the options alone leaves
      // a literal reachable. `guardedRequest` asks both questions.
      const optionsOnly = await axios
        .get(`http://127.0.0.1:${port}/`, guardedRequestOptions({}))
        .then((r) => r.status)
        .catch(() => 'refused');
      expect(optionsOnly).toBe(200);

      await expect(
        guardedRequest({ url: `http://127.0.0.1:${port}/` }, {}),
      ).rejects.toThrow(EgressRefusedError);
    });

    it('is refused when the name resolves into the private network', async () => {
      // `localhost` is a name, so this exercises the resolver path rather than
      // the literal one.
      await expect(
        guardedRequest({ url: `http://localhost:${port}/` }, {}),
      ).rejects.toThrow(/EGRESS_REFUSED|inside this installation/);
    });

    it('lets a named exception through to the same server', async () => {
      const res = await guardedRequest(
        { url: `http://localhost:${port}/` },
        { allowedHosts: ['localhost'] },
      );
      expect(res.status).toBe(200);
    });

    it('does not follow redirects by default, at the wire and not just in config', async () => {
      const redirector = http.createServer((req, res) => {
        if (req.url === '/redir') {
          res.writeHead(302, { location: `http://localhost:${port}/secret` });
          res.end();
          return;
        }
        reached.push(req.url ?? '');
        res.writeHead(200);
        res.end('reached');
      });
      await new Promise<void>((resolve) =>
        redirector.listen(0, '127.0.0.1', resolve),
      );
      const rPort = (redirector.address() as { port: number }).port;

      try {
        const res = await guardedRequest(
          {
            url: `http://localhost:${rPort}/redir`,
            validateStatus: () => true,
          },
          { allowedHosts: ['localhost'] },
        );
        expect(res.status).toBe(302);
        expect(reached).not.toContain('/secret');
      } finally {
        await new Promise<void>((resolve) => redirector.close(() => resolve()));
      }
    });

    it('judges the target of a redirect when it is asked to follow one', async () => {
      // Following is opt-in and goes hop by hop through the same two checks, so
      // a redirect INTO the private network is refused rather than followed.
      const redirector = http.createServer((_req, res) => {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/' });
        res.end();
      });
      await new Promise<void>((resolve) =>
        redirector.listen(0, '127.0.0.1', resolve),
      );
      const rPort = (redirector.address() as { port: number }).port;

      try {
        await expect(
          guardedRequest(
            { url: `http://localhost:${rPort}/` },
            { allowedHosts: ['localhost'] },
            3,
          ),
        ).rejects.toThrow(EgressRefusedError);
      } finally {
        await new Promise<void>((resolve) => redirector.close(() => resolve()));
      }
    });

    it('is not reachable through a socket somebody else left warm', async () => {
      // The bypass this closes, and it was reproduced before it was fixed: Node
      // pools connections, and a pooled socket is reused *without consulting any
      // resolver* — so a request aimed at a host:port the installation's own
      // clients keep warm skips the guard entirely. Loki, Prometheus and Grafana
      // are polled on a schedule, which keeps exactly such sockets warm.
      //
      // `globalAgent.keepAlive` is true in the Node this runs on in production
      // and false under this test runner, so it is set here: without it the test
      // passes whether the fix is present or not, which is worse than no test.
      const agent = http.globalAgent as unknown as { keepAlive: boolean };
      const wasKeepingAlive = agent.keepAlive;
      agent.keepAlive = true;
      try {
        const internal = axios.create();
        await internal.get(`http://localhost:${port}/`);

        await expect(
          guardedRequest({ url: `http://localhost:${port}/` }, {}),
        ).rejects.toThrow(/EGRESS_REFUSED|inside this installation/);
      } finally {
        agent.keepAlive = wasKeepingAlive;
        http.globalAgent.destroy();
      }
    });

    it('judges every address a name answers with, not only the first', async () => {
      // A name that resolves to one public address and one private one is a
      // rebind waiting to be noticed.
      const policy = {};
      const options = guardedRequestOptions(policy);
      const lookup = options.lookup as unknown as (
        host: string,
        opts: unknown,
        cb: (e: Error | null, a?: unknown, f?: number) => void,
      ) => void;

      const err = await new Promise<Error | null>((resolve) => {
        // `localhost` answers with ::1 and 127.0.0.1 on this machine; `all`
        // makes Node hand both to the callback at once.
        lookup('localhost', { all: true, family: 0 }, (e) => resolve(e));
      });
      expect(err).toBeTruthy();
      expect(String(err)).toMatch(/loopback/);
    });
  });
});
