import { Logger } from '@nestjs/common';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { DeleteExportInput } from '../interfaces/volume-export.interface';
import {
  CryptPasswords,
  cryptEnv,
  cryptSetupScript,
  remoteName,
} from '../../backups/utils/rclone-crypt.util';

export type RcloneS3Credentials = NonNullable<DeleteExportInput['s3']>;

export interface RcloneS3SecretArgs {
  jobName: string;
  namespace: string;
  labels: Record<string, string>;
  s3: RcloneS3Credentials;
  encryption?: CryptPasswords;
}

export function rcloneS3SecretName(jobName: string): string {
  return `${jobName}-s3`;
}

export function rcloneRemote(
  encrypted: boolean,
  bucket: string,
  keyPrefix: string,
): string {
  return `${remoteName(encrypted)}:${bucket}/${keyPrefix}`;
}

export function renderRcloneS3Secret(
  args: Omit<RcloneS3SecretArgs, 'jobName'> & { name: string },
): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: args.name,
      namespace: args.namespace,
      labels: args.labels,
    },
    type: 'Opaque',
    stringData: {
      RCLONE_CONFIG_FLUI_TYPE: 's3',
      RCLONE_CONFIG_FLUI_PROVIDER: 'Other',
      RCLONE_CONFIG_FLUI_ACCESS_KEY_ID: args.s3.accessKeyId,
      RCLONE_CONFIG_FLUI_SECRET_ACCESS_KEY: args.s3.secretAccessKey,
      RCLONE_CONFIG_FLUI_ENDPOINT: args.s3.endpoint,
      RCLONE_CONFIG_FLUI_REGION: args.s3.region || 'auto',
      ...(args.encryption ? cryptEnv(args.encryption) : {}),
    },
  };
}

export function renderRcloneS3EnvFrom(jobName: string): string {
  return [
    '          envFrom:',
    '            - secretRef:',
    `                name: ${JSON.stringify(rcloneS3SecretName(jobName))}`,
  ].join('\n');
}

export function renderRcloneScriptBlock(
  commands: string[],
  encrypted: boolean,
): string {
  const body = [
    'set -e',
    ...(encrypted ? [cryptSetupScript()] : []),
    ...commands,
  ]
    .join('\n')
    .split('\n')
    .map((l) => (l ? `              ${l}` : ''))
    .join('\n');
  return `            - |\n${body}`;
}

/**
 * The storage credentials, and the crypt secrets when there are any, live
 * in a Secret for exactly as long as the Job that reads them, instead of as
 * literals in a Job spec that anyone who can list Jobs reads back.
 */
export async function withRcloneS3Secret<T>(
  k8s: Pick<KubernetesService, 'applyManifest' | 'deleteResource'>,
  logger: Pick<Logger, 'warn'>,
  kubeconfig: string,
  args: RcloneS3SecretArgs,
  run: () => Promise<T>,
): Promise<T> {
  const name = rcloneS3SecretName(args.jobName);
  await k8s.applyManifest(
    kubeconfig,
    JSON.stringify(
      renderRcloneS3Secret({
        name,
        namespace: args.namespace,
        labels: args.labels,
        s3: args.s3,
        encryption: args.encryption,
      }),
    ),
  );
  try {
    return await run();
  } finally {
    await k8s
      .deleteResource(kubeconfig, 'Secret', name, args.namespace)
      .catch((err: any) =>
        logger.warn(
          `[volume-export] Secret cleanup failed for ${args.namespace}/${name}: ${err.message}`,
        ),
      );
  }
}
