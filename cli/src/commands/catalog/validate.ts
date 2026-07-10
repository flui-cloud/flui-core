import { Command, Args } from '@oclif/core';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  validate as validateSpec,
  parseYaml,
  computeChecksum,
  type FluiValidationError,
  type FluiManifest,
} from '@flui-cloud/spec';
import chalk from 'chalk';

interface FileResult {
  path: string;
  ok: boolean;
  errors: string[];
  kind?: string;
  slug?: string;
  version?: string;
  appType?: string;
  checksum?: string;
}

export default class CatalogValidate extends Command {
  static readonly description =
    'Validate one or more flui.yaml manifests against the flui spec. ' +
    'Supports both `kind: CatalogApp` (full schema) and `kind: Application` (lightweight checks).';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> ./flui.yaml',
    '<%= config.bin %> <%= command.id %> ./catalog/vaultwarden.flui.yaml ./catalog/memos.flui.yaml',
  ];

  static readonly strict = false;

  static readonly args = {
    file: Args.string({
      description: 'Path to a flui.yaml file (repeatable)',
      required: true,
    }),
  };

  async run(): Promise<void> {
    const { argv } = await this.parse(CatalogValidate);
    const files = argv as string[];

    const results = files.map((f) => this.validateFile(path.resolve(f)));
    for (const r of results) this.printResult(r);

    const okCount = results.filter((r) => r.ok).length;
    const failCount = results.length - okCount;
    const validLabel = chalk.bold(`${okCount}/${results.length} valid`);
    const failLabel = chalk.red(`${failCount} failed`);
    const failSuffix = failCount > 0 ? `, ${failLabel}` : '';
    const summary = `\n${validLabel}${failSuffix}`;
    this.log(failCount > 0 ? chalk.red(summary) : chalk.green(summary));

    if (failCount > 0) this.exit(1);
  }

  private validateFile(filePath: string): FileResult {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      return {
        path: filePath,
        ok: false,
        errors: [
          `cannot read file: ${err instanceof Error ? err.message : String(err)}`,
        ],
      };
    }

    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { path: filePath, ok: false, errors: [`invalid YAML: ${msg}`] };
    }

    const result = validateSpec(parsed);
    if (!result.valid) {
      return {
        path: filePath,
        ok: false,
        errors: this.formatErrors(result.errors),
      };
    }

    return {
      path: filePath,
      ok: true,
      errors: [],
      ...this.summarize(result.manifest),
    };
  }

  private summarize(manifest: FluiManifest): Partial<FileResult> {
    if (manifest.kind === 'CatalogApp') {
      return {
        kind: 'CatalogApp',
        slug: manifest.metadata.id,
        version: manifest.metadata.version,
        appType: manifest.spec.type,
        checksum: computeChecksum(manifest),
      };
    }
    if (manifest.kind === 'Application') {
      return {
        kind: 'Application',
        slug: manifest.metadata.name,
        version: manifest.apiVersion,
        appType: manifest.build?.strategy,
        checksum: computeChecksum(manifest),
      };
    }
    return {
      kind: manifest.kind,
      slug: manifest.metadata.name,
      version: manifest.apiVersion,
      checksum: computeChecksum(manifest),
    };
  }

  private formatErrors(errors: FluiValidationError[]): string[] {
    return errors.map((e) => {
      const params = e.params ? ' ' + JSON.stringify(e.params) : '';
      return `${e.path} ${e.message}${params}`;
    });
  }

  private printResult(result: FileResult): void {
    const rel = result.path.startsWith(process.cwd() + '/')
      ? result.path.slice(process.cwd().length + 1)
      : result.path;
    if (result.ok) {
      const tag = chalk.cyan(`[${result.kind}]`);
      const checksum = result.checksum?.slice(0, 12);
      this.log(
        `${chalk.green('✔')} ${tag} ${chalk.bold(rel)} ${chalk.dim(
          `(${result.slug}@${result.version}` +
            (result.appType ? `, type=${result.appType}` : '') +
            (checksum ? `, checksum=${checksum}…` : '') +
            ')',
        )}`,
      );
    } else {
      this.log(`${chalk.red('✘')} ${chalk.bold(rel)}`);
      for (const err of result.errors) {
        this.log(`  ${chalk.red('→')} ${err}`);
      }
    }
  }
}
