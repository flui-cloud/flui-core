import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';

const FILES_TO_MIGRATE = [
  'clusters.json',
  'nodes.json',
  'operations.json',
  'firewalls.json',
  'vnets.json',
  'config.json',
  '.key',
];

const DIRS_TO_MIGRATE = ['ca', 'logs'];

/**
 * Manages CLI profiles (contexts) for multi-environment support.
 * Profiles are stored under ~/.flui/profiles/<name>/.
 * The active profile is stored in ~/.flui/context.
 *
 * Override active profile at runtime with FLUI_PROFILE env var.
 */
export class ProfileManager {
  static readonly BASE_DIR = path.join(homedir(), '.flui');
  static readonly PROFILES_DIR = path.join(ProfileManager.BASE_DIR, 'profiles');
  static readonly BACKUPS_DIR = path.join(ProfileManager.BASE_DIR, 'backups');
  static readonly CONTEXT_FILE = path.join(ProfileManager.BASE_DIR, 'context');
  static readonly DEFAULT_PROFILE = 'default';

  private static readonly SNAPSHOT_SKIP = new Set([
    'operations.json',
    'logs',
    'debug',
    'cache',
  ]);

  /**
   * Returns the currently active profile name.
   * Priority: FLUI_PROFILE env var > ~/.flui/context file > 'default'
   */
  static getActiveProfile(): string {
    if (process.env.FLUI_PROFILE) {
      return process.env.FLUI_PROFILE;
    }

    if (fs.existsSync(ProfileManager.CONTEXT_FILE)) {
      const content = fs
        .readFileSync(ProfileManager.CONTEXT_FILE, 'utf-8')
        .trim();
      if (content) {
        return content;
      }
    }

    return ProfileManager.DEFAULT_PROFILE;
  }

  /**
   * Sets the active profile in ~/.flui/context.
   * Does not validate that the profile exists — callers should check first.
   */
  static setActiveProfile(name: string): void {
    ProfileManager.ensureBaseDir();
    fs.writeFileSync(ProfileManager.CONTEXT_FILE, name, {
      encoding: 'utf-8',
      mode: 0o600,
    });
  }

  /**
   * Returns the directory path for a given profile.
   * If no profile is specified, uses the active profile.
   */
  static getProfileDir(profile?: string): string {
    const active = profile ?? ProfileManager.getActiveProfile();
    return path.join(ProfileManager.PROFILES_DIR, active);
  }

  /**
   * Returns all existing profile names (directory names under ~/.flui/profiles/).
   */
  static listProfiles(): string[] {
    if (!fs.existsSync(ProfileManager.PROFILES_DIR)) {
      return [];
    }

    return fs
      .readdirSync(ProfileManager.PROFILES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  }

  /**
   * Returns true if a profile directory exists.
   */
  static profileExists(name: string): boolean {
    return fs.existsSync(path.join(ProfileManager.PROFILES_DIR, name));
  }

  /**
   * Creates a new profile directory with secure permissions.
   * Throws if the profile already exists.
   */
  static createProfile(name: string): void {
    ProfileManager.validateProfileName(name);

    const profileDir = path.join(ProfileManager.PROFILES_DIR, name);
    if (fs.existsSync(profileDir)) {
      throw new Error(`Profile '${name}' already exists`);
    }

    fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  }

  /**
   * Deletes a profile directory.
   * Throws if trying to delete the default profile or a non-existent profile.
   */
  static deleteProfile(name: string): void {
    if (name === ProfileManager.DEFAULT_PROFILE) {
      throw new Error(
        `Cannot delete the '${ProfileManager.DEFAULT_PROFILE}' profile`,
      );
    }

    const profileDir = path.join(ProfileManager.PROFILES_DIR, name);
    if (!fs.existsSync(profileDir)) {
      throw new Error(`Profile '${name}' does not exist`);
    }

    fs.rmSync(profileDir, { recursive: true, force: true });
  }

  /**
   * Migrates legacy ~/.flui/ flat layout to ~/.flui/profiles/default/.
   *
   * Runs automatically on first launch after upgrade. Idempotent:
   * if ~/.flui/profiles/ already exists, does nothing.
   */
  static migrateIfNeeded(): void {
    // If profiles dir already exists, migration already done
    if (fs.existsSync(ProfileManager.PROFILES_DIR)) {
      return;
    }

    // Check if there is anything to migrate
    const hasData = FILES_TO_MIGRATE.some((f) =>
      fs.existsSync(path.join(ProfileManager.BASE_DIR, f)),
    );

    // Create profiles dir regardless (needed for future profiles)
    fs.mkdirSync(ProfileManager.PROFILES_DIR, { recursive: true, mode: 0o700 });

    const defaultDir = path.join(
      ProfileManager.PROFILES_DIR,
      ProfileManager.DEFAULT_PROFILE,
    );
    fs.mkdirSync(defaultDir, { recursive: true, mode: 0o700 });

    if (!hasData) {
      return;
    }

    // Copy files
    for (const file of FILES_TO_MIGRATE) {
      const src = path.join(ProfileManager.BASE_DIR, file);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(defaultDir, file));
        fs.unlinkSync(src);
      }
    }

