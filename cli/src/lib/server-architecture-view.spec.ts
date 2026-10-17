jest.mock('chalk', () => {
  const same = (text: string) => text;
  const chalk: any = new Proxy(same, { get: () => chalk });
  return { __esModule: true, default: chalk };
});

import {
  archLabel,
  armWarningLine,
  deployWarningLines,
  hostArchitectureWarning,
  warnAboutHostArchitecture,
} from './server-architecture-view';

const ARM_WARNING =
  'Arm server: apps deployed from a repository are built for x86 and will not run on it. Catalog apps run normally.';

describe('archLabel', () => {
  it('speaks Flui words whoever reported the architecture', () => {
    expect(archLabel('amd64')).toBe('x86');
    expect(archLabel('x86')).toBe('x86');
    expect(archLabel('arm64')).toBe('arm');
    expect(archLabel(null)).toBe('-');
  });
});

describe('the arm warning line', () => {
  it('carries the warning', () => {
    expect(armWarningLine()).toBe(`⚠  ${ARM_WARNING}`);
  });
});

describe('a BYOS host', () => {
  it('passes silently when uname -m says x86_64', () => {
    expect(hostArchitectureWarning('x86_64\n')).toBeNull();
  });

  it.each(['aarch64', 'arm64'])('is warned about when it is %s', (m) => {
    expect(hostArchitectureWarning(m)).toBe(ARM_WARNING);
  });

  it('is warned about, never refused, when its architecture is unknown or unreadable', () => {
    expect(hostArchitectureWarning('riscv64')).toContain(
      'riscv64, an architecture Flui does not know; continuing',
    );
    expect(hostArchitectureWarning('')).toContain('could not be read');
  });

  it('is asked with uname -m and only ever printed a warning', async () => {
    const print = jest.fn();
    const run = jest.fn().mockResolvedValue('aarch64\n');
    await expect(
      warnAboutHostArchitecture(run, print),
    ).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledWith('uname -m');
    expect(print).toHaveBeenCalledWith(`\n⚠  ${ARM_WARNING}\n`);

    print.mockClear();
    run.mockResolvedValue('x86_64\n');
    await warnAboutHostArchitecture(run, print);
    expect(print).not.toHaveBeenCalled();

    run.mockRejectedValue(new Error('ssh down'));
    await warnAboutHostArchitecture(run, print);
    expect(print).toHaveBeenCalledWith(
      expect.stringContaining('could not be read; continuing'),
    );
  });
});

describe('a deploy that carries warnings', () => {
  it('prints one line for each, and nothing when there are none', () => {
    expect(deployWarningLines([ARM_WARNING])).toEqual([`  ⚠  ${ARM_WARNING}`]);
    expect(deployWarningLines(undefined)).toEqual([]);
  });
});
