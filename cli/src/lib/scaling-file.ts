import {
  PLACEMENT_STRATEGIES,
  PROVISION_MODES,
  STANDING_ORDER_KINDS,
  type PlacementStrategy,
  type ProvisionMode,
  type StandingOrderKind,
} from 'src/modules/infrastructure/scaling/scaling.core';

import {
  asRecord,
  describeType,
  readEnum,
  readInt,
  readStringList,
  requiredScalarString,
  requiredString,
} from './doc-readers';

// js-yaml ships no bundled types here; the shape we use is tiny and stable.
const yaml = require('js-yaml') as {
  loadAll: (s: string) => unknown[];
  dump: (o: unknown) => string;
};

export const SCALING_GROUP_KIND = 'ScalingGroup';

export interface StandingOrderWrite {
  kind: StandingOrderKind;
  shape: string;
  region: string;
  wanted: number;
  replaces: string | null;
}

export interface NodeRequirementWrite {
  cpu: string;
  memory: string;
}

/**
 * Every field present, always.
 *
 * The file is the whole group, so a key left out is a key reset to its default
 * rather than a key left alone — the same reading a reviewer gives the file.
 * Sending the complete object is what makes that true on an update too, where
 * the API replaces each block whole.
 */
export interface ScalingGroupWrite {
  name: string;
  bounds: { min: number; desired: number; max: number };
  regions: string[];
  shapes: string[];
  strategy: PlacementStrategy;
  settleSeconds: number;
  limits: { hourlyBillingOnly: boolean; maxMonthlyCost: number | null };
  provision: ProvisionMode;
  standingOrders: StandingOrderWrite[];
  requirement: NodeRequirementWrite | null;
}

export interface ScalingGroupDocument {
  /** Null when the document names no cluster and `--cluster` has to. */
  cluster: string | null;
  group: ScalingGroupWrite;
}

const DEFAULT_STRATEGY: PlacementStrategy = 'uniform';
const DEFAULT_SETTLE_SECONDS = 30;
const DEFAULT_PROVISION: ProvisionMode = 'manual';
const MAX_SETTLE_SECONDS = 3600;

/** Everything the document may say. Anything else is a typo, not an extension. */
const TOP_LEVEL_KEYS = [
  'kind',
  'name',
  'cluster',
  'bounds',
  'regions',
  'shapes',
  'strategy',
  'settleSeconds',
  'limits',
  'provision',
  'standingOrders',
  'requirement',
];

const BOUNDS_KEYS = ['min', 'desired', 'max'];
const LIMITS_KEYS = ['hourlyBillingOnly', 'maxMonthlyCost'];
const ORDER_KEYS = ['kind', 'shape', 'region', 'wanted', 'replaces'];
const REQUIREMENT_KEYS = ['cpu', 'memory'];

/**
 * Every problem at once, because a file is fixed in an editor rather than by
 * running the command again until it stops complaining.
 */
export class ScalingDocumentError extends Error {
  constructor(
    readonly problems: string[],
    source?: string,
  ) {
    super(
      `${source ? `${source}: ` : ''}not a valid ${SCALING_GROUP_KIND} document\n` +
        problems.map((p) => `    • ${p}`).join('\n'),
    );
    this.name = 'ScalingDocumentError';
  }
}

/** Reads one or more `kind: ScalingGroup` documents out of YAML or JSON text. */
export function parseScalingGroupFile(
  raw: string,
  source?: string,
): ScalingGroupDocument[] {
  let docs: unknown[];
  try {
    docs = yaml.loadAll(raw);
  } catch (error: unknown) {
    throw new ScalingDocumentError(
      [`invalid YAML/JSON: ${(error as Error).message}`],
      source,
    );
  }

  const present = docs.filter((d) => d !== null && d !== undefined);
  if (present.length === 0) {
    throw new ScalingDocumentError(['the file is empty'], source);
  }

  return present.map((doc, index) =>
    parseScalingGroupDocument(
      doc,
      present.length > 1 ? `${source ?? 'document'} #${index + 1}` : source,
    ),
  );
}

