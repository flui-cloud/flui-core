import {
  APPLIED_MARKER,
  buildApplyScript,
  buildKeyEnrolmentScript,
  extractPublicKey,
  isHandshakeFresh,
  KEY_MARKER,
  parseWireGuardDump,
  UNSUPPORTED_MARKER,
} from './wireguard-host';
import {
  memberInterface,
  PRIVATE_KEY_PLACEHOLDER,
  renderWireGuardConfig,
} from './wireguard-config';

const KEY_A = 'h0FoHrdl/fI6kj27RRzbjxQQEqb1Iibt/b3oYbknZtE=';
const KEY_B = '+8PaqoF8+RnCIQLKaVflCPpr7escUSccTYpZLkW2JN0=';

const config = () =>
  renderWireGuardConfig(
    memberInterface({
      address: '10.250.0.5',
      control: {
        publicKey: KEY_A,
        address: '10.250.0.1',
        endpoint: '1.2.3.4:51821',
      },
    }),
  );

describe('the scripts run under /bin/sh, not bash', () => {
  // Ubuntu's /bin/sh is dash. Process substitution is a bash-only construct and
  // would be a syntax error there — a failure that only shows up on a real node.
  it.each([
    ['enrolment', buildKeyEnrolmentScript()],
    ['apply', buildApplyScript(config())],
  ])('%s script uses no process substitution', (_name, script) => {
    expect(script).not.toMatch(/<\(/);
    expect(script).not.toMatch(/\[\[/);
  });
});

describe('buildKeyEnrolmentScript', () => {
  const script = buildKeyEnrolmentScript();

  it('ends with a newline', () => {
    // Piped into a shell, a script without one runs its last line into the
    // next command.
    expect(script.endsWith('\n')).toBe(true);
    expect(buildApplyScript(config()).endsWith('\n')).toBe(true);
  });

  it('keeps an existing key instead of minting a new one', () => {
    // Regenerating would orphan every peer entry naming the old key, and the
    // node would go quiet without anything reporting an error.
    expect(script).toContain('if [ ! -s /etc/wireguard/flui0.key ]; then');
  });

  it('creates the private key with a restrictive umask', () => {
    expect(script).toContain(
      '( umask 077; wg genkey > /etc/wireguard/flui0.key )',
    );
  });

  it('prints only the public half', () => {
    expect(script).toContain(
      `echo ${KEY_MARKER}=$(cat /etc/wireguard/flui0.pub)`,
    );
    expect(script).not.toMatch(/cat \/etc\/wireguard\/flui0\.key\s*$/m);
  });

  it('reports plainly when the host cannot run WireGuard at all', () => {
    expect(script).toContain(UNSUPPORTED_MARKER);
  });

  describe('a node minutes out of provisioning is still running its own apt', () => {
    it('waits for the lock instead of giving up', () => {
      expect(script).toContain('while [ $i -lt 24 ]; do');
      expect(script).toContain('sleep 5; continue');
    });

    it('matches the lock message with -E, or the branch never fires', () => {
      expect(script).toMatch(
        /grep -qiE "could not get lock\|unable to lock\|dpkg frontend"/,
      );
    });

    it('says why when it does give up', () => {
      expect(script).toContain('echo "reason:');
    });
  });
});

describe('buildApplyScript', () => {
  const script = buildApplyScript(config());

  it('splices the private key in on the node, never over the wire', () => {
    expect(script).toContain(
      `sed -i "s|${PRIVATE_KEY_PLACEHOLDER}|$(cat /etc/wireguard/flui0.key)|"`,
    );
  });

  it('carries the config base64-encoded so its quoting cannot break the shell', () => {
    expect(script).toMatch(/echo '[A-Za-z0-9+/=]+' \| base64 -d/);
  });

  it('refuses to write a config when the node has no key of its own', () => {
    expect(script).toContain('missing private key at /etc/wireguard/flui0.key');
  });

  it('reconfigures when the interface address itself changed', () => {
    // syncconf applies peers and keys but not the address: without this a node
    // that moved would answer on the old address while everyone routes to the
    // new one.
    expect(script).toContain(
      'if [ -n "$HAVE_ADDR" ] && [ "$HAVE_ADDR" != "$WANT_ADDR" ]; then',
    );
    expect(script).toContain('wg-quick down');
  });

  it('syncs an existing interface instead of tearing it down', () => {
    // A down/up cycle would drop every established session on the host, so
    // reconciling one peer would interrupt all the others.
    expect(script).toContain('wg syncconf flui0');
  });

  it('writes atomically, so a half-written config is never loaded', () => {
    expect(script).toContain(
      'mv /etc/wireguard/flui0.conf.new /etc/wireguard/flui0.conf',
    );
  });

  it('confirms with a marker', () => {
    expect(script).toContain(`echo ${APPLIED_MARKER}`);
  });
});

describe('parseWireGuardDump', () => {
  const dump = [
    ['PRIVATEKEYWOULDBEHERE=', KEY_A, '51821', 'off'].join('\t'),
    [
      KEY_B,
      '(none)',
      '5.6.7.8:51821',
      '10.250.0.5/32',
      '1789362000',
      '2048',
      '4096',
      '25',
    ].join('\t'),
    [KEY_A, '(none)', '(none)', '10.250.0.9/32', '0', '0', '0', 'off'].join(
      '\t',
    ),
  ].join('\n');

  it('never returns the private key from the interface line', () => {
    const state = parseWireGuardDump(dump);
    expect(JSON.stringify(state)).not.toContain('PRIVATEKEYWOULDBEHERE');
    expect(state.publicKey).toBe(KEY_A);
    expect(state.listenPort).toBe(51821);
  });

  it('reads a peer that has shaken hands', () => {
    const [peer] = parseWireGuardDump(dump).peers;
    expect(peer).toMatchObject({
      publicKey: KEY_B,
      endpoint: '5.6.7.8:51821',
      allowedIps: ['10.250.0.5/32'],
      transferRx: 2048,
      transferTx: 4096,
    });
    expect(peer.latestHandshakeAt?.getTime()).toBe(1789362000 * 1000);
  });

  it('treats a handshake of 0 as never, not as 1970', () => {
    const peer = parseWireGuardDump(dump).peers[1];
    expect(peer.latestHandshakeAt).toBeUndefined();
    expect(peer.endpoint).toBeUndefined();
  });

  it('survives an empty dump from an interface that does not exist', () => {
    expect(parseWireGuardDump('')).toEqual({ interface: 'flui0', peers: [] });
  });
});

describe('isHandshakeFresh', () => {
  const peer = (secondsAgo?: number) => ({
    publicKey: KEY_A,
    allowedIps: [],
    transferRx: 0,
    transferTx: 0,
    latestHandshakeAt:
      secondsAgo === undefined
        ? undefined
        : new Date(Date.now() - secondsAgo * 1000),
  });

  it('is false for a peer that has never handshaken', () => {
    expect(isHandshakeFresh(peer())).toBe(false);
  });

  it('is true just after a handshake', () => {
    expect(isHandshakeFresh(peer(30))).toBe(true);
  });

  it('is false once the silence outlasts the rehandshake interval', () => {
    expect(isHandshakeFresh(peer(400))).toBe(false);
  });
});

describe('extractPublicKey', () => {
  it('reads the key out of the script output', () => {
    expect(extractPublicKey(`noise\n${KEY_MARKER}=${KEY_A}\nmore`)).toBe(KEY_A);
  });

  it('refuses anything that is not a WireGuard key', () => {
    // A shell error captured as output must never be stored as a peer key.
    expect(
      extractPublicKey(`${KEY_MARKER}=wg: command not found`),
    ).toBeUndefined();
  });

  it('returns nothing when the marker is absent', () => {
    expect(extractPublicKey('installed ok')).toBeUndefined();
  });
});
