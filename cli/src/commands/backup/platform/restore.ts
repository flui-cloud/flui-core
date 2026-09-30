import * as fs from 'node:fs';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { promptMaskedInput } from '../../../lib/prompts';
import {
  identitiesIn,
  openPlatformDump,
  SecureKeyFile,
  writeSecureKeys,
} from '../../../lib/platform-dump';
import { ProfileManager } from '../../../lib/profile-manager';
import { SealedPlatformIdentity } from '../../../lib/vault/sealed-platform-identity';

// age-encryption is ESM-only; the Function indirection keeps a genuine dynamic
// import that survives the tsc→CommonJS rewrite. Same trick as `platform init`.
type AgeModule = typeof import('age-encryption');
const loadAge = new Function(
  'return import("age-encryption")',
) as () => Promise<AgeModule>;

interface CapturedClusterSecret {
  namespace: string;
  name: string;
  data: Record<string, string>;
}

interface KeyBundleManifest {
  version: number;
  createdAt: string;
  masterEnvId: string;
  dek: string;
  encryptionKey: string;
  encryptionKeyFingerprint: string;
  sshKeyEncryptionKey: string | null;
  sshCa?: { privateKey: string; publicKey: string | null; source: string };
  zitadelPat: string | null;
  clusterSecrets?: CapturedClusterSecret[];
  secureKeys?: SecureKeyFile[];
  databases: string[];
  zitadelCovered: boolean;
  insecureDefaults: string[];
}

