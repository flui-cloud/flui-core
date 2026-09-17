import { BadRequestException } from '@nestjs/common';
import {
  cidrContains,
  nextFreeBlock,
  cidrsOverlap,
  formatIp,
  parseIp,
  WireGuardAddressPool,
} from './wireguard-address-pool';

describe('cidrsOverlap', () => {
  it.each([
    ['10.250.0.0/16', '10.250.0.0/16', true],
    ['10.250.0.0/16', '10.250.5.0/24', true],
    ['10.250.5.0/24', '10.250.0.0/16', true],
    ['10.250.0.0/16', '10.251.0.0/16', false],
    ['10.250.0.0/16', '10.42.0.0/16', false],
    ['10.0.0.0/8', '10.250.0.0/16', true],
  ])('%s vs %s → %s', (a, b, expected) => {
    expect(cidrsOverlap(a as string, b as string)).toBe(expected);
  });
});

describe('address arithmetic', () => {
  it('round-trips addresses across the signed-integer boundary', () => {
    // 224.0.0.1 has the high bit set; a signed shift would produce a negative
    // number and format as garbage.
    for (const ip of ['0.0.0.0', '10.250.1.10', '192.168.1.1', '224.0.0.1']) {
      expect(formatIp(parseIp(ip))).toBe(ip);
    }
  });

  it('rejects malformed input rather than coercing it', () => {
    expect(() => parseIp('10.250.1')).toThrow(BadRequestException);
    expect(() => parseIp('10.250.1.999')).toThrow(BadRequestException);
  });
});

describe('WireGuardAddressPool', () => {
  it('refuses a pool that overlaps the k3s pod range', () => {
    // The failure it prevents is not an error but a silence: the node's own
    // cluster routes win, and the tunnel simply never carries the traffic.
    expect(() => new WireGuardAddressPool('10.42.0.0/16')).toThrow(
      /overlaps 10\.42\.0\.0\/16/,
    );
  });

  it('refuses a pool that overlaps a private network Flui already knows', () => {
    expect(
      () => new WireGuardAddressPool('10.0.0.0/16', ['10.0.1.0/24']),
    ).toThrow(/overlaps 10\.0\.1\.0\/24/);
  });

  it('accepts a pool that clears everything known', () => {
    expect(
      () => new WireGuardAddressPool('10.250.0.0/16', ['10.0.1.0/24']),
    ).not.toThrow();
  });

  it('refuses a pool with no room for a peer', () => {
    expect(() => new WireGuardAddressPool('10.250.0.0/31')).toThrow(
      /too small/,
    );
  });

  describe('allocate', () => {
    const pool = () => new WireGuardAddressPool('10.250.0.0/16');

    it('starts at the first host address, not the network address', () => {
      expect(pool().allocate([])).toBe('10.250.0.1');
    });

    it('hands out the lowest free address', () => {
      expect(pool().allocate(['10.250.0.1', '10.250.0.2'])).toBe('10.250.0.3');
    });

    it('reuses a gap left by a released peer', () => {
      expect(pool().allocate(['10.250.0.1', '10.250.0.3'])).toBe('10.250.0.2');
    });

    it('ignores addresses from outside the pool instead of rejecting them', () => {
      // Narrowing the pool must not break allocation for peers that predate it.
      expect(pool().allocate(['10.9.9.9', '10.250.0.1'])).toBe('10.250.0.2');
    });

    it('never hands out the broadcast address', () => {
      const small = new WireGuardAddressPool('10.250.0.0/30');
      expect(small.allocate([])).toBe('10.250.0.1');
      expect(small.allocate(['10.250.0.1'])).toBe('10.250.0.2');
      expect(() => small.allocate(['10.250.0.1', '10.250.0.2'])).toThrow(
        /exhausted/,
      );
    });
  });

  it('knows which addresses belong to it', () => {
    const p = new WireGuardAddressPool('10.250.0.0/16');
    expect(p.contains('10.250.99.4')).toBe(true);
    expect(p.contains('10.251.0.1')).toBe(false);
  });
});

