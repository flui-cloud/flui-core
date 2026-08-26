import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import {
  ContextProbeRegistry,
  ProbeParam,
  ProbeValueType,
  taken,
} from './context-probe';

/**
 * The fields a probe will answer over, and nothing else.
 *
 * Fail-closed on purpose, and it is the security half of the probe design: an
 * entry names a field, so without an allow-list "the master hosts the API"
 * becomes a way to read `env` — a column that holds an application's secrets —
 * through a mechanism whose answers are delivered straight into a model's
 * context. The lists hold shape and placement, never content.
 */
/**
 * The type each field answers in, next to the permission to read it at all.
 *
 * One table and not two, so a field can never be readable without also saying
 * what a premise about it means: the allow-list and the type are the same
 * decision made once. This is what lets a note written as `replicas equals "2"`
 * be stored as the number `2` and compared strictly ever after — see
 * {@link ../probes/probe-expectation#interpretExpected}.
 */
export const APP_FIELD_TYPES: Record<string, ProbeValueType> = {
  clusterId: 'string',
  status: 'string',
  kind: 'string',
  category: 'string',
  sourceType: 'string',
  workloadKind: 'string',
  replicas: 'number',
  port: 'number',
  portProtocol: 'string',
};

export const CLUSTER_FIELD_TYPES: Record<string, ProbeValueType> = {
  status: 'string',
  provider: 'string',
  region: 'string',
  nodeSize: 'string',
  nodeCount: 'number',
  autoscalingEnabled: 'boolean',
  minNodes: 'number',
  maxNodes: 'number',
};

export const APP_READABLE_FIELDS = Object.keys(APP_FIELD_TYPES);

export const CLUSTER_READABLE_FIELDS = Object.keys(CLUSTER_FIELD_TYPES);

/**
 * What each probe is asked for, declared once and used three ways: the
 * catalogue publishes it, {@link taken} enforces it on the write, and `run`
 * reads its parameters through it.
 *
 * The accepted field names are the keys of the type table above rather than a
 * list beside it — permission to read a field, the type it answers in, and the
 * values an author may pick are one decision made once. A second list here
 * would be a contract that drifts the moment somebody adds a field.
 */
const APP_FIELD_TAKES: readonly ProbeParam[] = [
  { name: 'slug', required: true },
  { name: 'field', required: true, oneOf: APP_READABLE_FIELDS },
];

const CLUSTER_FIELD_TAKES: readonly ProbeParam[] = [
  { name: 'field', required: true, oneOf: CLUSTER_READABLE_FIELDS },
  // Neither is required on its own — the pair is. A cluster is named by id or
  // by name, and a declaration cannot say "one of these two".
  { name: 'clusterId', required: false },
  { name: 'clusterName', required: false },
];

/**
 * `cluster.field` is the one probe that takes either of two parameters.
 *
 * The parameter vocabulary cannot say "one of these two" and deliberately does
 * not try — one case does not earn a vocabulary. What it must not do is let the
 * gap through in silence, so the rule lives in one function that both the write
 * path and the run path go through.
 */
function requireOneCluster(params: Record<string, unknown>): void {
  const id = taken(params, CLUSTER_FIELD_TAKES, 'clusterId');
  const named = taken(params, CLUSTER_FIELD_TAKES, 'clusterName');
  if (!id && !named) throw new Error('clusterId or clusterName is missing');
}

const APP_COUNT_TAKES: readonly ProbeParam[] = [
  { name: 'clusterId', required: true },
];

/**
 * The two probes the platform ships with, over the two things nearly every
 * operating rule is really about: an application's placement and a cluster's
 * shape.
 *
 * They register themselves rather than being listed by the registry, because
 * the point of the registry is that a module offering state does not have to be
 * edited into this feature — these two are simply the first callers of that
 * seam, and the pattern any other module follows.
 */
@Injectable()
export class BuiltinProbes implements OnModuleInit {
  constructor(
    private readonly registry: ContextProbeRegistry,
    @InjectRepository(ApplicationEntity)
    private readonly apps: Repository<ApplicationEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      id: 'app.field',
      describes: 'One readable field of an application — named by slug.',
      takes: APP_FIELD_TAKES,
      answers: (p) => APP_FIELD_TYPES[taken(p, APP_FIELD_TAKES, 'field')],
      run: (p) => this.appField(p),
    });
    this.registry.register({
      id: 'cluster.field',
      describes: 'One readable field of a cluster — named by id or by name.',
      takes: CLUSTER_FIELD_TAKES,
      // The pair is refused here and not only in `run`, because the write path
      // never calls `run`. A note naming neither id nor name was accepted, its
      // premise stored, and then answered `unknown` for ever — advice delivered
      // as unverified prose for a reason that was never true. That is the same
      // silent lie the strict comparison was fixed for; a premise that cannot
      // be asked has no type to answer in either.
      answers: (p) => {
        requireOneCluster(p);
        return CLUSTER_FIELD_TYPES[taken(p, CLUSTER_FIELD_TAKES, 'field')];
      },
      run: (p) => this.clusterField(p),
    });
    this.registry.register({
      id: 'cluster.appCount',
      describes:
        'How many applications currently sit on a cluster — by cluster id.',
      takes: APP_COUNT_TAKES,
      answers: () => 'number',
      run: (p) => this.appCount(p),
    });
  }

  private async appField(params: Record<string, unknown>): Promise<unknown> {
    const name = taken(params, APP_FIELD_TAKES, 'field');
    const app = await this.apps.findOne({
      where: { slug: taken(params, APP_FIELD_TAKES, 'slug') },
      select: ['id', ...APP_READABLE_FIELDS] as never,
    });
    // A missing application is an answer, not a failure: "this rule is about an
    // app that no longer exists" is precisely the premise that should break.
    return app ? (app as unknown as Record<string, unknown>)[name] : null;
  }

  private async clusterField(
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const name = taken(params, CLUSTER_FIELD_TAKES, 'field');
    requireOneCluster(params);
    const id = taken(params, CLUSTER_FIELD_TAKES, 'clusterId');
    const named = taken(params, CLUSTER_FIELD_TAKES, 'clusterName');
    const where = id ? { id } : { name: named };
    const cluster = await this.clusters.findOne({
      where,
      select: ['id', ...CLUSTER_READABLE_FIELDS] as never,
    });
    return cluster
      ? (cluster as unknown as Record<string, unknown>)[name]
      : null;
  }

  // `async` so that every probe *rejects* rather than throwing: a parameter
  // refused synchronously would escape a caller that only caught the promise.
  private async appCount(params: Record<string, unknown>): Promise<number> {
    return this.apps.count({
      where: { clusterId: taken(params, APP_COUNT_TAKES, 'clusterId') },
    });
  }
}
