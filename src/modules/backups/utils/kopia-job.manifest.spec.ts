import { execFileSync } from 'node:child_process';
import {
  KOPIA_JOB_RESOURCES,
  kopiaJobDeadlineSeconds,
  kopiaJobName,
  kopiaRepositoryLabel,
  renderKopiaSecret,
} from './kopia-job.manifest';
import {
  KopiaSnapshotJobInput,
  renderKopiaSnapshotJob,
} from './kopia-snapshot-job.manifest';
import { renderKopiaRestoreJob } from './kopia-restore-job.manifest';
import { KOPIA_IMAGE, kopiaLocation } from './kopia-repository.util';
import { DEFAULT_KOPIA_RETENTION } from './kopia-retention.util';

const PASSWORD = 'derived-repository-password-value';
const ACCESS = 'AKIDEXAMPLEACCESS';
const SECRET = 'secret/access+key';
const APP = 'app-1';
const location = kopiaLocation(
  {
    bucket: 'backups',
    endpoint: 'https://s3.fr-par.scw.cloud',
    region: 'fr-par',
    pathPrefix: 'flui/x',
  },
  APP,
);

function snapshotInput(
  over: Partial<KopiaSnapshotJobInput> = {},
): KopiaSnapshotJobInput {
  return {
    jobName: 'kopia-snap-abc',
    namespace: 'ns',
    appId: APP,
    volumeName: 'data-web',
    location,
    retention: DEFAULT_KOPIA_RETENTION,
    applyRetention: true,
    pin: false,
    description: '$(touch /tmp/pwned) `id`',
    trigger: 'scheduled',
    sqlite: false,
    verify: false,
    nodeName: 'node-a',
    sizeGb: 20,
    labels: { 'flui-app-id': APP },
    ...over,
  };
}

function container(job: any): any {
  return job.spec.template.spec.containers[0];
}

function scriptOf(job: any): string {
  const cmd: string = container(job).command[2];
  const b64 = /^echo (\S+) \| base64 -d \| sh$/.exec(cmd)![1];
  return Buffer.from(b64, 'base64').toString('utf-8');
}

function shellParses(script: string): void {
  execFileSync('sh', ['-n'], { input: script });
}

