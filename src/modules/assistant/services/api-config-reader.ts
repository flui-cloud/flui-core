import { In, Repository } from 'typeorm';
import type { AppConfigService } from '../../applications/services/app-config.service';
import {
  ClusterEntity,
  CONTROL_CLUSTER_TYPES,
} from '../../infrastructure/clusters/entities/cluster.entity';

export const API_CONFIG_READER = 'GUEST_INFERENCE_API_CONFIG_READER';

/** The API's own variables as they stand now on the control cluster; empty where there is none. */
export type ApiConfigReader = () => Promise<Record<string, string>>;

export const API_CONFIG = { name: 'flui-api-config', namespace: 'flui-system' };

export function controlApiConfigReader(
  clusters: Repository<ClusterEntity>,
  appConfig: AppConfigService,
): ApiConfigReader {
  return async () => {
    const control = await clusters.findOne({
      where: { clusterType: In([...CONTROL_CLUSTER_TYPES]) },
      select: { id: true },
    });
    if (!control) return {};
    const { data } = await appConfig.getClusterConfig(
      control.id,
      API_CONFIG.name,
      API_CONFIG.namespace,
    );
    return data;
  };
}
