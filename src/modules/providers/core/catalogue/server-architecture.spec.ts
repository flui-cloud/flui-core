import { Logger } from '@nestjs/common';
import {
  ARM_SERVER_WARNING,
  architectureOfType,
  architectureWarning,
  normaliseArchitecture,
  providerServerTypeWarning,
  serverTypeWarning,
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

describe('architecture warning', () => {
  it('warns about arm and says nothing about x86 or an unknown one', () => {
    expect(architectureWarning('arm64')).toBe(ARM_SERVER_WARNING);
    expect(architectureWarning('x86')).toBeNull();
    expect(architectureWarning(null)).toBeNull();
    expect(ARM_SERVER_WARNING).toBe(
      'Arm server: apps deployed from a repository are built for x86 and will not run on it. Catalog apps run normally.',
    );
  });

  it('finds a type by name or by id', () => {
    const sizes = [size('cax11', 'arm', '45')];
    expect(architectureOfType('cax11', sizes)).toBe('arm');
    expect(architectureOfType('45', sizes)).toBe('arm');
    expect(architectureOfType('cx23', sizes)).toBeNull();
  });
});

describe('an arm server type is allowed, with a warning', () => {
  const sizes = [size('cx23', 'x86'), size('COPARM1-2C-8G', 'arm')];

  it('warns about an arm type and says nothing about the others', () => {
    expect(serverTypeWarning('COPARM1-2C-8G', sizes)).toBe(ARM_SERVER_WARNING);
    expect(serverTypeWarning('cx23', sizes)).toBeNull();
    expect(serverTypeWarning('nope', sizes)).toBeNull();
  });

  it('reads the catalogue from the provider that would sell it', async () => {
    const provider = { getNodeSizes: jest.fn().mockResolvedValue(sizes) };
    await expect(
      providerServerTypeWarning(provider, 'COPARM1-2C-8G'),
    ).resolves.toBe(ARM_SERVER_WARNING);
    await expect(
      providerServerTypeWarning(provider, 'cx23'),
    ).resolves.toBeNull();
    expect(provider.getNodeSizes).toHaveBeenCalledWith(false);
  });

  it('knows an arm family by name when the catalogue cannot be read', async () => {
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    const provider = {
      getNodeSizes: jest.fn().mockRejectedValue(new Error('down')),
    };
    for (const type of ['cax11', 'COPARM1-2C-8G', 'BASIC2-A2C-8G']) {
      await expect(providerServerTypeWarning(provider, type)).resolves.toBe(
        ARM_SERVER_WARNING,
      );
    }
    await expect(
      providerServerTypeWarning(provider, 'cx23'),
    ).resolves.toBeNull();
    await expect(providerServerTypeWarning(null, 'cax11')).resolves.toBe(
      ARM_SERVER_WARNING,
    );
    await expect(
      providerServerTypeWarning(provider, undefined),
    ).resolves.toBeNull();
    log.mockRestore();
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