describe('the kopia snapshot Job', () => {
  it('carries no secret: the password and the keys live only in its Secret', () => {
    const job = renderKopiaSnapshotJob(snapshotInput());
    const secret = renderKopiaSecret({
      name: 'kopia-snap-abc-secret',
      namespace: 'ns',
      labels: {},
      password: PASSWORD,
      accessKeyId: ACCESS,
      secretAccessKey: SECRET,
    });
    const rendered = JSON.stringify(job) + scriptOf(job);
    for (const literal of [PASSWORD, ACCESS, SECRET]) {
      expect(rendered).not.toContain(literal);
    }
    expect((secret as any).stringData).toEqual({
      KOPIA_PASSWORD: PASSWORD,
      AWS_ACCESS_KEY_ID: ACCESS,
      AWS_SECRET_ACCESS_KEY: SECRET,
    });
    expect(container(job).envFrom).toEqual([
      { secretRef: { name: 'kopia-snap-abc-secret' } },
    ]);
  });

  it('keeps a typed description out of the script, so it cannot become shell', () => {
    const job = renderKopiaSnapshotJob(snapshotInput());
    expect(scriptOf(job)).not.toContain('pwned');
    expect(container(job).env).toContainEqual({
      name: 'FLUI_KOPIA_DESCRIPTION',
      value: '$(touch /tmp/pwned) `id`',
    });
    expect(scriptOf(job)).toContain('--description="$FLUI_KOPIA_DESCRIPTION"');
  });

  it('runs the pinned image with requests, limits and a size-scaled deadline, beside the volume', () => {
    const job: any = renderKopiaSnapshotJob(snapshotInput());
    expect(container(job).image).toBe(KOPIA_IMAGE);
    expect(container(job).resources).toEqual(KOPIA_JOB_RESOURCES);
    expect(container(job).env).toContainEqual({
      name: 'GOMEMLIMIT',
      value: '900MiB',
    });
    expect(job.spec.activeDeadlineSeconds).toBe(30 * 60 + 20 * 60);
    expect(job.spec.backoffLimit).toBe(1);
    expect(job.spec.template.spec.nodeSelector).toEqual({
      'kubernetes.io/hostname': 'node-a',
    });
    expect(job.spec.template.spec.tolerations).toHaveLength(2);
    expect(container(job).volumeMounts).toContainEqual({
      name: 'src',
      mountPath: '/flui/volumes/data-web',
      readOnly: true,
    });
    expect(job.spec.template.spec.volumes[0]).toEqual({
      name: 'src',
      persistentVolumeClaim: { claimName: 'data-web', readOnly: true },
    });
    expect(job.spec.template.spec.initContainers).toBeUndefined();
  });

  it('creates the repository with the chosen format and sets policy, owner and maintenance', () => {
    const script = scriptOf(renderKopiaSnapshotJob(snapshotInput()));
    shellParses(script);
    expect(script).toContain(
      'kopia repository create "$@" --object-splitter=DYNAMIC-1M-BUZHASH --encryption=AES256-GCM-HMAC-SHA256',
    );
    expect(script).toContain(
      '"--override-username=flui" "--override-hostname=$FLUI_KOPIA_HOST"',
    );
    expect(script).toContain(
      'kopia maintenance set --owner=me --enable-quick=true --quick-interval=1h --enable-full=true --full-interval=168h',
    );
    expect(script).toContain(
      'kopia policy set --global --compression=zstd-fastest',
    );
    expect(script).toContain(
      'kopia policy set --global --keep-latest=1 --keep-hourly=0 --keep-daily=7 --keep-weekly=4 --keep-monthly=0 --keep-annual=0',
    );
    expect(script).toContain(
      'nice -n 10 kopia snapshot create "$SRC" --no-progress --parallel=2 --checkpoint-interval=10m',
    );
    expect(script).toContain('kopia maintenance run $FULL');
    expect(script).not.toContain('--pin=');
    expect(script).not.toContain('--override-source');
    expect(script).not.toContain('snapshot verify');
  });

  it('pins an ad-hoc snapshot under its own source and leaves the repository retention alone unless it just created it', () => {
    const job = renderKopiaSnapshotJob(
      snapshotInput({
        pin: true,
        applyRetention: false,
        trigger: 'manual',
        sqlite: true,
      }),
    );
    const script = scriptOf(job);
    shellParses(script);
    expect(script).toContain('--pin=flui-manual');
    expect(script).toContain(
      'kopia snapshot create "$SRC" --override-source="$TGT"',
    );
    expect(script).toContain(
      'kopia snapshot create "$SQL" --override-source="$SQLT"',
    );
    expect(script).toContain('kopia snapshot list "$TGT" --json');
    expect(container(job).env).toEqual(
      expect.arrayContaining([
        {
          name: 'FLUI_KOPIA_TARGET',
          value: 'flui@flui-app-1:/flui/manual/volumes/data-web',
        },
        {
          name: 'FLUI_KOPIA_SQLITE_TARGET',
          value: 'flui@flui-app-1:/flui/manual/sqlite/data-web/data',
        },
      ]),
    );
    expect(script).toContain(
      'if [ "${CREATED:-0}" = 1 ]; then kopia policy set --global --keep-latest=1',
    );
  });

  it('adds the monthly spot check only when it is due', () => {
    const script = scriptOf(
      renderKopiaSnapshotJob(snapshotInput({ verify: true })),
    );
    shellParses(script);
    expect(script).toContain(
      'kopia snapshot verify --verify-files-percent=2 --file-parallelism=2',
    );
  });

  it('takes SQLite copies first and snapshots them beside the volume, whose live files it ignores', () => {
    const job: any = renderKopiaSnapshotJob(snapshotInput({ sqlite: true }));
    const script = scriptOf(job);
    shellParses(script);
    expect(job.spec.template.spec.initContainers[0].name).toBe(
      'sqlite-snapshot',
    );
    expect(
      job.spec.template.spec.volumes[0].persistentVolumeClaim.readOnly,
    ).toBe(false);
    expect(container(job).volumeMounts).toContainEqual({
      name: 'stage',
      mountPath: '/flui/sqlite/data-web',
    });
    expect(container(job).env).toContainEqual({
      name: 'FLUI_KOPIA_SQLITE_SOURCE',
      value: '/flui/sqlite/data-web/data',
    });
    expect(script).toContain(
      'for s in "" -wal -shm -journal; do kopia policy set "$TGT" "--add-ignore=/$esc$s"',
    );
    expect(script).toContain('kopia snapshot create "$SQL"');
    expect(script).toContain('FLUI_KOPIA_SQLITE_SNAPSHOTS=');
  });
});

