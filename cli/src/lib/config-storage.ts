import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { ProfileManager } from './profile-manager';
import { buildNipBaseDomain } from './nip-base-domain.util';
import {
  open as openSealed,
  seal as sealValue,
  type ProfileKey,
} from './vault/vault-crypto';
import { VaultLockedError, getProfileKey } from './vault/session-key';
import { VaultFile } from './vault/vault-file';

/**
 * The sealing primitives, applied to whichever key is in play — the vault's, or
 * the retired key file's while a profile is being moved across. Both write the
 * same `iv:authTag:ciphertext` shape, so the stored format never changes and a
 * half-migrated profile is still a readable one.
 */
/**
 * Raised instead of a decryption failure when the only key available is a key
 * file that opens nothing. It carries its own instruction, so callers pass it
 * through rather than wrapping it in a sentence about ciphertext.
 */
export class StaleKeyFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleKeyFileError';
  }
}

function encryptWith(key: Buffer, plaintext: string): string {
  return sealValue(key as ProfileKey, plaintext);
}

function decryptWith(key: Buffer, ciphertext: string): string {
  return openSealed(key as ProfileKey, ciphertext);
}

/**
 * Lightweight encrypted configuration storage for CLI
 * Uses AES-256-GCM encryption with file-based storage
 *
 * Replaces heavy TypeORM + SQLite stack for better performance
 */

interface TokenMetadata {
  encrypted: string;
  createdAt: string;
  updatedAt: string;
}

interface ConfigData {
  tokens: Record<string, TokenMetadata>; // provider -> token with metadata
  credentials: Record<string, any>; // provider -> encrypted credentials
  apiUrl?: string; // Flui API URL
  apiKey?: string; // Flui API key for CLI M2M access (encrypted)
  // Non-secret user preferences (email, paths, defaults). Plain text — never store secrets here.
  preferences?: Record<string, unknown>;
  metadata: {
    version: string;
    createdAt: string;
    updatedAt: string;
    apiUrlUpdatedAt?: string;
  };
}

export class ConfigStorage {
  private readonly configDir: string;
  private readonly configFile: string;
  private readonly encryptionKeyFile: string;
  private readonly profileName: string;

  constructor(profile?: string) {
    this.profileName = profile ?? ProfileManager.getActiveProfile();
    this.configDir = ProfileManager.getProfileDir(profile);
    this.configFile = join(this.configDir, 'config.json');
    this.encryptionKeyFile = join(this.configDir, '.key');
    this.ensureConfigDir();
  }

  /**
   * The key that opens this profile, resolved only when a secret is actually
   * touched.
   *
   * Lazy on purpose: most commands read a preference or an API URL, which are
   * plaintext. Resolving eagerly would make `flui config get email` demand a
   * passphrase, and an operator asked for one at a moment that plainly does not
   * need it learns to type it without thinking.
   *
   * The key file is the pre-vault arrangement, still honoured so an upgrade
   * does not lock anyone out of credentials they already have. `flui vault
   * unlock` re-seals those profiles and removes it.
   */
  private get encryptionKey(): Buffer {
    if (this.resolvedKey) return this.resolvedKey;

    const candidates: Array<{ source: 'vault' | 'legacy'; key: Buffer }> = [];
    const fromVault = getProfileKey(this.profileName);
    if (fromVault) candidates.push({ source: 'vault', key: fromVault });
    if (existsSync(this.encryptionKeyFile)) {
      candidates.push({
        source: 'legacy',
        key: readFileSync(this.encryptionKeyFile),
      });
    }
    if (candidates.length === 0) throw new VaultLockedError(this.profileName);

    // Which of the two is this profile's key cannot be told apart by looking:
    // a key file may be the fossil of a CLI that minted one on demand, or the
    // real key of a profile `vault unlock` failed to re-seal. Presence proves
    // neither. So an already-sealed value decides it — the encryption is
    // authenticated, so exactly one candidate can open it.
    const probe = this.sealedProbe();
    const chosen = probe
      ? candidates.find((c) => this.opens(c.key, probe))
      : candidates[0];

    if (!chosen) {
      this.keySource = candidates[0].source;
      throw this.staleKeyFileError();
    }

    this.keySource = chosen.source;
    this.resolvedKey = chosen.key;
    return chosen.key;
  }

  /** The key this profile turned out to use; resolved once per instance. */
  private resolvedKey: Buffer | null = null;

  /** Any value already sealed in this profile, to test a candidate key against. */
  private sealedProbe(): string | null {
    const config = this.readConfig();
    if (config.apiKey) return config.apiKey;
    for (const entry of Object.values(config.tokens ?? {})) {
      const sealed = (entry as { encrypted?: string })?.encrypted;
      if (sealed) return sealed;
    }
    for (const sealed of Object.values(config.credentials ?? {})) {
      if (typeof sealed === 'string' && sealed) return sealed;
    }
    return null;
  }

