jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));

import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { loadAll } from 'js-yaml';
import { CreateBackupDestinationDto } from './dto/create-backup-destination.dto';
import { CreateRestoreJobDto } from './dto/create-restore-job.dto';
import { VeleroClientService } from './services/velero-client.service';

/**
 * F-008 of the September 2026 register, and the sinks the entry did not name.
 *
 * A backup destination's fields, and the namespaces a policy or a restore names,
 * were substituted into manifest text by string concatenation. A newline ends a
 * YAML literal block and `---` starts a new document, so any of them was a way
 * to apply a manifest of one's choosing into `flui-system` or the velero
 * namespace — where a Restore's `spec.hooks` is a command.
 *
 * Two different defences, and both are needed. The fields that reach places
 * which are NOT YAML — a pgBackRest INI, a systemd drop-in on the master — are
 * constrained at the DTO. The fields that cannot be constrained, because an
 * access key is whatever the provider issued, are never put into text at all.
 */

describe('what a backup destination is allowed to say', () => {
  const dtoFor = (over: Record<string, unknown>) =>
    plainToInstance(CreateBackupDestinationDto, {
      name: 'dest',
      provider: 'generic_s3',
      endpoint: 'https://fsn1.your-objectstorage.com',
      region: 'fsn1',
      bucket: 'flui-backups-0a1b2c3d4e5f',
      accessKey: 'AK',
      secretKey: 'SK',
      ...over,
    });

  const failing = async (over: Record<string, unknown>) =>
    (await validate(dtoFor(over))).map((e) => e.property);

  it('accepts the values the product itself generates', async () => {
    expect(await failing({ pathPrefix: 'flui/3f29f52b' })).toEqual([]);
    expect(
      await failing({
        endpoint: 'https://s3.fr-par.scw.cloud',
        region: 'fr-par',
        pathPrefix: 'clusters/control-cluster',
      }),
    ).toEqual([]);
    expect(await failing({ pathPrefix: '' })).toEqual([]);
  });

  it.each([
    ['bucket', 'b\n    - name: poc'],
    ['bucket', 'bucket/with-slash'],
    ['bucket', 'Uppercase'],
    ['pathPrefix', 'p\nrepo1-host-cmd = /bin/sh'],
    ['pathPrefix', 'p" ExecStartPre=/bin/sh'],
    ['region', 'fsn1\n[Service]'],
    ['endpoint', 'https://x\nExecStartPre=/bin/sh'],
    ['endpoint', 'https://x y'],
  ])('refuses %s = %p', async (field, value) => {
    expect(await failing({ [field]: value })).toContain(field);
  });
});

describe('what a policy or a restore may name as a namespace', () => {
  const restoreFor = (over: Record<string, unknown>) =>
    plainToInstance(CreateRestoreJobDto, {
      artifactId: '3f29f52b-4c9e-4c1e-9b1e-2f5a9d1e7700',
      targetKind: 'application',
      targetSelector: over,
    });

  const failing = async (over: Record<string, unknown>) => {
    const errors = await validate(restoreFor(over));
    return errors.flatMap((e) => e.children ?? []).map((e) => e.property);
  };

  it('accepts ordinary namespaces', async () => {
    expect(
      await failing({
        namespaces: ['team-blue'],
        namespaceMapping: { 'team-blue': 'team-blue-restored' },
      }),
    ).toEqual([]);
  });

  it('refuses a namespace that is not a Kubernetes name', async () => {
    expect(await failing({ namespaces: ['ns", "evil'] })).toContain(
      'namespaces',
    );
    expect(await failing({ namespaces: ['ns\n---\nkind: Pod'] })).toContain(
      'namespaces',
    );
  });

  it('checks both halves of a namespace mapping, not only the values', async () => {
    // `each` reaches the values of an object; the key is written into the
    // resource just the same.
    expect(await failing({ namespaceMapping: { 'a\nhooks': 'b' } })).toContain(
      'namespaceMapping',
    );
    expect(await failing({ namespaceMapping: { a: 'b\nhooks:' } })).toContain(
      'namespaceMapping',
    );
  });
});

describe('what reaches a Velero custom resource', () => {
  const client = Object.create(
    VeleroClientService.prototype,
  ) as VeleroClientService;

  const block = (value: unknown, indent: number): string =>
    (
      client as unknown as { yamlBlock: (v: unknown, i: number) => string }
    ).yamlBlock(value, indent);

  it('writes a namespace that tries to close the quote as one string', () => {
    const rendered = `spec:\n  includedNamespaces:\n${block(
      ['ns", "evil'],
      4,
    )}\n`;
    const docs = loadAll(rendered) as Array<{
      spec: { includedNamespaces: string[] };
    }>;

    expect(docs[0].spec.includedNamespaces).toEqual(['ns", "evil']);
  });

  it('writes a namespace mapping that tries to start a new key as one string', () => {
    const rendered = `spec:\n  namespaceMapping:\n${block(
      { 'a\nhooks': 'b' },
      4,
    )}\n`;
    const docs = loadAll(rendered) as Array<{
      spec: { namespaceMapping: Record<string, string> };
    }>;

    expect(Object.keys(docs[0].spec.namespaceMapping)).toEqual(['a\nhooks']);
    expect(docs[0].spec.namespaceMapping['a\nhooks']).toBe('b');
  });

  it('never lets a value open a second document', () => {
    const rendered = `spec:\n  includedNamespaces:\n${block(
      ['ns\n---\nkind: Pod'],
      4,
    )}\n`;

    expect(loadAll(rendered)).toHaveLength(1);
  });

  it('still renders an empty list as a list', () => {
    const rendered = `spec:\n  includedNamespaces:\n${block([], 4)}\n`;
    const docs = loadAll(rendered) as Array<{
      spec: { includedNamespaces: string[] };
    }>;
    expect(docs[0].spec.includedNamespaces).toEqual([]);
  });
});
