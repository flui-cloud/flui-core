import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KOPIA_API_USER,
  KOPIA_CACHE_ARGS,
  KOPIA_NO_CREDENTIAL_STORE_ARGS,
  KopiaS3Location,
  kopiaIdentityArgs,
  kopiaStorageArgs,
} from '../utils/kopia-repository.util';
import { KopiaListedSnapshot } from '../utils/kopia-retention.util';
import {
  KopiaDirectoryEntry,
  splitBackupPath,
} from '../utils/kopia-restore.util';

export interface KopiaRepositoryAccess {
  appId: string;
  location: KopiaS3Location;
  password: string;
  accessKeyId: string;
  secretAccessKey: string;
}

type Run = (args: string[]) => Promise<string>;

export interface DirectoryListing {
  entries: KopiaDirectoryEntry[];
  found: boolean;
  /** The path names a file: `entries` is that one entry. */
  isFile: boolean;
}

const COMMAND_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/**
 * kopia run by the API itself, against one application's repository.
 *
 * Each call gets a private configuration and cache directory that is removed
 * afterwards, and the password and storage keys travel only in the child's
 * environment — never on its command line, where any process listing reads
 * them. Reads connect read-only. Nothing here runs maintenance: the API
 * connects as its own user, which kopia refuses as a maintenance owner.
 */
@Injectable()
export class KopiaCliService {
  private readonly logger = new Logger(KopiaCliService.name);

  private get binary(): string {
    return process.env.FLUI_KOPIA_BIN || 'kopia';
  }

  /**
   * One path of one or more snapshot trees, over a single connection.
   *
   * Walked one directory at a time from each root: `kopia show` on a file
   * prints the file, and a listing must never turn into a download.
   */
  async listDirectories(
    access: KopiaRepositoryAccess,
    rootObjects: string[],
    path: string,
  ): Promise<DirectoryListing[]> {
    const segments = splitBackupPath(path);
    return this.withRepository(access, true, async (run) => {
      const out: DirectoryListing[] = [];
      for (const root of rootObjects) {
        out.push(await this.walk(run, root, segments));
      }
      return out;
    });
  }

  private async walk(
    run: Run,
    rootObject: string,
    segments: string[],
  ): Promise<DirectoryListing> {
    let dir = await this.readDirectory(run, rootObject);
    for (const segment of segments) {
      const entry = dir.find((e) => e.name === segment);
      if (!entry) return { entries: [], found: false, isFile: false };
      if (entry.type !== 'd' || !entry.obj) {
        return { entries: [entry], found: true, isFile: true };
      }
      dir = await this.readDirectory(run, entry.obj);
    }
    return { entries: dir, found: true, isFile: false };
  }

  async listSnapshots(
    access: KopiaRepositoryAccess,
  ): Promise<KopiaListedSnapshot[]> {
    return this.withRepository(access, true, async (run) =>
      JSON.parse((await run(['snapshot', 'list', '--all', '--json'])) || '[]'),
    );
  }

  /** Removes snapshots; the space comes back at the next maintenance of a Job. */
  async deleteSnapshots(
    access: KopiaRepositoryAccess,
    snapshotIds: string[],
  ): Promise<void> {
    const ids = snapshotIds.filter((id) => /^[0-9a-f]{16,64}$/.test(id));
    if (ids.length === 0) return;
    await this.withRepository(access, false, async (run) => {
      for (const id of ids) {
        await run(['snapshot', 'delete', id, '--delete']);
      }
    });
  }

  private async readDirectory(
    run: Run,
    objectId: string,
  ): Promise<KopiaDirectoryEntry[]> {
    if (!/^[A-Za-z0-9]+$/.test(objectId)) {
      throw new Error(`"${objectId}" is not a kopia object id`);
    }
    const parsed = JSON.parse(await run(['show', objectId])) as {
      stream?: string;
      entries?: KopiaDirectoryEntry[];
    };
    if (parsed.stream !== 'kopia:directory') {
      throw new Error(`${objectId} is not a directory`);
    }
    return parsed.entries ?? [];
  }

  private async withRepository<T>(
    access: KopiaRepositoryAccess,
    readonly: boolean,
    fn: (run: Run) => Promise<T>,
  ): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'flui-kopia-'));
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: dir,
      KOPIA_CONFIG_PATH: join(dir, 'repository.config'),
      KOPIA_CACHE_DIRECTORY: join(dir, 'cache'),
      KOPIA_LOG_DIR: join(dir, 'logs'),
      KOPIA_CHECK_FOR_UPDATES: 'false',
      KOPIA_PASSWORD: access.password,
      AWS_ACCESS_KEY_ID: access.accessKeyId,
      AWS_SECRET_ACCESS_KEY: access.secretAccessKey,
    };
    const run: Run = (args) => this.exec(args, env);
    try {
      await run([
        'repository',
        'connect',
        ...kopiaStorageArgs(access.location),
        ...kopiaIdentityArgs(KOPIA_API_USER, access.appId),
        ...KOPIA_CACHE_ARGS,
        ...KOPIA_NO_CREDENTIAL_STORE_ARGS,
        ...(readonly ? ['--readonly'] : []),
      ]);
      return await fn(run);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch((err: any) =>
        this.logger.warn(`[kopia] temp dir not removed: ${err?.message}`),
      );
    }
  }

  private exec(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        this.binary,
        ['--no-progress', ...args],
        { env, timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES },
        (err, stdout, stderr) => {
          if (!err) return resolve(stdout);
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return reject(
              new ServiceUnavailableException(
                'kopia is not installed in this API image, so backups cannot be browsed from here',
              ),
            );
          }
          const reason = String(stderr || err.message)
            .trim()
            .split('\n')
            .slice(-3)
            .join(' ');
          reject(new Error(`kopia ${args[0]} ${args[1] ?? ''}: ${reason}`));
        },
      );
    });
  }
}
