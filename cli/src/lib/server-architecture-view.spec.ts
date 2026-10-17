jest.mock('chalk', () => {
  const same = (text: string) => text;
  const chalk: any = new Proxy(same, { get: () => chalk });
  return { __esModule: true, default: chalk };
});

import {
  archLabel,
  assertX86Host,
  hostArchitectureRefusal,
} from './server-architecture-view';

describe('archLabel', () => {
  it('speaks Flui words whoever reported the architecture', () => {
    expect(archLabel('amd64')).toBe('x86');
    expect(archLabel('x86')).toBe('x86');
    expect(archLabel('arm64')).toBe('arm');
    expect(archLabel(null)).toBe('-');
  });
});

describe('a BYOS host', () => {
  it('is accepted when uname -m says x86_64', () => {
    expect(hostArchitectureRefusal('x86_64\n')).toBeNull();
  });

  it.each(['aarch64', 'arm64', 'armv7l'])('is refused when it is %s', (m) => {
    expect(hostArchitectureRefusal(m)).toBe(
      `This host is ${m}. Flui runs on x86 servers only for now, so nothing was installed.`,
    );
  });

  it('is refused when its architecture cannot be read', () => {
    expect(hostArchitectureRefusal('')).toContain('could not be read');
  });

  it('is asked with uname -m before anything else runs', async () => {
    const run = jest.fn().mockResolvedValue('aarch64\n');
    await expect(assertX86Host(run)).rejects.toThrow('This host is aarch64');
    expect(run).toHaveBeenCalledWith('uname -m');

    run.mockResolvedValue('x86_64\n');
    await expect(assertX86Host(run)).resolves.toBe('x86_64');
  });
});