export default class BackupPlatformRestore extends Command {
  static readonly description =
    'Open a platform backup: decrypt the sealed key bundle and the control-plane ' +
    'dump with the key kept in your vault — or, when this machine is gone, the ' +
    'recovery copy — and write out everything a fresh installation needs to ' +
    'become this one again.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --bundle ./keybundle.age --dump ./flui-pg.dump.gz.enc',
    '<%= config.bin %> <%= command.id %> --bundle ./keybundle.age --dump ./flui-pg.dump.gz.enc --identity ./flui-staging-platform-recovery.age --out ./rebuild',
  ];

  static readonly flags = {
    bundle: Flags.string({
      required: true,
      description: 'Path to the age-sealed key bundle (keybundle.age)',
    }),
    dump: Flags.string({
      required: true,
      description:
        'Path to the encrypted control-plane dump (flui-pg.dump.gz.enc)',
    }),
    identity: Flags.string({
      description:
        'Recovery copy written by `flui backup platform init`. Omit it to use the keys in your vault.',
    }),
    passphrase: Flags.string({
      description:
        'Passphrase of the recovery copy — your vault passphrase (prompted if omitted)',
    }),
    out: Flags.string({
      default: './flui-rebuild',
      description: 'Directory to write the decrypted material into',
    }),
    force: Flags.boolean({
      description: 'Overwrite an existing output directory',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(BackupPlatformRestore);

    const outDir = path.resolve(flags.out);
    if (fs.existsSync(outDir) && !flags.force) {
      this.error(
        `${outDir} already exists. Pass --force to overwrite, or pick another --out.`,
      );
    }

    const age = await loadAge();
    const identities = flags.identity
      ? await this.recoveryIdentities(age, flags.identity, flags.passphrase)
      : this.vaultIdentities();

    // 2. identities → the sealed key bundle
    let manifest: KeyBundleManifest;
    try {
      const decrypter = new age.Decrypter();
      for (const identity of identities) decrypter.addIdentity(identity);
      const gz = await decrypter.decrypt(
        new Uint8Array(fs.readFileSync(flags.bundle)),
      );
      manifest = JSON.parse(gunzipSync(Buffer.from(gz)).toString('utf-8'));
    } catch (err) {
      this.error(
        `Could not open the key bundle with ${identities.length === 1 ? 'this key' : `any of these ${identities.length} keys`}: ${(err as Error).message}`,
      );
    }

    // 3. the bundle's per-run DEK → the dump
    const sql = this.decryptDump(
      fs.readFileSync(flags.dump),
      Buffer.from(manifest.dek, 'hex'),
    );

    fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
    const sqlPath = path.join(outDir, 'flui-control-plane.sql');
    fs.writeFileSync(sqlPath, sql, { mode: 0o600 });

    const envPath = path.join(outDir, 'install-keys.env');
    const envLines = [
      '# Give these to the fresh installation before it boots.',
      '# Without them the restored database loads and every encrypted column',
      '# — provider tokens, kubeconfigs, SSH keys, app secrets — is unreadable.',
      '#',
      '# Export this one, then run `flui env create`:',
      `FLUI_RESTORE_ENCRYPTION_KEY=${manifest.encryptionKey}`,
    ];
    if (manifest.sshKeyEncryptionKey) {
      envLines.push(
        '#',
        '# This one is minted on the master by the bootstrap and cannot be passed to',
        '# `env create`. Put it into the flui-secrets Secret after the install, then',
        '# restart flui-api — see the runbook.',
        `SSH_KEY_ENCRYPTION_KEY=${manifest.sshKeyEncryptionKey}`,
      );
    }
    if (manifest.zitadelPat) {
      envLines.push(`ZITADEL_SERVICE_ACCOUNT_PAT=${manifest.zitadelPat}`);
    }
    fs.writeFileSync(envPath, envLines.join('\n') + '\n', { mode: 0o600 });

    const retirePath = path.join(outDir, 'retire-old-control-row.sql');
    fs.writeFileSync(
      retirePath,
      [
        '-- Run AFTER loading flui-control-plane.sql.',
        '-- Retires the control-cluster row of the installation this backup came',
        '-- from: the machine it names no longer exists. Soft-delete rather than',
        '-- DELETE, so applications that still reference it keep their history.',
        `UPDATE infrastructure_clusters`,
        `   SET "deletedAt" = now(), status = 'deleted'`,
        ` WHERE id = '${manifest.masterEnvId}';`,
        '',
      ].join('\n'),
      { mode: 0o600 },
    );

    const written = [sqlPath, envPath, retirePath];

    const secrets = manifest.clusterSecrets ?? [];
    if (secrets.length) {
      const secretsPath = path.join(outDir, 'cluster-secrets.json');
      fs.writeFileSync(secretsPath, JSON.stringify(secrets, null, 2), {
        mode: 0o600,
      });
      written.push(secretsPath);
    }

    if (manifest.sshCa?.privateKey) {
      const caPath = path.join(outDir, 'ssh-ca');
      fs.writeFileSync(caPath, manifest.sshCa.privateKey, { mode: 0o600 });
      written.push(caPath);
      if (manifest.sshCa.publicKey) {
        fs.writeFileSync(`${caPath}.pub`, manifest.sshCa.publicKey, {
          mode: 0o644,
        });
        written.push(`${caPath}.pub`);
      }
    }

    const secureKeys = manifest.secureKeys ?? [];
    if (secureKeys.length) {
      try {
        writeSecureKeys(outDir, secureKeys);
      } catch (err) {
        this.error((err as Error).message);
      }
      written.push(path.join(outDir, 'secure-keys'));
    }

    this.report(manifest, outDir, written, secrets);
  }

  private vaultIdentities(): string[] {
    try {
      return new SealedPlatformIdentity(
        ProfileManager.getActiveProfile(),
      ).identities();
    } catch (err) {
      this.error(
        `${(err as Error).message}\n  Or open the recovery copy instead: --identity <file>`,
      );
    }
  }

  private async recoveryIdentities(
    age: AgeModule,
    file: string,
    provided?: string,
  ): Promise<string[]> {
    const passphrase =
      provided ??
      (await promptMaskedInput(
        'Passphrase of the recovery copy (your vault passphrase): ',
      ));
    if (!passphrase) this.error('A passphrase is required to open the copy.');
    try {
      const decrypter = new age.Decrypter();
      decrypter.addPassphrase(passphrase);
      const opened = await decrypter.decrypt(
        age.armor.decode(fs.readFileSync(file, 'utf-8')),
      );
      const identities = identitiesIn(new TextDecoder().decode(opened));
      if (identities.length === 0) throw new Error('it holds no age key');
      return identities;
    } catch (err) {
      this.error(
        `Could not open the recovery copy — wrong passphrase, or not a recovery copy: ${(err as Error).message}`,
      );
    }
  }

  private decryptDump(framed: Buffer, dek: Buffer): Buffer {
    try {
      return openPlatformDump(framed, dek);
    } catch (err) {
      this.error((err as Error).message);
    }
  }

  private report(
    manifest: KeyBundleManifest,
    outDir: string,
    written: string[],
    secrets: CapturedClusterSecret[],
  ): void {
    this.log('');
    this.log(
      `   ${chalk.green('✔')} Opened the platform backup of ${chalk.bold(manifest.masterEnvId)}`,
    );
    this.log(`   ${chalk.dim('taken')} ${manifest.createdAt}`);
    this.log(
      `   ${chalk.dim('databases')} ${manifest.databases.join(', ') || '—'}`,
    );
    this.log('');
    this.log(`   ${chalk.bold('Written to')} ${outDir}`);
    for (const f of written)
      this.log(`     ${chalk.dim('·')} ${path.basename(f)}`);
    this.log('');

    const hasMasterkey = secrets.some(
      (s) => s.name === 'zitadel-secrets' && s.data.masterkey,
    );
    if (manifest.zitadelCovered && !hasMasterkey) {
      this.log(
        chalk.red(
          '   ⚠  This bundle carries no Zitadel masterkey. The Zitadel database will\n' +
            '      restore but cannot be decrypted: every user and OIDC client is lost.\n' +
            '      Recover in local-auth mode, or rebuild identity from scratch.',
        ),
      );
      this.log('');
    }
    if (manifest.insecureDefaults?.length) {
      this.log(
        chalk.yellow(
          `   ⚠  Recorded weaknesses at backup time: ${manifest.insecureDefaults.join(', ')}`,
        ),
      );
      this.log('');
    }

    const steps = [
      `give it the keys in ${chalk.cyan('install-keys.env')} before first boot`,
      `load ${chalk.cyan('flui-control-plane.sql')} into its Postgres`,
      ...(secrets.length
        ? [`re-apply the Secrets in ${chalk.cyan('cluster-secrets.json')}`]
        : []),
      ...(manifest.secureKeys?.length
        ? [
            `put the files of ${chalk.cyan('secure-keys/')} into the API's key directory (/secure/keys), keeping their permissions`,
          ]
        : []),
      `run ${chalk.cyan('retire-old-control-row.sql')}`,
    ];
    this.log(`   ${chalk.bold('Next')}, on the fresh installation:`);
    steps.forEach((step, i) => this.log(`     ${i + 1}. ${step}`));
    this.log('');
    this.log(
      chalk.dim(
        '   The full procedure, including why each step is needed, is the cold-rebuild\n' +
          '   runbook: https://docs.flui.cloud/tasks/rebuild-the-control-plane/',
      ),
    );
    this.log('');
    this.log(
      chalk.yellow(
        `   Everything in ${path.basename(outDir)} is plaintext key material. Delete it when done.`,
      ),
    );
    this.log('');
  }
}
