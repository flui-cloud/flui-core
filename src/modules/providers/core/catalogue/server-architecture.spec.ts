import { BadRequestException, Logger } from '@nestjs/common';
import {
  architectureOfType,
  assertProviderSellsSupportedType,
  assertSupportedServerType,
  normaliseArchitecture,
  offerableSizes,
} from './server-architecture';
import { NodeSizeMapper } from '../../mappers/node-size.mapper';

const size = (name: string, architecture: 'x86' | 'arm', id = name) =>
  ({ id, name, architecture }) as never;

describe('normaliseArchitecture', () => {
  it.each([
    ['x86', 'x86'],
    ['x86_64', 'x86'],
    ['amd64', 'x86'],
    ['arm', 'arm'],
    ['arm64', 'arm'],
    ['aarch64', 'arm'],
    [' AMD64 ', 'x86'],
  ])('reads %s as %s', (raw, expected) => {
    expect(normaliseArchitecture(raw)).toBe(expected);
  });

  it.each([undefined, null, '', 'unknown_arch', 'riscv64'])(
    'has no answer for %p',
    (raw) => {
      expect(normaliseArchitecture(raw)).toBeNull();
    },
  );
});

describe('offering server types', () => {
  it('keeps x86 types only', () => {
    const sizes = [size('cx23', 'x86'), size('cax11', 'arm')];
    expect(offerableSizes(sizes)).toEqual([sizes[0]]);
  });

  it('finds a type by name or by id', () => {
    const sizes = [size('cax11', 'arm', '45')];
    expect(architectureOfType('cax11', sizes)).toBe('arm');
    expect(architectureOfType('45', sizes)).toBe('arm');
    expect(architectureOfType('cx23', sizes)).toBeNull();
  });
});

describe('refusing an arm server type', () => {
  const sizes = [size('cx23', 'x86'), size('COPARM1-2C-8G', 'arm')];

  it('refuses it with a 400 that names the type', () => {
    expect(() => assertSupportedServerType('COPARM1-2C-8G', sizes)).toThrow(
      new BadRequestException(
        'Flui runs on x86 servers only for now; COPARM1-2C-8G is arm',
      ),
    );
  });

  it('lets an x86 type through, and one the catalogue does not name', () => {
    expect(() => assertSupportedServerType('cx23', sizes)).not.toThrow();
    expect(() => assertSupportedServerType('nope', sizes)).not.toThrow();
  });

  it('reads the catalogue from the provider that would sell it', async () => {
    const provider = { getNodeSizes: jest.fn().mockResolvedValue(sizes) };
    await expect(
      assertProviderSellsSupportedType(provider, 'COPARM1-2C-8G'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      assertProviderSellsSupportedType(provider, 'cx23'),
    ).resolves.toBeUndefined();
    expect(provider.getNodeSizes).toHaveBeenCalledWith(false);
  });

  it('refuses a known arm family by name when the catalogue cannot be read', async () => {
    const provider = {
      getNodeSizes: jest.fn().mockRejectedValue(new Error('down')),
    };
    await expect(
      assertProviderSellsSupportedType(provider, 'cax11'),
    ).rejects.toThrow('Flui runs on x86 servers only for now; cax11 is arm');
    await expect(
      assertProviderSellsSupportedType(provider, 'COPARM1-2C-8G'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      assertProviderSellsSupportedType(provider, 'BASIC2-A2C-8G'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lets any other type through an unreadable catalogue, with a warning', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const provider = {
      getNodeSizes: jest.fn().mockRejectedValue(new Error('down')),
    };
    await expect(
      assertProviderSellsSupportedType(provider, 'cx23'),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('cx23 passes without an architecture check'),
    );
    await expect(
      assertProviderSellsSupportedType(null, 'cax11'),
    ).resolves.toBeUndefined();
    warn.mockRestore();
  });
});

describe('Hetzner catalogue mapping', () => {
  it('keeps the architecture Hetzner names, arm included', () => {
    const mapper = new NodeSizeMapper();
    const base = {
      description: '',
      cores: 2,
      memory: 4,
      disk: 40,
      storage_type: 'local',
      cpu_type: 'shared',
      deprecated: false,
      prices: [],
      locations: [],
    };
    const [x86, arm] = mapper.mapHetznerServerTypesToDtos([
      { ...base, id: 1, name: 'cx23', architecture: 'x86' },
      { ...base, id: 2, name: 'cax11', architecture: 'arm' },
    ] as never);
    expect(x86.architecture).toBe('x86');
    expect(arm.architecture).toBe('arm');
  });
});