  private opens(key: Buffer, sealed: string): boolean {
    try {
      decryptWith(key, sealed);
      return true;
    } catch {
      return false;
    }
  }

  /** Which key the last read used, so a failure can name the likely reason. */
  private keySource: 'vault' | 'legacy' | null = null;

  /**
   * A key file that cannot open this profile's secrets.
   *
   * It is the leftover of a CLI old enough to mint one on demand, and it is
   * dangerous precisely because it exists: the lookup above takes it as proof
   * the profile predates the vault, so a locked vault stops announcing itself
   * and every read fails as `unable to authenticate data` instead. That reads
   * as corrupted data, and sends somebody looking for a lost credential rather
   * than typing a passphrase.
   */
  private staleKeyFileError(): Error {
    const vaultSealed = new VaultFile().exists();
    if (!vaultSealed) return new Error('The stored value could not be opened.');

    return new StaleKeyFileError(
      `The credentials for profile "${this.profileName}" could not be opened.\n` +
        `  They are sealed under the vault, and the vault is locked.\n` +
        `  Unlock it with:  flui vault unlock\n` +
        `  (${this.encryptionKeyFile} is a leftover from an older CLI and opens nothing; ` +
        `unlocking replaces it.)`,
    );
  }

  /** True when this profile still holds secrets sealed under the old key file. */
  public hasLegacyKeyFile(): boolean {
    return existsSync(this.encryptionKeyFile);
  }

  public get profile(): string {
    return this.profileName;
  }

  /**
   * Ensure profile directory exists
   */
  private ensureConfigDir(): void {
    if (!existsSync(this.configDir)) {
      mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
    }
  }

  /**
   * Re-seals every secret in this profile under the vault, then removes the key
   * file that used to protect them.
   *
   * The key file sat next to the data it protected, so anyone who could read
   * the profile could read both. Moving a profile across is therefore the whole
   * point of the vault, and it has to be safe to interrupt: each entry is
   * rewritten under the new key first, and only once the file has been written
   * is the old key deleted.
   */
  public adoptVaultKey(vaultKey: Buffer): number {
    if (!existsSync(this.encryptionKeyFile)) return 0;

    const legacy = readFileSync(this.encryptionKeyFile);
    const config = this.readConfig();
    let moved = 0;

    const reseal = (sealed: string): string => {
      const plaintext = decryptWith(legacy, sealed);
      moved += 1;
      return encryptWith(vaultKey, plaintext);
    };

    for (const [provider, entry] of Object.entries(config.tokens ?? {})) {
      config.tokens[provider] = {
        ...entry,
        encrypted: reseal(entry.encrypted),
      };
    }
    for (const [provider, sealed] of Object.entries(config.credentials ?? {})) {
      if (typeof sealed === 'string')
        config.credentials[provider] = reseal(sealed);
    }
    if (config.apiKey) config.apiKey = reseal(config.apiKey);

    this.writeConfig(config);
    rmSync(this.encryptionKeyFile, { force: true });
    return moved;
  }

  private encrypt(plaintext: string): string {
    return encryptWith(this.encryptionKey, plaintext);
  }

  private decrypt(ciphertext: string): string {
    const key = this.encryptionKey;
    try {
      return decryptWith(key, ciphertext);
    } catch (error) {
      // Only the key file can be wrong this way: a vault key that opens one
      // value opens them all, so a failure there is a real one and is passed on.
      if (this.keySource === 'legacy') throw this.staleKeyFileError();
      throw error;
    }
  }

