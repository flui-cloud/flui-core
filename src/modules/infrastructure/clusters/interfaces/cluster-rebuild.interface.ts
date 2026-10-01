import type { ClusterEntity } from '../entities/cluster.entity';

/**
 * `workload`: a lost cluster's applications onto another live one.
 * `control`: the applications that ran on the control cluster of the
 * installation this one was restored from, onto this installation's own
 * control cluster — the only way back for a single-cluster install.
 */
export type RebuildMode = 'workload' | 'control';

/** Where an application got to. Read on a re-run to continue, not restart. */
export type RebuildPhase =
  | 'repointed'
  | 'restored'
  | 'deployed'
  | 'loaded'
  | 'reconciled'
  | 'failed';

/** One endpoint's old and new name, decided before anything was mutated. */
export interface EndpointMove {
  from: string;
  to: string;
}

/** Keyed by endpoint id, so a resumed run reads the answer instead of re-deriving it. */
export type EndpointMoves = Record<string, EndpointMove>;

export interface RebuildResultApp {
  applicationId: string;
  name: string;
  phase: RebuildPhase | 'skipped';
  error?: string;
  /** Every name that changed, not the first: an application may publish several. */
  endpointMoved?: EndpointMove[];
  /** What came back thinner than the application had — per volume, in words. */
  notes?: string[];
}

export interface RebuildResult {
  from: string;
  to: string;
  apps: RebuildResultApp[];
  /** Schedules that named the lost cluster and now name the destination. */
  movedPolicies: string[];
  /** True when every application it tried reached `reconciled`. */
  complete: boolean;
}

/** One application's place in a rebuild, and everything true about it. */
export interface RebuildPlanApp {
  applicationId: string;
  name: string;
  slug: string;
  status: string;
  /** Set when this application cannot be rebuilt at all. */
  blocked?: string;
  /** True but not disqualifying — the user decides. */
  warnings: string[];
  /** What will come back, and from where. Empty is a fact, not an omission. */
  restores: string[];
  /** Where it got to on a previous run, when there was one. */
  phase?: string;
  /** Rebuilt after these, because it uses them. */
  after?: string[];
}

export interface RebuildPlan {
  mode: RebuildMode;
  from: { id: string; name: string; status: string };
  to: { id: string; name: string; status: string };
  apps: RebuildPlanApp[];
  /** Reasons the whole rebuild cannot start. Empty means it can. */
  refusals: string[];
  /** True of the whole rebuild, and not disqualifying. The person decides. */
  warnings: string[];
  capacity?: {
    requiredCpuMillis: number;
    requiredMemoryMi: number;
    availableCpuMillis: number;
    availableMemoryMi: number;
    fits: boolean;
  };
}

/** A control cluster this installation was restored from, and what it held. */
export interface PreviousControl {
  id: string;
  name: string;
  status: string;
  retired: boolean;
  applications: number;
}

export interface ControlRestorePlan extends RebuildPlan {
  /** Every earlier control cluster with applications still recorded on it. */
  candidates: PreviousControl[];
}

export type ControlPair =
  | { from: ClusterEntity; to: ClusterEntity; candidates: PreviousControl[] }
  | {
      refusal: string;
      from?: ClusterEntity;
      to?: ClusterEntity;
      candidates: PreviousControl[];
    };
