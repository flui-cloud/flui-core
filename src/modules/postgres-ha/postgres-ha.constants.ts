export const CNPG_VERSION = '1.30.1';
export const CNPG_MANIFEST_URL = `https://github.com/cloudnative-pg/cloudnative-pg/releases/download/v${CNPG_VERSION}/cnpg-${CNPG_VERSION}.yaml`;
export const CNPG_NAMESPACE = 'cnpg-system';
export const CNPG_DEPLOYMENT = 'cnpg-controller-manager';
export const CNPG_API_VERSION = 'postgresql.cnpg.io/v1';
/**
 * The same Postgres major and Debian base as Flui's own `flui-postgres`, so a
 * single instance can be copied into a highly available one. The operator's
 * own default is a newer major, which cannot start on that data. Fixed by
 * digest: CloudNativePG rebuilds its images under the same tag.
 */
export const CNPG_POSTGRES_IMAGE =
  'ghcr.io/cloudnative-pg/postgresql:17.11-standard-trixie@sha256:4d0aac315c4d8c3202252bd06fea83b16951cc57234a7b610eeaa382ff4482d0';
export const POSTGRES_HA_QUEUE = 'postgres-ha';
export const POSTGRES_HA_JOB_ACTIVATE = 'activate-database-ha';
/** The only range the copy may stream from. */
export { POD_NETWORK as CLUSTER_POD_NETWORK } from '../infrastructure/clusters/constants';