  /**
   * Read config file (create if doesn't exist)
   */
  private readConfig(): ConfigData {
    if (!existsSync(this.configFile)) {
      return {
        tokens: {},
        credentials: {},
        metadata: {
          version: '1.0.0',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      };
    }

    try {
      const content = readFileSync(this.configFile, 'utf8');
      const parsed = JSON.parse(content) as Partial<ConfigData>;
      // Backfills structural keys missing from a config.json written before
      // they existed (e.g. `credentials` predates access-key/secret-key
      // providers) — every writer below assumes these are always objects.
      return {
        ...parsed,
        tokens: parsed.tokens ?? {},
        credentials: parsed.credentials ?? {},
        metadata: parsed.metadata ?? {
          version: '1.0.0',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      };
    } catch (error) {
      throw new Error(`Failed to read config file: ${error.message}`);
    }
  }

  /**
   * Write config file
   */
  private writeConfig(config: ConfigData): void {
    config.metadata.updatedAt = new Date().toISOString();
    writeFileSync(this.configFile, JSON.stringify(config, null, 2), {
      mode: 0o600,
    });
  }

  /**
   * Save encrypted API token for provider
   */
  public saveToken(provider: string, token: string): void {
    const config = this.readConfig();
    const now = new Date().toISOString();
    const existing = config.tokens[provider];

    config.tokens[provider] = {
      encrypted: this.encrypt(token),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    this.writeConfig(config);
  }

  /**
   * Get decrypted API token for provider
   */
  public getToken(provider: string): string | null {
    const config = this.readConfig();
    const tokenData = config.tokens[provider];

    if (!tokenData) {
      return null;
    }

    try {
      return this.decrypt(tokenData.encrypted);
    } catch (error) {
      // A closed vault is not a decryption failure, and saying so sends the
      // reader looking for corrupt data instead of typing their passphrase.
      if (error instanceof VaultLockedError) throw error;
      if (error instanceof StaleKeyFileError) throw error;
      throw new Error(
        `Failed to decrypt token for ${provider}: ${error.message}`,
      );
    }
  }

  /**
   * Get token metadata (without decrypting)
   */
  public getTokenMetadata(
    provider: string,
  ): { createdAt: string; updatedAt: string } | null {
    const config = this.readConfig();
    const tokenData = config.tokens[provider];

    if (!tokenData) {
      return null;
    }

    return {
      createdAt: tokenData.createdAt,
      updatedAt: tokenData.updatedAt,
    };
  }

  /**
   * Remove API token for provider
   */
  public removeToken(provider: string): void {
    const config = this.readConfig();
    delete config.tokens[provider];
    this.writeConfig(config);
  }

  /**
   * Check if token exists for provider
   */
  public hasToken(provider: string): boolean {
    const config = this.readConfig();
    return provider in config.tokens;
  }

  /**
   * Save encrypted credentials for provider
   */
  public saveCredentials(provider: string, credentials: any): void {
    const config = this.readConfig();
    config.credentials[provider] = this.encrypt(JSON.stringify(credentials));
    this.writeConfig(config);
  }

  /**
   * Get decrypted credentials for provider
   */
  public getCredentials(provider: string): any | null {
    const config = this.readConfig();
    const encryptedCredentials = config.credentials[provider];

    if (!encryptedCredentials) {
      return null;
    }

    try {
      const decrypted = this.decrypt(encryptedCredentials);
      return JSON.parse(decrypted);
    } catch (error) {
      if (error instanceof VaultLockedError) throw error;
      if (error instanceof StaleKeyFileError) throw error;
      throw new Error(
        `Failed to decrypt credentials for ${provider}: ${error.message}`,
      );
    }
  }

  public hasCredentials(provider: string): boolean {
    const config = this.readConfig();
    return provider in config.credentials;
  }

  public removeCredentials(provider: string): void {
    const config = this.readConfig();
    delete config.credentials[provider];
    this.writeConfig(config);
  }

  /**
   * List all configured providers
   */
  public listProviders(): string[] {
    const config = this.readConfig();
    const tokenProviders = Object.keys(config.tokens);
    const credentialProviders = Object.keys(config.credentials);
    return [...new Set([...tokenProviders, ...credentialProviders])];
  }

  /**
   * Get config file path (for debugging)
   */
  public getConfigPath(): string {
    return this.configFile;
  }

  /**
   * Save API URL
   */
  public saveApiUrl(url: string): void {
    const config = this.readConfig();
    config.apiUrl = url;
    config.metadata.apiUrlUpdatedAt = new Date().toISOString();
    this.writeConfig(config);
  }

  /**
   * Returns the ISO timestamp of the last apiUrl update, or null if never tracked.
   */
  public getApiUrlUpdatedAt(): string | null {
    const config = this.readConfig();
    return config.metadata.apiUrlUpdatedAt ?? null;
  }

  /**
   * Get API URL.
   * Resolution order:
   *   1. Saved value in this profile's config.json
   *   2. FLUI_API_URL env var
   *   3. Derived from clusters.json (master IP + nip token)
   * Returns null when no source provides a value — callers must decide whether
   * to error out (e.g. command needs API access) or just skip.
   */
  public getApiUrl(): string | null {
    const config = this.readConfig();

    if (config.apiUrl) {
      return config.apiUrl;
    }

    if (process.env.FLUI_API_URL) {
      return process.env.FLUI_API_URL;
    }

    try {
      const profileDir = ProfileManager.getProfileDir();
      const clustersPath = join(profileDir, 'clusters.json');
      if (existsSync(clustersPath)) {
        const clusters = JSON.parse(readFileSync(clustersPath, 'utf-8'));
        const cluster = Array.isArray(clusters) ? clusters[0] : null;
        if (cluster?.masterIpAddress) {
          const base = buildNipBaseDomain(
            cluster.masterIpAddress,
            cluster.nipHostnameToken,
          );
          return `https://api.${base}/api/v1`;
        }
      }
    } catch {
      // ignore read errors
    }

    return null;
  }

  /**
   * Same as getApiUrl but throws a CLI-friendly error when no URL is configured.
   * Use this from commands that cannot work without an API endpoint.
   */
  public getApiUrlOrThrow(): string {
    const url = this.getApiUrl();
    if (!url) {
      throw new Error(
        'API URL is not configured for this context.\n' +
          '  • Run `flui env create` to provision a cluster (URL is auto-derived).\n' +
          '  • Or set it manually: `flui config set api-url https://api.example.com/api/v1`.',
      );
    }
    return url;
  }

  /**
   * Remove API URL from config
   */
  public removeApiUrl(): void {
    const config = this.readConfig();
    delete config.apiUrl;
    this.writeConfig(config);
  }

  /**
   * Save encrypted API key for CLI M2M access
   */
  public setApiKey(key: string): void {
    const config = this.readConfig();
    config.apiKey = this.encrypt(key);
    this.writeConfig(config);
  }

  /**
   * Get decrypted API key for CLI M2M access
   * Falls back to FLUI_API_KEY environment variable
   */
  public getApiKey(): string | null {
    if (process.env.FLUI_API_KEY) {
      return process.env.FLUI_API_KEY;
    }

    const config = this.readConfig();
    if (!config.apiKey) return null;

    try {
      this.lastApiKeyFailure = null;
      return this.decrypt(config.apiKey);
    } catch (error) {
      // Deliberately silent, unlike the token and credential readers: this is
      // read while dependencies are being constructed, so throwing here turns
      // a locked vault into a stack trace on every command. The reason is kept
      // so `getApiKeyOrThrow` can state it where a secret is actually used.
      this.lastApiKeyFailure = error instanceof Error ? error : null;
      return null;
    }
  }

  /** Why the last `getApiKey()` came back empty, when it was not simply unset. */
  private lastApiKeyFailure: Error | null = null;

  /**
   * The API key, or an error that names the actual obstacle.
   *
   * Absent and sealed-shut are different problems with different remedies, and
   * for a long time every caller reported both as "Not logged in. Run `flui
   * auth login`" — advice that, followed against a locked vault, mints a second
   * credential beside the one already there rather than opening it.
   */
  public getApiKeyOrThrow(): string {
    const apiKey = this.getApiKey();
    if (apiKey) return apiKey;
    if (this.lastApiKeyFailure) throw this.lastApiKeyFailure;
    throw new Error('Not logged in. Run `flui auth login` first.');
  }

  /**
   * Read a non-secret preference from the active profile. Returns null when unset.
   * Preferences live in a dedicated namespace so they never collide with tokens/apiKey/metadata.
   */
  public getPreference<T = unknown>(key: string): T | null {
    const config = this.readConfig();
    const value = config.preferences?.[key];
    return value === undefined ? null : (value as T);
  }

  /**
   * Persist a non-secret preference under the active profile.
   * Use null/undefined to clear via `removePreference` instead.
   */
  public setPreference(key: string, value: unknown): void {
    const config = this.readConfig();
    if (!config.preferences) config.preferences = {};
    config.preferences[key] = value;
    this.writeConfig(config);
  }

  public removePreference(key: string): void {
    const config = this.readConfig();
    if (!config.preferences) return;
    delete config.preferences[key];
    this.writeConfig(config);
  }

  public getAllPreferences(): Record<string, unknown> {
    return { ...this.readConfig().preferences };
  }

  // ACME issuance tracking (Let's Encrypt rate-limit awareness)
  // Window matches LE: 5 certs per identical domain set per 168h.

  public getAcmeIssuances(): AcmeIssuance[] {
    const all = (
      this.getPreference<AcmeIssuance[]>('acmeIssuances') ?? []
    ).filter(
      (i) => Date.now() - new Date(i.issuedAt).getTime() < 168 * 3600 * 1000,
    );
    this.setPreference('acmeIssuances', all);
    return all;
  }

  public recordAcmeIssuance(entry: Omit<AcmeIssuance, 'issuedAt'>): void {
    const all = this.getAcmeIssuances();
    all.push({ ...entry, issuedAt: new Date().toISOString() });
    this.setPreference('acmeIssuances', all);
  }

  public countAcmeIssuances(
    domains: string,
    server: 'production' | 'staging',
  ): number {
    return this.getAcmeIssuances().filter(
      (i) => i.domains === domains && i.server === server,
    ).length;
  }
}

export interface AcmeIssuance {
  domains: string;
  server: 'production' | 'staging';
  issuedAt: string;
}