export function parseScalingGroupDocument(
  input: unknown,
  source?: string,
): ScalingGroupDocument {
  const problems: string[] = [];
  const doc = asRecord(input);
  if (!doc) {
    throw new ScalingDocumentError(
      ['expected a document with fields, got ' + describeType(input)],
      source,
    );
  }

  if (doc.kind !== SCALING_GROUP_KIND) {
    problems.push(
      doc.kind === undefined
        ? `missing \`kind: ${SCALING_GROUP_KIND}\``
        : `\`kind\` is ${JSON.stringify(doc.kind)}, expected ${SCALING_GROUP_KIND}`,
    );
  }
  for (const key of Object.keys(doc)) {
    if (!TOP_LEVEL_KEYS.includes(key)) {
      problems.push(`unknown field \`${key}\``);
    }
  }

  const name = requiredString(doc.name, 'name', problems);
  const cluster =
    doc.cluster === undefined || doc.cluster === null
      ? null
      : requiredString(doc.cluster, 'cluster', problems);

  const bounds = readBounds(doc.bounds, problems);
  const regions = readStringList(doc.regions, 'regions', problems);
  const shapes = readStringList(doc.shapes, 'shapes', problems);
  const strategy = readEnum(
    doc.strategy,
    'strategy',
    PLACEMENT_STRATEGIES,
    DEFAULT_STRATEGY,
    problems,
  );
  const settleSeconds = readSettleSeconds(doc.settleSeconds, problems);
  const limits = readLimits(doc.limits, problems);
  const provision = readEnum(
    doc.provision,
    'provision',
    PROVISION_MODES,
    DEFAULT_PROVISION,
    problems,
  );
  const standingOrders = readStandingOrders(
    doc.standingOrders,
    regions,
    shapes,
    problems,
  );
  const requirement = readRequirement(doc.requirement, problems);

  if (problems.length) throw new ScalingDocumentError(problems, source);

  return {
    cluster,
    group: {
      name,
      bounds,
      regions,
      shapes,
      strategy,
      settleSeconds,
      limits,
      provision,
      standingOrders,
      requirement,
    },
  };
}

/** The document as text, ready to be committed beside the code it scales. */
export function dumpScalingGroupDocument(doc: unknown): string {
  return yaml.dump(doc);
}

function readBounds(
  input: unknown,
  problems: string[],
): ScalingGroupWrite['bounds'] {
  const fallback = { min: 1, desired: 1, max: 1 };
  const record = asRecord(input);
  if (!record) {
    problems.push(
      input === undefined
        ? 'missing `bounds`: a group needs a floor, a target and a ceiling'
        : `\`bounds\` must be a block with min, desired and max, got ${describeType(input)}`,
    );
    return fallback;
  }
  for (const key of Object.keys(record)) {
    if (!BOUNDS_KEYS.includes(key)) {
      problems.push(`unknown field \`bounds.${key}\``);
    }
  }

  const min = readInt(record.min, 'bounds.min', 0, problems);
  const desired = readInt(record.desired, 'bounds.desired', 0, problems);
  // Zero is a ceiling, not a group switched off: a fleet that should hold no
  // nodes. `min <= desired <= max` below still holds, so writing it means
  // saying so three times.
  const max = readInt(record.max, 'bounds.max', 0, problems);
  if (min === null || desired === null || max === null) return fallback;

  if (min > desired) {
    problems.push(
      `bounds.min (${min}) is above bounds.desired (${desired}): the floor is held now and always, ` +
        'so it cannot sit above the target the fleet only approaches',
    );
  }
  if (desired > max) {
    problems.push(
      `bounds.desired (${desired}) is above bounds.max (${max}): the ceiling is as far as urgency may go ` +
        'right now, so the target cannot sit above it',
    );
  }
  return { min, desired, max };
}

