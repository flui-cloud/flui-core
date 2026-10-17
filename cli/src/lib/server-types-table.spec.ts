jest.mock('chalk', () => {
  const same = (text: string) => text;
  const chalk: any = new Proxy(same, { get: () => chalk });
  return { __esModule: true, default: chalk };
});

import { serverTypeTable, ServerTypeRow } from './server-types-table';

const row = (
  name: string,
  architecture: string | null | undefined,
): ServerTypeRow => ({
  id: name,
  name,
  cores: '2',
  memory: '4GB',
  disk: '40GB',
  architecture,
  availability: { label: 'All', color: (s) => s },
  price: '€4.99',
  regions: 'fsn1, nbg1',
});

describe('the server-types table', () => {
  it('has an Arch column between Disk and Available', () => {
    const [header] = serverTypeTable([row('cx23', 'x86')]);
    expect(header).toMatch(/Disk\s+Arch\s+Available/);
  });

  it('prints each type’s architecture under it', () => {
    const lines = serverTypeTable([
      row('cx23', 'x86'),
      row('cax11', 'arm'),
      row('mystery', undefined),
    ]);

    const header = lines[0];
    const archAt = header.indexOf('Arch');
    expect(lines[2].slice(archAt, archAt + 4).trim()).toBe('x86');
    expect(lines[3].slice(archAt, archAt + 4).trim()).toBe('arm');
    expect(lines[4].slice(archAt, archAt + 4).trim()).toBe('-');
    expect(lines).toHaveLength(7);
  });

  it('closes with one warning line when any type is arm, and none otherwise', () => {
    const lines = serverTypeTable([row('cx23', 'x86'), row('cax11', 'arm')]);
    expect(lines.slice(-2)).toEqual([
      '',
      '  ⚠  Arm server: apps deployed from a repository are built for x86 and will not run on it. Catalog apps run normally.',
    ]);
    expect(lines.filter((line) => line.includes('Arm server'))).toHaveLength(1);
    expect(serverTypeTable([row('cx23', 'x86')])).toHaveLength(3);
  });
});
