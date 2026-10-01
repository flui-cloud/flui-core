import {
  NO_K3S_PHASE,
  VERIFY_PHASE,
  backupPhaseFor,
  imagePhaseFor,
  k3sClusterFor,
  leftAloneAdvisories,
  manifestClusterFor,
  manifestPhaseFor,
  metadataFor,
  missingValuesAdvisory,
  releaseAssessment,
  unreadableManifestCluster,
  updateAdvisories,
} from './upgrade-plan.util';
import { WITHOUT_BACKUP_ACKNOWLEDGEMENT } from '../interfaces/platform-upgrade.interface';

const control = { id: 'c', name: 'control', clusterType: 'control' as const };

describe('planning a platform update', () => {
  it('blocks a release that is not the one on offer, and turns blocking advisories into blockers', () => {
    const { blockers, advisories } = releaseAssessment(
      {
        updateAvailable: true,
        availableVersion: '2.0.0',
        advisories: [
          { level: 'blocker', title: 'Stop', detail: 'Why.' },
          { level: 'warning', title: 'Careful', detail: 'Now.' },
          {
            level: 'info',
            title: 'This release changes the bootstrap manifests',
            detail: '',
          },
        ],
      } as never,
      '1.9.0',
    );
    expect(blockers.map((b) => b.message)).toEqual([
      'Release 1.9.0 is not the one on offer; 2.0.0 is.',
      'Stop. Why.',
    ]);
    expect(advisories.map((a) => a.title)).toEqual(['Careful']);
  });

  it('lets a missing backup be acknowledged, and nothing else', () => {
    const none = backupPhaseFor(null);
    expect(none.willRun).toBe(false);
    expect(none.blockers).toEqual([
      expect.objectContaining({ phase: 'backup', overridable: true }),
    ]);
    expect(
      backupPhaseFor({ id: 'p', name: 'nightly', userId: 'u' }).blockers,
    ).toEqual([]);
  });

  it('plans the files a cluster would write and names the Secret keys it lacks', () => {
    const cluster = manifestClusterFor(control, {
      planId: 'mp',
      ref: 'r',
      entries: [
        { name: 'a.yaml', action: 'replace', releaseSha: '1' },
        { name: 'b.yaml', action: 'skip', missingSecretKeys: ['ns/s/k'] },
      ],
    });
    expect(cluster).toMatchObject({
      files: [{ name: 'a.yaml', action: 'replace', releaseSha: '1' }],
      leftAlone: 1,
      upToDate: false,
    });
    expect(cluster.blockers[0]).toMatch(/needs a Secret copied from ns\/s\/k/);
    const phase = manifestPhaseFor([
      cluster,
      unreadableManifestCluster(
        { id: 'w', name: 'work', clusterType: 'workload' },
        'timeout',
      ),
    ]);
    expect(phase.willRun).toBe(true);
    expect(phase.blockers).toHaveLength(2);
  });

  it('warns about a stateful image change a refresh leaves alone', () => {
    expect(
      leftAloneAdvisories(control, [
        {
          name: '02-postgres.yaml',
          action: 'skip',
          statefulImageChanges: [
            { workload: 'StatefulSet/postgres/pg', from: 'a', to: 'b' },
          ],
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        level: 'warning',
        title: '02-postgres.yaml on control is left alone',
      }),
    ]);
  });

  it('names the command that lets a refresh render the files it had to leave out', () => {
    const entries = [
      {
        name: '09-flui-api.yaml',
        action: 'skip' as const,
        placeholders: ['FLUI_API_IMAGE_TAG'],
      },
      { name: '00-secrets.yaml', action: 'skip' as const },
      { name: '02-postgres.yaml', action: 'replace' as const },
    ];
    const why =
      'This installation has no record of the values it was built with.';

    expect(
      missingValuesAdvisory(control, { entries, valuesUnavailable: why }),
    ).toEqual({
      level: 'warning',
      title:
        '1 file(s) on control wait for the record of the values it was built with',
      detail: `09-flui-api.yaml are not brought forward: ${why} Rebuild the record with \`flui env install-values\`, then plan again.`,
    });
    const workload = {
      id: 'w',
      name: 'wc-1',
      clusterType: 'workload' as const,
    };
    expect(
      missingValuesAdvisory(workload, { entries, valuesUnavailable: why })
        ?.detail,
    ).toContain('`flui env install-values --cluster wc-1`');
    expect(missingValuesAdvisory(control, { entries })).toBeUndefined();
  });

  it('blocks a moving component whose image cannot be resolved', () => {
    const phase = imagePhaseFor(
      {
        components: [
          {
            key: 'fluiWeb',
            installedVersion: '1',
            targetVersion: '2',
            changed: true,
          },
        ],
      } as never,
      {},
    );
    expect(phase.willRun).toBe(true);
    expect(phase.blockers[0].message).toMatch(/No image could be resolved/);
  });

  it('drops the missing-controller blocker when the manifests phase installs it', () => {
    const plan = {
      clusterId: 'c',
      clusterName: 'control',
      clusterType: 'control' as const,
      recordedVersion: null,
      observedVersion: 'v1',
      targetVersion: 'v2',
      steps: ['v2'],
      nodes: [],
      controller: { installed: false, ready: false },
      upToDate: false,
      blockers: ['The system-upgrade-controller is not installed.'],
    };
    const manifests = {
      ...VERIFY_PHASE,
      clusters: [
        {
          clusterId: 'c',
          clusterName: 'control',
          clusterType: 'control' as const,
          files: [
            {
              name: '02-system-upgrade-controller.yaml',
              action: 'add' as const,
            },
          ],
          upToDate: false,
          blockers: [],
        },
      ],
    };
    expect(k3sClusterFor(plan, manifests).blockers).toEqual([]);
    expect(k3sClusterFor(plan, VERIFY_PHASE).blockers).toHaveLength(1);
  });

  it('warns about migrations and the control going quiet', () => {
    expect(
      updateAdvisories(2, {
        ...NO_K3S_PHASE,
        clusters: [
          {
            clusterId: 'c',
            clusterName: 'control',
            clusterType: 'control',
            upToDate: false,
            blockers: [],
          },
        ],
      }).map((a) => a.title),
    ).toEqual([
      '2 database migration(s) will run',
      'The control cluster is unreachable for a minute or two',
    ]);
    expect(updateAdvisories(0, NO_K3S_PHASE)).toEqual([]);
  });

  it('records a plan with the phases it skips, and the acknowledgement when going without a backup', () => {
    const metadata = metadataFor(
      {
        planId: 'p',
        fromVersion: '1',
        targetVersion: '2',
        bootstrapRef: 'r',
        k3sVersion: null,
        migrations: 0,
        phases: [
          backupPhaseFor(null),
          manifestPhaseFor([]),
          imagePhaseFor({ components: [] } as never, {}),
          NO_K3S_PHASE,
          VERIFY_PHASE,
        ],
        advisories: [],
        blockers: [],
        applicable: true,
        acknowledgement: WITHOUT_BACKUP_ACKNOWLEDGEMENT,
      },
      true,
    );
    expect(metadata.acknowledgement).toBe(WITHOUT_BACKUP_ACKNOWLEDGEMENT);
    expect(metadata.phases.map((p) => [p.key, p.status])).toEqual([
      ['backup', 'skipped'],
      ['manifests', 'skipped'],
      ['images', 'skipped'],
      ['k3s', 'skipped'],
      ['verify', 'pending'],
    ]);
  });
});
