import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The profile files the local repositories keep; any of them may carry `*Encrypted` values. */
export const PROFILE_DATA_FILES = [
  'clusters.json',
  'nodes.json',
  'operations.json',
  'firewalls.json',
  'vnets.json',
] as const;

export interface SealedField {
  file: string;
  path: string;
  value: string;
  set(value: string): void;
}

/**
 * Every value sealed with the platform encryption key in a profile's data
 * files: a string property whose name ends in `Encrypted`, at any depth.
 *
 * Found by name rather than by a list, because the list is the cluster entity
 * and its metadata, which keep growing; a field missed here would stay sealed
 * under a key the migration is about to remove.
 */
export class ProfileSealedData {
  private readonly docs = new Map<string, unknown>();
  private readonly dirty = new Set<string>();

  constructor(private readonly profileDir: string) {
    for (const file of PROFILE_DATA_FILES) {
      const full = join(profileDir, file);
      if (!existsSync(full)) continue;
      const raw = readFileSync(full, 'utf-8');
      if (!raw.trim()) continue;
      try {
        this.docs.set(file, JSON.parse(raw));
      } catch {
        throw new Error(`${full} is not valid JSON.`);
      }
    }
  }

  fields(): SealedField[] {
    const out: SealedField[] = [];
    for (const [file, doc] of this.docs) {
      this.walk(doc, file, file, out);
    }
    return out;
  }

  /** The cluster records, for writing a field that is not there yet. */
  clusters(): Array<Record<string, any>> {
    const doc = this.docs.get('clusters.json');
    return Array.isArray(doc) ? (doc as Array<Record<string, any>>) : [];
  }

  markChanged(file: string): void {
    this.dirty.add(file);
  }

  /** Written through a temporary file and a rename, so an interrupted run leaves the old file whole. */
  save(): void {
    for (const file of this.dirty) {
      const full = join(this.profileDir, file);
      const tmp = `${full}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(this.docs.get(file), null, 2), {
        mode: 0o600,
      });
      renameSync(tmp, full);
    }
    this.dirty.clear();
  }

  private walk(
    node: unknown,
    file: string,
    at: string,
    out: SealedField[],
  ): void {
    if (Array.isArray(node)) {
      node.forEach((item, i) => this.walk(item, file, `${at}[${i}]`, out));
      return;
    }
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if (
        key.endsWith('Encrypted') &&
        typeof value === 'string' &&
        value !== ''
      ) {
        out.push({
          file,
          path: `${at}.${key}`,
          value,
          set: (next: string) => {
            record[key] = next;
            this.dirty.add(file);
          },
        });
      } else {
        this.walk(value, file, `${at}.${key}`, out);
      }
    }
  }
}
