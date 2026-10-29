export const PIRAEUS_VERSION = 'v2.12.0';
export const PIRAEUS_MANIFEST_URL = `https://github.com/piraeusdatastore/piraeus-operator/releases/download/${PIRAEUS_VERSION}/manifest.yaml`;
export const PIRAEUS_NAMESPACE = 'piraeus-datastore';
export const PIRAEUS_OPERATOR_DEPLOYMENT =
  'piraeus-operator-controller-manager';
export const LINSTOR_CONTROLLER_DEPLOYMENT = 'linstor-controller';
export const LINSTOR_CONTROLLER_SELECTOR =
  'app.kubernetes.io/component=linstor-controller';
export const PIRAEUS_API_VERSION = 'piraeus.io/v1';

export const REPLICATED_STORAGE_CLASS = 'flui-replicated';
export const REPLICATED_POOL = 'flui-replicated';
export const REPLICATED_VOLUME_GROUP = 'flui-replicated';
/** Nodes that hold a copy of the data; every other node can still cast the tie-breaking vote. */
export const REPLICATED_STORAGE_NODE_LABEL = 'flui.cloud/replicated-storage';
export const REPLICATED_POOL_FILE = '/var/lib/flui/replicated.img';
export const REPLICATED_POOL_DEFAULT_GIB = 20;

export const REPLICATED_VOLUMES_QUEUE = 'replicated-volumes';
export const REPLICATED_VOLUMES_JOB_ENABLE = 'enable-replicated-volumes';
export const REPLICATED_VOLUMES_JOB_NAMESPACE = 'flui-local-storage';
