import { documentsOf } from './manifest-documents.util';
import { Action } from './manifest-eligibility.util';

/**
 * A file judged on its own can be safe to write and still break the cluster,
 * because it names something another file creates. A workload that asks for a
 * PriorityClass the cluster lacks cannot start a pod at all, and a StatefulSet
 * rolled onto that template takes its database down with it.
 */

const BUILT_IN_PRIORITY_CLASSES = new Set([
  'system-cluster-critical',
  'system-node-critical',
]);

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};

function parsed(content: string | undefined): unknown[] {
  if (content === undefined) return [];
  try {
    return documentsOf(content);
  } catch {
    return [];
  }
}

function podSpecOf(doc: Record<string, unknown>): Record<string, unknown> {
  const spec = asRecord(doc.spec);
  if (doc.kind === 'Pod') return spec;
  if (doc.kind === 'CronJob') {
    return asRecord(
      asRecord(asRecord(asRecord(spec.jobTemplate).spec).template).spec,
    );
  }
  return asRecord(asRecord(spec.template).spec);
}

export function priorityClassesUsedBy(content: string | undefined): string[] {
  const used = new Set<string>();
  for (const doc of parsed(content)) {
    const name = podSpecOf(asRecord(doc)).priorityClassName;
    if (typeof name === 'string' && !BUILT_IN_PRIORITY_CLASSES.has(name)) {
      used.add(name);
    }
  }
  return [...used];
}

export function priorityClassesDefinedBy(
  content: string | undefined,
): string[] {
  return parsed(content)
    .map(asRecord)
    .filter((doc) => doc.kind === 'PriorityClass')
    .map((doc) => asRecord(doc.metadata).name)
    .filter((name): name is string => typeof name === 'string');
}

export interface DependencyEntry {
  name: string;
  action: Action;
  reason?: string;
  /** Present when the master holds a copy of this file. */
  currentSha?: string;
}

export interface DependencyFile {
  /** What would be written, or the release's template when nothing is. */
  content: string | undefined;
}

/**
 * Downgrades to `skip` every file that would be written while a PriorityClass
 * it uses reaches the cluster from nowhere: not from a file this refresh
 * writes, not from one the master already holds. Repeats until stable, since a
 * file held back may itself be what defined a class.
 */
export function holdBackUnmetDependencies<T extends DependencyEntry>(
  entries: T[],
  files: ReadonlyMap<string, DependencyFile>,
): T[] {
  const definers = new Map<string, string>();
  for (const [name, file] of files) {
    for (const cls of priorityClassesDefinedBy(file.content)) {
      if (!definers.has(cls)) definers.set(cls, name);
    }
  }

  let result = entries;
  for (;;) {
    const byName = new Map(result.map((e) => [e.name, e]));
    const present = (file: string): boolean => {
      const entry = byName.get(file);
      if (!entry) return false;
      if (entry.action === 'skip') return entry.currentSha !== undefined;
      return true;
    };
    let changed = false;
    result = result.map((entry) => {
      if (entry.action !== 'replace' && entry.action !== 'add') return entry;
      const unmet = priorityClassesUsedBy(files.get(entry.name)?.content).find(
        (cls) => {
          const definer = definers.get(cls);
          return !definer || !present(definer);
        },
      );
      if (!unmet) return entry;
      changed = true;
      const definer = definers.get(unmet);
      const source = definer
        ? `${definer} defines it and is not written by this refresh`
        : 'no file of this release defines it';
      return {
        ...entry,
        action: 'skip' as const,
        reason: `runs its pods at PriorityClass ${unmet}, which this cluster may not have: ${source}. Writing it could leave its pods unable to start.`,
      };
    });
    if (!changed) return result;
  }
}