describe('a snapshot taken before a deploy', () => {
  it('keeps its own history beside the schedule, unpinned, so retention still applies to it', () => {
    const job = renderKopiaSnapshotJob(
      snapshotInput({ trigger: 'pre-deploy', sqlite: true }),
    );
    const script = scriptOf(job);
    shellParses(script);
    expect(script).not.toContain('--pin=');
    expect(script).toContain(
      'kopia snapshot create "$SRC" --override-source="$TGT"',
    );
    expect(script).toContain('--tags="flui-trigger:pre-deploy"');
    expect(container(job).env).toEqual(
      expect.arrayContaining([
        {
          name: 'FLUI_KOPIA_TARGET',
          value: 'flui@flui-app-1:/flui/pre-deploy/volumes/data-web',
        },
        {
          name: 'FLUI_KOPIA_SQLITE_TARGET',
          value: 'flui@flui-app-1:/flui/pre-deploy/sqlite/data-web/data',
        },
      ]),
    );
  });
});

describe('the kopia restore Job', () => {
  const base = {
    jobName: 'kopia-restore-abc',
    namespace: 'ns',
    repositoryAppId: APP,
    location,
    targetPvcName: 'data-web-restored',
    primarySnapshotId: 'aaaa0000bbbb1111cccc2222dddd3333',
    labels: {},
  };

  it('reads read-only as the API identity, which can never run maintenance', () => {
    const job: any = renderKopiaRestoreJob(base);
    const script = scriptOf(job);
    shellParses(script);
    expect(script).toContain('"--override-username=flui-api"');
    expect(script).toContain('kopia repository connect "$@" --readonly');
    expect(script).not.toContain('repository create');
    expect(script).not.toContain('maintenance');
    expect(script).toContain(
      'kopia snapshot restore "$FLUI_KOPIA_PRIMARY" "$D"',
    );
    expect(container(job).volumeMounts[0]).toEqual({
      name: 'target',
      mountPath: '/flui/restore',
    });
  });

  it('passes selected paths encoded, never as shell', () => {
    const paths = ['uploads/a b.pdf', 'db/app.sqlite', '$(reboot)'];
    const job: any = renderKopiaRestoreJob({
      ...base,
      paths,
      targetDirectory: 'restored',
      sqliteSnapshotId: 'eeee0000ffff1111',
    });
    const script = scriptOf(job);
    shellParses(script);
    expect(script).not.toContain('reboot');
    const env = Object.fromEntries(
      container(job).env.map((e: any) => [e.name, e.value]),
    );
    expect(Buffer.from(env.FLUI_KOPIA_PATHS, 'base64').toString()).toBe(
      paths.join('\n'),
    );
    expect(env.FLUI_KOPIA_TARGET_DIR).toBe('restored');
    expect(env.FLUI_KOPIA_SQLITE).toBe('eeee0000ffff1111');
    expect(script).toContain(
      'kopia snapshot restore "$FLUI_KOPIA_SQLITE/$p" "$dst"',
    );
    expect(script).toContain('rm -f "$f-wal" "$f-shm" "$f-journal"');
  });
});

describe('Job naming and budget', () => {
  it('scales the deadline with the volume, within twelve hours', () => {
    expect(kopiaJobDeadlineSeconds(undefined)).toBe(1800);
    expect(kopiaJobDeadlineSeconds(0.4)).toBe(1860);
    expect(kopiaJobDeadlineSeconds(100)).toBe(1800 + 6000);
    expect(kopiaJobDeadlineSeconds(5000)).toBe(12 * 3600);
  });

  it('names Jobs within label limits and labels one repository the same way', () => {
    expect(kopiaJobName('restore', 'x'.repeat(300)).length).toBeLessThanOrEqual(
      63,
    );
    expect(kopiaRepositoryLabel('d1', 'a1')).toBe(
      kopiaRepositoryLabel('d1', 'a1'),
    );
    expect(kopiaRepositoryLabel('d1', 'a1')).not.toBe(
      kopiaRepositoryLabel('d2', 'a1'),
    );
    expect(kopiaRepositoryLabel('d1', 'a1')).toMatch(/^[0-9a-f]{32}$/);
  });
});