describe('cidrContains', () => {
  it('recognises an address inside its own range', () => {
    expect(cidrContains('10.60.1.0/24', '10.60.1.1')).toBe(true);
    expect(cidrContains('10.60.0.0/16', '10.60.9.42')).toBe(true);
  });

  it('refuses one that merely looks similar', () => {
    expect(cidrContains('10.60.1.0/24', '10.60.2.1')).toBe(false);
    expect(cidrContains('10.60.1.0/24', '110.60.1.1')).toBe(false);
  });

  it('handles a range that is a single address', () => {
    expect(cidrContains('10.60.1.7/32', '10.60.1.7')).toBe(true);
    expect(cidrContains('10.60.1.7/32', '10.60.1.8')).toBe(false);
  });
});

describe('nextFreeBlock', () => {
  it('hands out the first block of a fresh network', () => {
    expect(nextFreeBlock('10.250.0.0/16', [], 24)).toBe('10.250.0.0/24');
  });

  it('skips the blocks already handed out', () => {
    expect(
      nextFreeBlock('10.250.0.0/16', ['10.250.0.0/24', '10.250.1.0/24'], 24),
    ).toBe('10.250.2.0/24');
  });

  it('reuses a gap rather than always growing', () => {
    // A subnet carries no identity a stale config could still name, so unlike
    // a peer address there is nothing to protect by burning it.
    expect(
      nextFreeBlock('10.250.0.0/16', ['10.250.0.0/24', '10.250.2.0/24'], 24),
    ).toBe('10.250.1.0/24');
  });

  it('ignores blocks that belong to another network', () => {
    expect(nextFreeBlock('10.250.0.0/16', ['10.99.0.0/24'], 24)).toBe(
      '10.250.0.0/24',
    );
  });

  it('answers nothing when the network is full', () => {
    const taken = ['10.250.0.0/25', '10.250.0.128/25'];
    expect(nextFreeBlock('10.250.0.0/24', taken, 25)).toBeNull();
  });

  it('refuses a block that cannot fit', () => {
    expect(() => nextFreeBlock('10.250.0.0/24', [], 16)).toThrow(
      /does not fit/,
    );
  });
});

describe('nextFreeBlock at the edges', () => {
  it('returns the whole space for a /0 rather than looping forever', () => {
    expect(nextFreeBlock('0.0.0.0/0', [], 0)).toBe('0.0.0.0/0');
  });

  it('has nothing left to give when the /0 is taken', () => {
    expect(nextFreeBlock('0.0.0.0/0', ['0.0.0.0/0'], 0)).toBeNull();
  });
});

/**
 * A Scaleway private network is dual-stack: `flui network create` returns an
 * IPv4 subnet and an fd00::/8 one, and every range the installation knows about
 * is handed to the pool as something the overlay must not collide with. The
 * parser accepts IPv4 only, so one provider's second subnet refused every
 * address allocation on the installation — the overlay was never reserved, the
 * certificate never carried it, and the reconciler failed on the same string
 * every cycle.
 */
describe('a dual-stack private network', () => {
  const v6 = 'fd6f:4031:d3b0:2ca0::/64';

  it('does not stop a pool from being built', () => {
    expect(
      () => new WireGuardAddressPool('10.250.0.0/16', ['10.80.0.0/24', v6]),
    ).not.toThrow();
  });

  it('still allocates from the pool', () => {
    const pool = new WireGuardAddressPool('10.250.0.0/16', [v6]);
    expect(pool.allocate([])).toBe('10.250.0.1');
  });

  it('does not mask a real IPv4 overlap sitting beside it', () => {
    expect(
      () => new WireGuardAddressPool('10.250.0.0/16', [v6, '10.250.5.0/24']),
    ).toThrow(/overlaps/);
  });

  it('still refuses a mistyped IPv4 range rather than skipping it', () => {
    expect(
      () => new WireGuardAddressPool('10.250.0.0/16', ['10.250.0.0/33']),
    ).toThrow(/Not an IPv4 CIDR/);
  });

  it('is ignored when a subnet block is being chosen too', () => {
    expect(nextFreeBlock('10.88.0.0/16', [v6, '10.88.0.0/24'], 24)).toBe(
      '10.88.1.0/24',
    );
  });
});
