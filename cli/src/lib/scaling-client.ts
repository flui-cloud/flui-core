import type {
  ClusterScalingDecisionDto,
  ClusterScalingRowDto,
  ScalingDecisionResponseDto,
  ScalingGroupResponseDto,
} from 'src/modules/infrastructure/scaling/dto/scaling-response.dto';
import type { ScalingPreviewDto } from 'src/modules/infrastructure/scaling/dto/scaling-preview.dto';
import { SCALING_ERROR } from 'src/modules/infrastructure/scaling/scaling-errors';
import { ApiClient, ApiError } from './api-client';
import { ConfigStorage } from './config-storage';
import { resolveClusterRef } from './resolve-cluster';
import type { ScalingGroupWrite } from './scaling-file';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The stable `code` the API puts on a refusal, when it put one there. */
function refusalCode(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  const body = error.details as { code?: unknown } | undefined;
  return typeof body?.code === 'string' ? body.code : undefined;
}

/**
 * What a refusal means, read from its code rather than from the shape of its
 * sentence.
 *
 * 404 is three answers here, and the API can only name two of them: the third
 * — a route this build does not serve — is answered by Nest itself and carries
 * no code at all. So an absent code on a 404 is the missing surface, which is
 * the one case where the message has to talk about the installation rather than
 * about what was asked for.
 */
export function scalingErrorLines(
  error: unknown,
  /**
   * What to say when the missing route is newer than the rest of the surface,
   * so an API one build behind is not reported as an API without scaling.
   */
  routeAbsent?: string,
): string[] {
  const message = error instanceof Error ? error.message : String(error);

  switch (refusalCode(error)) {
    case SCALING_ERROR.CLUSTER_NOT_FOUND:
      return [
        message,
        'Run `flui cluster list` to see the clusters you may read.',
      ];
    case SCALING_ERROR.GROUP_NOT_FOUND:
      return [
        message,
        'Run `flui scaling list --cluster <name>` to see the groups a cluster holds.',
      ];
    case SCALING_ERROR.GROUP_NAME_TAKEN:
      return [
        message,
        'A group is found by its name, so applying the same file again rewrites that group rather than adding a second one.',
      ];
    default:
      break;
  }

  const noCode = error instanceof ApiError && error.statusCode === 404;
  return noCode
    ? [
        routeAbsent ??
          'This installation’s API does not serve scaling groups: it is running a build without them.',
        message,
      ]
    : [message];
}

/** A group is addressed by name inside its cluster, or by the id anywhere. */
export function isGroupId(value: string): boolean {
  return UUID.test(value.trim());
}

/**
 * Which group a command meant, when the person named one, named none, or named
 * a cluster that holds several.
 *
 * Silently taking the first of several would make `why` answer about a group
 * nobody asked about, which is worse than asking.
 */
export function pickGroup(
  groups: ScalingGroupResponseDto[],
  clusterLabel: string,
  wanted?: string,
): ScalingGroupResponseDto {
  if (wanted) {
    const needle = wanted.trim().toLowerCase();
    const match = groups.find(
      (g) => g.id === wanted.trim() || g.name.toLowerCase() === needle,
    );
    if (match) return match;
    throw new Error(
      `No scaling group "${wanted}" on ${clusterLabel}.` + listOrHint(groups),
    );
  }

  if (groups.length === 1) return groups[0];
  if (groups.length === 0) {
    throw new Error(
      `${clusterLabel} has no scaling group. Write one with \`flui scaling apply -f <file>\`.`,
    );
  }
  throw new Error(
    `${clusterLabel} has ${groups.length} scaling groups. Name one:` +
      listOrHint(groups),
  );
}

function listOrHint(groups: ScalingGroupResponseDto[]): string {
  if (!groups.length) {
    return ' This cluster has no scaling group at all.';
  }
  return '\n' + groups.map((g) => `  • ${g.name}  (${g.id})`).join('\n');
}

/**
 * The reads and writes of the scaling surface, in one place.
 *
 * Everything travels over HTTP so the same permissions decide here as in the
 * dashboard: `cluster:read` to look, `cluster:manage` to write.
 */
export class ScalingClient {
  constructor(private readonly api: ApiClient) {}

  static open(): ScalingClient {
    const storage = new ConfigStorage();
    const baseUrl = storage.getApiUrlOrThrow();
    const apiKey = storage.getApiKey();
    if (!apiKey) {
      throw new Error('Not logged in. Run `flui auth login` first.');
    }
    return new ScalingClient(new ApiClient({ baseUrl, apiKey }));
  }

  rows(): Promise<ClusterScalingRowDto[]> {
    return this.api.get<ClusterScalingRowDto[]>('/infrastructure/scaling');
  }

  rowFor(clusterId: string): Promise<ClusterScalingRowDto> {
    return this.api.get<ClusterScalingRowDto>(
      `/infrastructure/clusters/${clusterId}/scaling`,
    );
  }

  groupsOf(clusterId: string): Promise<ScalingGroupResponseDto[]> {
    return this.api.get<ScalingGroupResponseDto[]>(
      `/infrastructure/clusters/${clusterId}/scaling-groups`,
    );
  }

  byId(id: string): Promise<ScalingGroupResponseDto> {
    return this.api.get<ScalingGroupResponseDto>(
      `/infrastructure/scaling-groups/${id}`,
    );
  }

  create(
    clusterId: string,
    group: ScalingGroupWrite,
  ): Promise<ScalingGroupResponseDto> {
    return this.api.post<ScalingGroupResponseDto>(
      `/infrastructure/clusters/${clusterId}/scaling-groups`,
      group,
    );
  }

  /** The whole group, every time: each block is replaced whole on the way in. */
  update(
    id: string,
    group: ScalingGroupWrite,
  ): Promise<ScalingGroupResponseDto> {
    return this.api.patch<ScalingGroupResponseDto>(
      `/infrastructure/scaling-groups/${id}`,
      group,
    );
  }

  /** The same engine the reconciler runs, asked on demand and spending nothing. */
  preview(id: string): Promise<ScalingPreviewDto> {
    return this.api.get<ScalingPreviewDto>(
      `/infrastructure/scaling-groups/${id}/preview`,
    );
  }

  decisions(id: string, limit: number): Promise<ScalingDecisionResponseDto[]> {
    return this.api.get<ScalingDecisionResponseDto[]>(
      `/infrastructure/scaling-groups/${id}/decisions?limit=${limit}`,
    );
  }

  /**
   * Every group's decisions at once, newest first, each one naming the group it
   * came from — so the question can be asked of the cluster it is asked about.
   */
  clusterDecisions(
    clusterId: string,
    limit: number,
  ): Promise<ClusterScalingDecisionDto[]> {
    return this.api.get<ClusterScalingDecisionDto[]>(
      `/infrastructure/clusters/${clusterId}/scaling-decisions?limit=${limit}`,
    );
  }
}

export interface ResolvedGroup {
  group: ScalingGroupResponseDto;
  /** The cluster it was reached through, for the messages that name one. */
  clusterLabel: string;
}

export async function resolveGroup(
  client: ScalingClient,
  clusterFlag?: string,
  wanted?: string,
): Promise<ResolvedGroup> {
  if (wanted && isGroupId(wanted)) {
    const group = await client.byId(wanted.trim());
    return { group, clusterLabel: group.clusterName };
  }

  const cluster = await resolveClusterRef(clusterFlag);
  const groups = await client.groupsOf(cluster.id);
  return {
    group: pickGroup(groups, `Cluster "${cluster.name}"`, wanted),
    clusterLabel: cluster.name,
  };
}