    // Copy directories
    for (const dir of DIRS_TO_MIGRATE) {
      const src = path.join(ProfileManager.BASE_DIR, dir);
      if (fs.existsSync(src)) {
        ProfileManager.copyDirSync(src, path.join(defaultDir, dir));
        fs.rmSync(src, { recursive: true, force: true });
      }
    }
  }

  static snapshotActiveProfile(opts?: {
    keep?: number;
    timestamp?: string;
  }): { path: string; profile: string; fileCount: number } | null {
    const profile = ProfileManager.getActiveProfile();
    const srcDir = ProfileManager.getProfileDir(profile);
    if (!fs.existsSync(srcDir)) {
      return null;
    }

    const stamp = (opts?.timestamp ?? new Date().toISOString()).replace(
      /[:.]/g,
      '-',
    );
    const destDir = path.join(
      ProfileManager.BACKUPS_DIR,
      `${profile}-${stamp}`,
    );

    fs.mkdirSync(ProfileManager.BACKUPS_DIR, { recursive: true, mode: 0o700 });
    const fileCount = ProfileManager.snapshotCopyDir(srcDir, destDir);
    ProfileManager.pruneSnapshots(profile, opts?.keep ?? 10);

    return { path: destDir, profile, fileCount };
  }

  private static snapshotCopyDir(src: string, dest: string): number {
    fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
    let count = 0;
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (ProfileManager.SNAPSHOT_SKIP.has(entry.name)) continue;
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        count += ProfileManager.snapshotCopyDir(srcPath, destPath);
      } else if (entry.isFile()) {
        fs.copyFileSync(srcPath, destPath);
        fs.chmodSync(destPath, 0o600);
        count++;
      }
    }
    return count;
  }

  private static pruneSnapshots(profile: string, keep: number): void {
    if (keep <= 0 || !fs.existsSync(ProfileManager.BACKUPS_DIR)) {
      return;
    }
    const prefix = `${profile}-`;
    const snapshots = fs
      .readdirSync(ProfileManager.BACKUPS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
    for (const name of snapshots.slice(
      0,
      Math.max(0, snapshots.length - keep),
    )) {
      fs.rmSync(path.join(ProfileManager.BACKUPS_DIR, name), {
        recursive: true,
        force: true,
      });
    }
  }

  private static ensureBaseDir(): void {
    if (!fs.existsSync(ProfileManager.BASE_DIR)) {
      fs.mkdirSync(ProfileManager.BASE_DIR, { recursive: true, mode: 0o700 });
    }
  }

  private static validateProfileName(name: string): void {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new Error(
        `Invalid profile name '${name}'. Only alphanumeric characters, hyphens, and underscores are allowed.`,
      );
    }
  }

  private static copyDirSync(src: string, dest: string): void {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
    }

    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        ProfileManager.copyDirSync(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }
}
