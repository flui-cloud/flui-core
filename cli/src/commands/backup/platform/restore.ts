import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { promptMaskedInput } from '../../../lib/prompts';

// age-encryption is ESM-only; the Function indirection keeps a genuine dynamic
// import that survives the tsc→CommonJS rewrite. Same trick as `platform init`.
type AgeModule = typeof import('age-encryption');
const loadAge = new Function(
  'return import("age-encryption")',
) as () => Promise<AgeModule>;

/** FLUIPB1\0 + iv(16) + ciphertext + gcm tag(16) — written by PlatformBackupService. */
const DUMP_MAGIC = Buffer.from('FLUIPB1\0', 'binary');

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
  databases: string[];
  zitadelCovered: boolean;
  insecureDefaults: string[];
}

export default class BackupPlatformRestore extends Command {
  static readonly description =
    'Open a platform backup: decrypt the sealed key bundle and the control-plane ' +
    'dump with your offline age identity, and write out everything a fresh ' +
    'installation needs to become this one again.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --bundle ./keybundle.age --dump ./flui-pg.dump.gz.enc --identity ./flui-master-recovery.age',
    '<%= config.bin %> <%= command.id %> --bundle ./keybundle.age --dump ./flui-pg.dump.gz.enc --identity ./recovery.age --out ./rebuild',
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
      required: true,
      description:
        'Path to the recovery file written by `flui backup platform init`',
    }),
    passphrase: Flags.string({
      description:
        'Passphrase protecting the recovery file (prompted if omitted)',
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

    const passphrase =
      flags.passphrase ??
      (await promptMaskedInput('Passphrase for the recovery file: '));
    if (!passphrase)
      this.error('A passphrase is required to open the identity.');

    const age = await loadAge();

    // 1. recovery file (passphrase) → the age identity
    let identity: string;
    try {
      const armored = fs.readFileSync(flags.identity, 'utf-8');
      const decrypter = new age.Decrypter();
      decrypter.addPassphrase(passphrase);
      const opened = await decrypter.decrypt(age.armor.decode(armored));
      identity = new TextDecoder().decode(opened).trim();
    } catch (err) {
      this.error(
        `Could not open the recovery file — wrong passphrase, or not a recovery file: ${(err as Error).message}`,
      );
    }

    // 2. identity → the sealed key bundle
    let manifest: KeyBundleManifest;
    try {
      const decrypter = new age.Decrypter();
      decrypter.addIdentity(identity);
      const gz = await decrypter.decrypt(
        new Uint8Array(fs.readFileSync(flags.bundle)),
      );
      manifest = JSON.parse(gunzipSync(Buffer.from(gz)).toString('utf-8'));
    } catch (err) {
      this.error(
        `Could not open the key bundle with this identity: ${(err as Error).message}`,
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

    this.report(manifest, outDir, written, secrets);
  }

  private decryptDump(framed: Buffer, dek: Buffer): Buffer {
    if (!framed.subarray(0, DUMP_MAGIC.length).equals(DUMP_MAGIC)) {
      this.error(
        'That file is not a Flui platform dump (missing the FLUIPB1 header).',
      );
    }
    const ivStart = DUMP_MAGIC.length;
    const iv = framed.subarray(ivStart, ivStart + 16);
    const tag = framed.subarray(-16);
    const ciphertext = framed.subarray(ivStart + 16, -16);

    const decipher = crypto.createDecipheriv('aes-256-gcm', dek, iv);
    decipher.setAuthTag(tag);
    try {
      const gz = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return gunzipSync(gz);
    } catch (err) {
      this.error(
        `The dump did not decrypt with this bundle's key — bundle and dump are ` +
          `from different runs, or the file is truncated: ${(err as Error).message}`,
      );
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

    this.log(`   ${chalk.bold('Next')}, on the fresh installation:`);
    this.log(
      `     1. give it the keys in ${chalk.cyan('install-keys.env')} before first boot`,
    );
    this.log(
      `     2. load ${chalk.cyan('flui-control-plane.sql')} into its Postgres`,
    );
    if (secrets.length) {
      this.log(
        `     3. re-apply the Secrets in ${chalk.cyan('cluster-secrets.json')}`,
      );
      this.log(`     4. run ${chalk.cyan('retire-old-control-row.sql')}`);
    } else {
      this.log(`     3. run ${chalk.cyan('retire-old-control-row.sql')}`);
    }
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
