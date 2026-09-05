// File: src/modules/infrastructure/servers/entities/infrastructure-operations.entity.ts

import { CloudProvider } from 'src/modules/providers/enums/cloud-provider.enum';
import {
  BeforeInsert,
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import {
  currentActor,
  currentGrantId,
} from '../../../auth/utils/actor-context';
import { CreateServerDto } from '../dto/create-server.dto';
import { DeleteServerDto } from '../dto/delete-server.dto';
import { CreateClusterDto } from '../../clusters/dto/create-cluster.dto';
import { OperationStepConfig } from '../../operations/helpers/operation-steps.helper';

export enum OperationType {
  CREATE_SERVER = 'create_server',
  DELETE_SERVER = 'delete_server',
  UPDATE_SERVER = 'update_server',
  START_SERVER = 'start_server',
  STOP_SERVER = 'stop_server',
  RESTART_SERVER = 'restart_server',
  // Cluster operations
  CREATE_CLUSTER = 'create_cluster',
  DELETE_CLUSTER = 'delete_cluster',
  REINSTALL_CLUSTER = 'reinstall_cluster',
  ADD_WORKER = 'add_worker',
  REMOVE_WORKER = 'remove_worker',
  SCALE_NODE = 'scale_node',
  EXPAND_SHARED_VOLUME = 'expand_shared_volume',
  START_CLUSTER = 'start_cluster',
  STOP_CLUSTER = 'stop_cluster',
  ATTACH_CLUSTER_TO_VNET = 'attach_cluster_to_vnet',
  REBUILD_CLUSTER = 'rebuild_cluster',
  // Application build operations
  BUILD_APPLICATION = 'build_application',
  // Build cache operations
  CLEAR_BUILD_CACHE = 'clear_build_cache',
  // Application operations
  DEPLOY_APPLICATION = 'deploy_application',
  UPDATE_APPLICATION = 'update_application',
  DELETE_APPLICATION = 'delete_application',
  ROLLBACK_APPLICATION = 'rollback_application',
  // Catalog operations
  INSTALL_CATALOG_APP = 'install_catalog_app',
  UNINSTALL_CATALOG_APP = 'uninstall_catalog_app',
  // Authz operations
  INSTALL_AUTHZ = 'install_authz',
  UNINSTALL_AUTHZ = 'uninstall_authz',
  // Backup operations
  CREATE_BACKUP_DESTINATION = 'create_backup_destination',
  HEALTH_CHECK_DESTINATION = 'health_check_destination',
  INSTALL_VELERO = 'install_velero',
  UNINSTALL_VELERO = 'uninstall_velero',
  RUN_BACKUP_JOB = 'run_backup_job',
  REPLICATE_BACKUP = 'replicate_backup',
  RUN_RESTORE_JOB = 'run_restore_job',
  RESTORE_PREVIEW = 'restore_preview',
  PRE_DEPLOY_SNAPSHOT = 'pre_deploy_snapshot',
  ENABLE_ETCD_SNAPSHOTS = 'enable_etcd_snapshots',
  CREATE_PROVIDER_SNAPSHOT = 'create_provider_snapshot',
  RESTORE_FROM_PROVIDER_SNAPSHOT = 'restore_from_provider_snapshot',
  BACKUP_QUICK_SETUP = 'backup_quick_setup',
  // Provider VM-level backups (whole-VM imaging by the cloud provider)
  ENABLE_VM_BACKUPS = 'enable_vm_backups',
  DISABLE_VM_BACKUPS = 'disable_vm_backups',
  // Application-level volume operations
  APP_SNAPSHOT_CREATE = 'app_snapshot_create',
  APP_SNAPSHOT_DELETE = 'app_snapshot_delete',
  APP_SNAPSHOT_RESTORE = 'app_snapshot_restore',
  APP_VOLUME_SWAP = 'app_volume_swap',
  APP_BACKUP_CREATE = 'app_backup_create',
  // Database lifecycle
  MIGRATE_DATABASE = 'migrate_database',
  // Application lifecycle
  MIGRATE_APPLICATION = 'migrate_application',
  // Full-app lifecycle (app + DB)
  MIGRATE_FULL_APP = 'migrate_full_app',
}

export enum OperationStatus {
  PENDING = 'PENDING',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

// Operation Steps - Granular steps for tracking operation progress
export enum OperationStep {
  // Server creation steps
  SERVER_CREATE_INIT = 'server_create_init',
  SERVER_CREATE_PROVISIONING = 'server_create_provisioning',
  SERVER_CREATE_WAITING = 'server_create_waiting',
  SERVER_CREATE_FINALIZING = 'server_create_finalizing',

  // Server deletion steps
  SERVER_DELETE_INIT = 'server_delete_init',
  SERVER_DELETE_EXECUTING = 'server_delete_executing',
  SERVER_DELETE_WAITING = 'server_delete_waiting',
  SERVER_DELETE_CLEANUP = 'server_delete_cleanup',

  // Cluster creation steps
  CLUSTER_CREATE_INIT = 'cluster_create_init',
  CLUSTER_CREATE_MASTER = 'cluster_create_master',
  CLUSTER_CREATE_MASTER_WAIT_K3S = 'cluster_create_master_wait_k3s',
  CLUSTER_CREATE_KUBECONFIG = 'cluster_create_kubeconfig',
  CLUSTER_CREATE_WORKERS = 'cluster_create_workers',
  CLUSTER_CREATE_FINALIZING = 'cluster_create_finalizing',

  // Cluster reinstall steps (wipe + re-bootstrap an existing provider-owned server)
  CLUSTER_REINSTALL_INIT = 'cluster_reinstall_init',
  CLUSTER_REINSTALL_PURGE = 'cluster_reinstall_purge',
  CLUSTER_REINSTALL_BOOTSTRAP = 'cluster_reinstall_bootstrap',
  CLUSTER_REINSTALL_OBSERVABILITY = 'cluster_reinstall_observability',
  CLUSTER_REINSTALL_FINALIZE = 'cluster_reinstall_finalize',

  // Cluster deletion steps
  CLUSTER_DELETE_INIT = 'cluster_delete_init',
  CLUSTER_DELETE_NODES = 'cluster_delete_nodes',
  CLUSTER_DELETE_WAITING = 'cluster_delete_waiting',
  CLUSTER_DELETE_CLEANUP = 'cluster_delete_cleanup',

  // Cluster power management steps
  CLUSTER_STOP_INIT = 'cluster_stop_init',
  CLUSTER_STOP_SERVERS = 'cluster_stop_servers',
  CLUSTER_STOP_UPDATE_STATUS = 'cluster_stop_update_status',

  CLUSTER_START_INIT = 'cluster_start_init',
  CLUSTER_START_SERVERS = 'cluster_start_servers',
  CLUSTER_START_WAIT_READY = 'cluster_start_wait_ready',
  CLUSTER_START_UPDATE_STATUS = 'cluster_start_update_status',

  CLUSTER_ATTACH_VNET_INIT = 'cluster_attach_vnet_init',
  CLUSTER_ATTACH_VNET_NODES = 'cluster_attach_vnet_nodes',
  CLUSTER_ATTACH_VNET_PERSIST = 'cluster_attach_vnet_persist',

  // Cluster scaling steps (manual add/remove worker)
  CLUSTER_ADD_WORKER_VALIDATE = 'cluster_add_worker_validate',
  CLUSTER_ADD_WORKER_PROVISION = 'cluster_add_worker_provision',
  CLUSTER_ADD_WORKER_JOIN = 'cluster_add_worker_join',
  CLUSTER_ADD_WORKER_FINALIZE = 'cluster_add_worker_finalize',

  CLUSTER_REMOVE_WORKER_CORDON = 'cluster_remove_worker_cordon',
  CLUSTER_REMOVE_WORKER_DRAIN = 'cluster_remove_worker_drain',
  CLUSTER_REMOVE_WORKER_DELETE = 'cluster_remove_worker_delete',
  CLUSTER_REMOVE_WORKER_DELETE_NODE = 'cluster_remove_worker_delete_node',
  CLUSTER_REMOVE_WORKER_FINALIZE = 'cluster_remove_worker_finalize',

  SCALE_NODE_PRECHECK = 'scale_node_precheck',
  SCALE_NODE_POWER_OFF = 'scale_node_power_off',
  SCALE_NODE_CHANGE_TYPE = 'scale_node_change_type',
  SCALE_NODE_POWER_ON = 'scale_node_power_on',
  SCALE_NODE_WAIT_READY = 'scale_node_wait_ready',
  SCALE_NODE_FINALIZE = 'scale_node_finalize',

  EXPAND_VOLUME_PRECHECK = 'expand_volume_precheck',
  EXPAND_VOLUME_PROVIDER = 'expand_volume_provider',
  EXPAND_VOLUME_RESIZE_FS = 'expand_volume_resize_fs',
  EXPAND_VOLUME_FINALIZE = 'expand_volume_finalize',

  // Application build steps (Path B)
  APP_BUILD_INIT = 'app_build_init',
  APP_BUILD_CREATE_JOB = 'app_build_create_job',
  APP_BUILD_CLONING = 'app_build_cloning',
  APP_BUILD_ANALYZING = 'app_build_analyzing',
  APP_BUILD_BUILDING = 'app_build_building',
  APP_BUILD_PUSHING = 'app_build_pushing',
  APP_BUILD_FINALIZE = 'app_build_finalize',

  // Application deploy steps
  APP_DEPLOY_INIT = 'app_deploy_init',
  APP_DEPLOY_BUILD = 'app_deploy_build',
  APP_DEPLOY_PUSH_IMAGE = 'app_deploy_push_image',
  APP_DEPLOY_GENERATE_MANIFESTS = 'app_deploy_generate_manifests',
  APP_DEPLOY_APPLY_MANIFESTS = 'app_deploy_apply_manifests',
  APP_DEPLOY_WAIT_READY = 'app_deploy_wait_ready',
  APP_DEPLOY_FINALIZE = 'app_deploy_finalize',
  APP_DELETE_INIT = 'app_delete_init',
  APP_DELETE_K8S_RESOURCES = 'app_delete_k8s_resources',
  APP_DELETE_FINALIZE = 'app_delete_finalize',

  // Build cache steps
  BUILD_CACHE_CLEAR_INIT = 'build_cache_clear_init',
  BUILD_CACHE_CLEAR_DELETING = 'build_cache_clear_deleting',
  BUILD_CACHE_CLEAR_RECREATING = 'build_cache_clear_recreating',

  // Catalog install steps
  CATALOG_INSTALL_INIT = 'catalog_install_init',
  CATALOG_INSTALL_RESOLVE_DEPS = 'catalog_install_resolve_deps',
  CATALOG_INSTALL_GENERATE_SECRETS = 'catalog_install_generate_secrets',
  CATALOG_INSTALL_RESOLVE_TEMPLATES = 'catalog_install_resolve_templates',
  CATALOG_INSTALL_CREATE_APPLICATIONS = 'catalog_install_create_applications',
  CATALOG_INSTALL_DEPLOY_COMPONENTS = 'catalog_install_deploy_components',
  CATALOG_INSTALL_CREATE_ENDPOINTS = 'catalog_install_create_endpoints',
  CATALOG_INSTALL_FINALIZE = 'catalog_install_finalize',

  // Catalog uninstall steps
  CATALOG_UNINSTALL_INIT = 'catalog_uninstall_init',
  CATALOG_UNINSTALL_DELETE_APPS = 'catalog_uninstall_delete_apps',
  CATALOG_UNINSTALL_FINALIZE = 'catalog_uninstall_finalize',

  // Authz install steps
  AUTHZ_INSTALL_INIT = 'authz_install_init',
  AUTHZ_ENSURE_NAMESPACE = 'authz_ensure_namespace',
  AUTHZ_DEPLOY_SERVICE = 'authz_deploy_service',
  AUTHZ_DEPLOY_WORKLOAD = 'authz_deploy_workload',
  AUTHZ_WAIT_READY = 'authz_wait_ready',
  AUTHZ_INSTALL_FINALIZE = 'authz_install_finalize',

  // Authz uninstall steps
  AUTHZ_UNINSTALL_INIT = 'authz_uninstall_init',
  AUTHZ_UNINSTALL_DELETE_WORKLOAD = 'authz_uninstall_delete_workload',
  AUTHZ_UNINSTALL_FINALIZE = 'authz_uninstall_finalize',

  // Velero install
  VELERO_INSTALL_RENDER_MANIFESTS = 'velero_install_render_manifests',
  VELERO_INSTALL_APPLY_NAMESPACE = 'velero_install_apply_namespace',
  VELERO_INSTALL_APPLY_CRDS = 'velero_install_apply_crds',
  VELERO_INSTALL_APPLY_RBAC = 'velero_install_apply_rbac',
  VELERO_INSTALL_APPLY_CREDENTIALS_SECRET = 'velero_install_apply_credentials_secret',
  VELERO_INSTALL_APPLY_DEPLOYMENT = 'velero_install_apply_deployment',
  VELERO_INSTALL_APPLY_BSL = 'velero_install_apply_bsl',
  VELERO_INSTALL_APPLY_VSL = 'velero_install_apply_vsl',
  VELERO_INSTALL_WAIT_READY = 'velero_install_wait_ready',
  VELERO_INSTALL_FINALIZE = 'velero_install_finalize',

  // Run backup job
  BACKUP_RUN_RESOLVE_SCOPE = 'backup_run_resolve_scope',
  BACKUP_RUN_CREATE_VELERO_CR = 'backup_run_create_velero_cr',
  BACKUP_RUN_WATCH_PROGRESS = 'backup_run_watch_progress',
  BACKUP_RUN_RECORD_ARTIFACT = 'backup_run_record_artifact',
  BACKUP_RUN_ENQUEUE_REPLICATION = 'backup_run_enqueue_replication',
  BACKUP_RUN_FINALIZE = 'backup_run_finalize',

  // Replicate backup
  REPLICATE_PRESIGN_SOURCE = 'replicate_presign_source',
  REPLICATE_LAUNCH_RCLONE = 'replicate_launch_rclone',
  REPLICATE_WAIT_COMPLETION = 'replicate_wait_completion',
  REPLICATE_VERIFY_OBJECTS = 'replicate_verify_objects',
  REPLICATE_MARK_AVAILABLE = 'replicate_mark_available',

  // Restore
  RESTORE_SELECT_SOURCE = 'restore_select_source',
  RESTORE_ENSURE_BSL = 'restore_ensure_bsl',
  RESTORE_CREATE_VELERO_CR = 'restore_create_velero_cr',
  RESTORE_WATCH_PROGRESS = 'restore_watch_progress',
  RESTORE_POSTPROCESS = 'restore_postprocess',

  // Health-check destination
  DEST_HEALTH_CONNECT = 'dest_health_connect',
  DEST_HEALTH_LIST_BUCKET = 'dest_health_list_bucket',
  DEST_HEALTH_WRITE_PROBE = 'dest_health_write_probe',
  DEST_HEALTH_DELETE_PROBE = 'dest_health_delete_probe',
  DEST_HEALTH_UPDATE_USAGE = 'dest_health_update_usage',

  // Etcd L1
  ETCD_RENDER_DROPIN = 'etcd_render_dropin',
  ETCD_SSH_APPLY = 'etcd_ssh_apply',
  ETCD_RELOAD_K3S = 'etcd_reload_k3s',
  ETCD_VERIFY_FIRST_SNAPSHOT = 'etcd_verify_first_snapshot',

  // Provider OS snapshot
  PROVIDER_SNAPSHOT_INIT = 'provider_snapshot_init',
  PROVIDER_SNAPSHOT_CREATE = 'provider_snapshot_create',
  PROVIDER_SNAPSHOT_WAIT = 'provider_snapshot_wait',
  PROVIDER_SNAPSHOT_FINALIZE = 'provider_snapshot_finalize',

  // Pre-deploy snapshot
  PREDEPLOY_SNAPSHOT_INIT = 'predeploy_snapshot_init',
  PREDEPLOY_SNAPSHOT_RUN = 'predeploy_snapshot_run',
  PREDEPLOY_SNAPSHOT_FINALIZE = 'predeploy_snapshot_finalize',

  // VM backups (provider-side)
  VM_BACKUPS_RESOLVE_PROVIDER = 'vm_backups_resolve_provider',
  VM_BACKUPS_TOGGLE_NODE = 'vm_backups_toggle_node',
  VM_BACKUPS_FINALIZE = 'vm_backups_finalize',

  // Quick setup orchestrator
  QUICK_SETUP_RESOLVE_PROVISIONERS = 'quick_setup_resolve_provisioners',
  QUICK_SETUP_PROVISION_PRIMARY = 'quick_setup_provision_primary',
  QUICK_SETUP_PROVISION_REPLICA = 'quick_setup_provision_replica',
  QUICK_SETUP_CREATE_POLICY = 'quick_setup_create_policy',
  QUICK_SETUP_INSTALL_VELERO = 'quick_setup_install_velero',
  QUICK_SETUP_RUN_FIRST_BACKUP = 'quick_setup_run_first_backup',
  QUICK_SETUP_FINALIZE = 'quick_setup_finalize',

  // Database migration machine
  DB_MIGRATE_PROVISION_TARGET = 'db_migrate_provision_target',
  DB_MIGRATE_REPLICATE = 'db_migrate_replicate',
  DB_MIGRATE_SYNCED = 'db_migrate_synced',
  DB_MIGRATE_CUTOVER = 'db_migrate_cutover',
  DB_MIGRATE_RESTORE = 'db_migrate_restore',

  // Application migration machine
  APP_MIGRATE_PROVISION_TARGET = 'app_migrate_provision_target',
  APP_MIGRATE_READY = 'app_migrate_ready',
  APP_MIGRATE_CUTOVER = 'app_migrate_cutover',

  // Full-app migration orchestrator
  FULL_MIGRATE_DB_REPLICATE = 'full_migrate_db_replicate',
  FULL_MIGRATE_APP_STAGE = 'full_migrate_app_stage',
  FULL_MIGRATE_READY = 'full_migrate_ready',
  FULL_MIGRATE_DB_CUTOVER = 'full_migrate_db_cutover',
  FULL_MIGRATE_REWIRE = 'full_migrate_rewire',
  FULL_MIGRATE_APP_START = 'full_migrate_app_start',
  FULL_MIGRATE_DNS_CUTOVER = 'full_migrate_dns_cutover',
}

// Base metadata interface - allows additional runtime properties
interface BaseOperationMetadata {
  operationSteps?: OperationStepConfig[];
  estimatedDurationInSeconds?: number;
  // Runtime properties
  error?: string;
  stack?: string;
  message?: string;
  timestamp?: Date;
  stepDescription?: string;
  stepWeight?: number;
  lastUpdated?: string;
  failedAt?: string;
  [key: string]: any; // Allow additional properties for flexibility
}

// Server operation metadata
export interface CreateServerOperationMetadata extends BaseOperationMetadata {
  serverConfig: CreateServerDto;
  serverName?: string;
  clusterId?: string;
  clusterName?: string;
  nodeType?: 'master' | 'worker';
  workerIndex?: number;
}

export interface DeleteServerOperationMetadata extends BaseOperationMetadata {
  serverConfig: DeleteServerDto;
}

// Cluster operation metadata
export interface CreateClusterOperationMetadata extends BaseOperationMetadata {
  clusterConfig: CreateClusterDto;
  targetNodeCount?: number;
  workerCount?: number;
  providerFirewallIds?: string[]; // Array of provider firewall IDs created for the cluster
}

export interface DeleteClusterOperationMetadata extends BaseOperationMetadata {
  clusterId: string;
  clusterName: string;
  nodeCount: number;
  force: boolean;
}

export interface ClearBuildCacheOperationMetadata
  extends BaseOperationMetadata {
  clusterId: string;
  pvcName: string;
  storageClass: string;
  storage: string;
}

// Union type for all metadata types
export type OperationMetadata =
  | CreateServerOperationMetadata
  | DeleteServerOperationMetadata
  | CreateClusterOperationMetadata
  | DeleteClusterOperationMetadata
  | ClearBuildCacheOperationMetadata
  | BaseOperationMetadata;

@Entity('infrastructure_operations')
export class InfrastructureOperationEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    type: 'enum',
    enum: OperationType,
    nullable: true,
  })
  operationType: OperationType;

  @Column({
    type: 'enum',
    enum: OperationStatus,
    default: OperationStatus.PENDING,
  })
  status: OperationStatus;

  @Column({ nullable: true })
  resourceType: string;

  @Column({ nullable: true })
  resourceName: string;

  @Column({ nullable: true })
  resourceId?: string;

  @Column({
    type: 'enum',
    enum: CloudProvider,
    nullable: true,
  })
  provider: CloudProvider;

  @Column({ nullable: true })
  userId?: string;

  /**
   * Whether a person, a plain key or an agent started this operation.
   *
   * `userId` cannot answer it. A Flui API key is issued *as* its principal and
   * carries that principal's `isAdmin`, so "the administrator deleted the
   * cluster" and "an agent holding a key the administrator minted deleted the
   * cluster" are today the same row — which is precisely the distinction a
   * revoke decision has to be made on.
   */
  @Column({ type: 'varchar', nullable: true })
  actorKind?: string | null;

  /** `api_keys.id` when a key started it. No foreign key: the record outlives the credential. */
  @Column({ type: 'varchar', nullable: true })
  actorKeyId?: string | null;

  /**
   * Under which standing concession — or which one-off approval — an agent was
   * allowed to start this.
   *
   * It is the join the revoke dialog is built on. Taking a permission back stops
   * future departures the instant the row is written, and says nothing at all
   * about what already left; without this column, "what is still running under
   * what I am revoking" is a question the product cannot answer, and the person
   * is asked to decide blind.
   *
   * No foreign key, like `actorKeyId` and for the same reason: the record of
   * what happened has to outlive the permission that allowed it.
   */
  @Column({ type: 'varchar', nullable: true })
  grantId?: string | null;

  /**
   * When somebody asked this operation to stop.
   *
   * A *request*, not a state, and the distinction is the design. `CANCELLED`
   * existed in the enum above with nothing in the module ever writing it, so
   * "stop" was a verb with no machine. What was missing is not a status: it is
   * the honest place to honour one. A ten-step provisioning killed mid-step
   * leaves paid-for debris behind — `env orphan-volumes` exists *because* that
   * failure mode exists — so the stop is cooperative and lands at the next step
   * boundary, where the work is between two consistent points.
   */
  @Column({ type: 'timestamptz', nullable: true })
  cancelRequestedAt?: Date | null;

  /**
   * Filled from the request's actor at insert, and only when the caller did not
   * set it itself.
   *
   * It is a hook on the entity rather than an argument at the call sites because
   * of a count: 122 places in 24 files build one of these rows, and an argument
   * threaded through all of them is 122 chances to forget one — each forgotten
   * one writing a row that claims a person did what an agent did. Here there is
   * one place, it cannot be bypassed by a new call site, and outside a request
   * (a queue worker) there is no actor and the columns stay null, which is the
   * honest answer rather than an inherited one.
   */
  @BeforeInsert()
  stampActor(): void {
    const actor = currentActor();
    if (!actor) return;
    this.actorKind ??= actor.kind;
    this.actorKeyId ??= actor.keyId ?? null;
    this.grantId ??= currentGrantId() ?? null;
  }

  @Column({ type: 'json', default: '{}' })
  metadata: OperationMetadata;

  @Column({ nullable: true })
  errorMessage?: string;

  @Column({ type: 'int', default: 0 })
  progress: number;

  @Column({
    type: 'enum',
    enum: OperationStep,
    nullable: true,
  })
  currentStep?: OperationStep;

  @Column({ type: 'int', default: 0 })
  currentStepIndex: number;

  @Column({ type: 'int', default: 0 })
  totalSteps: number;

  @Column({ type: 'int', default: 0 })
  currentStepProgress: number;

  @Column({ type: 'int', nullable: true })
  estimatedDurationInSeconds?: number;

  @Column({ type: 'timestamptz', nullable: true })
  startedAt?: Date;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt?: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