function readLimits(
  input: unknown,
  problems: string[],
): ScalingGroupWrite['limits'] {
  const fallback = { hourlyBillingOnly: false, maxMonthlyCost: null };
  if (input === undefined || input === null) return fallback;

  const record = asRecord(input);
  if (!record) {
    problems.push(`\`limits\` must be a block, got ${describeType(input)}`);
    return fallback;
  }
  for (const key of Object.keys(record)) {
    if (!LIMITS_KEYS.includes(key)) {
      problems.push(`unknown field \`limits.${key}\``);
    }
  }

  let hourlyBillingOnly = false;
  if (record.hourlyBillingOnly !== undefined) {
    if (typeof record.hourlyBillingOnly !== 'boolean') {
      problems.push(
        `\`limits.hourlyBillingOnly\` must be true or false, got ${describeType(record.hourlyBillingOnly)}`,
      );
    } else {
      hourlyBillingOnly = record.hourlyBillingOnly;
    }
  }

  let maxMonthlyCost: number | null = null;
  const cap = record.maxMonthlyCost;
  if (cap !== undefined && cap !== null) {
    if (typeof cap !== 'number' || !Number.isFinite(cap) || cap < 0) {
      problems.push(
        '`limits.maxMonthlyCost` must be an amount of money, 0 or more ' +
          '(leave it out for no ceiling at all — which is not the same as 0)',
      );
    } else {
      maxMonthlyCost = cap;
    }
  }

  return { hourlyBillingOnly, maxMonthlyCost };
}

function readStandingOrders(
  input: unknown,
  regions: string[],
  shapes: string[],
  problems: string[],
): StandingOrderWrite[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    problems.push(
      `\`standingOrders\` must be a list, got ${describeType(input)}`,
    );
    return [];
  }

  const orders: StandingOrderWrite[] = [];
  input.forEach((entry, index) => {
    const at = `standingOrders[${index}]`;
    const record = asRecord(entry);
    if (!record) {
      problems.push(`\`${at}\` must be a block, got ${describeType(entry)}`);
      return;
    }
    for (const key of Object.keys(record)) {
      if (!ORDER_KEYS.includes(key)) {
        problems.push(`unknown field \`${at}.${key}\``);
      }
    }

    const kind = readEnum(
      record.kind,
      `${at}.kind`,
      STANDING_ORDER_KINDS,
      'expand',
      problems,
    );
    const shape = requiredString(record.shape, `${at}.shape`, problems);
    const region = requiredString(record.region, `${at}.region`, problems);
    const wanted = readInt(record.wanted, `${at}.wanted`, 1, problems) ?? 1;

    let replaces: string | null = null;
    if (record.replaces !== undefined && record.replaces !== null) {
      replaces = requiredString(record.replaces, `${at}.replaces`, problems);
    }

    if (kind === 'expand' && replaces) {
      problems.push(
        `\`${at}\` expands: it buys and adds without draining anything, so it names no node to replace`,
      );
    }
    if (kind === 'replace' && !replaces) {
      problems.push(
        `\`${at}\` replaces: name in \`replaces\` the node it would drain and remove`,
      );
    }
    if (shape && !shapes.includes(shape)) {
      problems.push(
        `\`${at}\` waits for "${shape}", which is not among \`shapes\` — a wait that could never end`,
      );
    }
    if (region && !regions.includes(region)) {
      problems.push(
        `\`${at}\` waits in "${region}", which is not among \`regions\` — a wait that could never end`,
      );
    }

    orders.push({ kind, shape, region, wanted, replaces });
  });
  return orders;
}

function readRequirement(
  input: unknown,
  problems: string[],
): NodeRequirementWrite | null {
  if (input === undefined || input === null) return null;
  const record = asRecord(input);
  if (!record) {
    problems.push(
      `\`requirement\` must be a block with cpu and memory, got ${describeType(input)}`,
    );
    return null;
  }
  for (const key of Object.keys(record)) {
    if (!REQUIREMENT_KEYS.includes(key)) {
      problems.push(`unknown field \`requirement.${key}\``);
    }
  }
  const cpu = requiredScalarString(record.cpu, 'requirement.cpu', problems);
  const memory = requiredScalarString(
    record.memory,
    'requirement.memory',
    problems,
  );
  return { cpu, memory };
}

function readSettleSeconds(input: unknown, problems: string[]): number {
  if (input === undefined || input === null) return DEFAULT_SETTLE_SECONDS;
  const value = readInt(input, 'settleSeconds', 0, problems);
  if (value === null) return DEFAULT_SETTLE_SECONDS;
  if (value > MAX_SETTLE_SECONDS) {
    problems.push(
      `\`settleSeconds\` is ${value}: past ${MAX_SETTLE_SECONDS} this stops being a check that the work is ` +
        'really stuck and becomes an outage with a timer on it',
    );
    return DEFAULT_SETTLE_SECONDS;
  }
  return value;
}
