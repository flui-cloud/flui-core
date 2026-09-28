import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { HeldFile } from '../services/manifest-master.service';
import { MasterKind } from '../services/bootstrap-files.service';
import { FileProof, InstallRecord } from '../utils/install-values.util';
import { InstallTransforms } from '../utils/manifest-render.util';

export interface MasterAccess {
  cluster: ClusterEntity;
  kubeconfig: string;
  node: string;
  kind: MasterKind;
}

/** The values a refresh may render with, and what it may not render and why. */
export interface ValuesContext {
  /** Absent when there is no proven record; `unavailable` says why. */
  values?: Record<string, string>;
  unavailable?: string;
  unproven: Record<string, string>;
  transforms: InstallTransforms;
  digest: string;
  /** Variables the installer recorded as `true`, proven or not: what it chose to install. */
  flags: ReadonlySet<string>;
}

/**
 * The master's files as far as they can be vouched for. Only digests leave the
 * master; a body is known here only because a template at a release this
 * installation may come from, rendered with values that are not secrets,
 * reproduces the digest byte for byte.
 */
export interface ProvenRead {
  /** `content` is set only for a file proven that way. */
  files: Map<string, HeldFile>;
  /**
   * Files whose unproven digest says nothing about hand edits: a candidate
   * template renders a secret into them, or, with no record to go by, an
   * earlier release did.
   */
  mayHoldSecret: Set<string>;
  /** The candidate templates of each file, across the refs tried. */
  templates: Map<string, string[]>;
}

export interface InstallValuesPlan {
  clusterId: string;
  clusterType: MasterKind;
  planId: string;
  recorded: InstallRecord['source'] | null;
  bootstrapRef: string | null;
  files: Array<Omit<FileProof, 'values'>>;
  values: Record<string, string>;
  unproven: Record<string, string>;
  ingressTlsFiles: string[];
  willWrite: boolean;
  reason?: string;
}

export interface InstallValuesResult extends InstallValuesPlan {
  written: boolean;
}
