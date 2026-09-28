import { BadRequestException } from '@nestjs/common';

/**
 * The BYOS SSH target is the only thing the dashboard and the CLI write here.
 * The rest of the column is Flui's own, and several keys decide protection:
 * control or workload, which network, whether public SSH is suspended.
 */
const WRITABLE_CLUSTER_KEYS: Record<string, readonly string[]> = {
  byos: ['host', 'port', 'user', 'nodeNetwork'],
};

const WRITABLE_NODE_KEYS: Record<string, readonly string[]> = {};

function assertWritable(
  metadata: Record<string, unknown> | undefined,
  allowed: Record<string, readonly string[]>,
  what: string,
): void {
  if (metadata === undefined || metadata === null) return;
  const refused: string[] = [];
  for (const [key, value] of Object.entries(metadata)) {
    const nested = allowed[key];
    if (!nested) {
      refused.push(key);
      continue;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      refused.push(key);
      continue;
    }
    for (const inner of Object.keys(value)) {
      if (!nested.includes(inner)) refused.push(`${key}.${inner}`);
    }
  }
  if (refused.length) {
    const accepted = Object.entries(allowed).map(
      ([key, inner]) => `${key}.{${inner.join(',')}}`,
    );
    throw new BadRequestException(
      `These ${what} metadata keys cannot be set through the API: ${refused.join(', ')}. ` +
        (accepted.length
          ? `Accepted: ${accepted.join(', ')}.`
          : 'None are accepted.'),
    );
  }
}

export function assertWritableClusterMetadata(
  metadata: Record<string, unknown> | undefined,
): void {
  assertWritable(metadata, WRITABLE_CLUSTER_KEYS, 'cluster');
}

export function assertWritableNodeMetadata(
  metadata: Record<string, unknown> | undefined,
): void {
  assertWritable(metadata, WRITABLE_NODE_KEYS, 'node');
}
