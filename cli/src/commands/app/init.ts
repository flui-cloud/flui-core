import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';
import { confirmPrompt, selectWithArrows } from '../../lib/prompts';
import {
  fetchRawFile,
  getTemplate,
  listTemplates,
  listVersionsFor,
  parseFrameworkArg,
  pickDefault,
  TemplateInfo,
} from '../../lib/template-fetcher';
import { detectFrameworkVersion } from '../../lib/framework-detector';
import { runFrameworkPostChecks } from '../../lib/framework-postchecks';

const DEPLOY_FILES_COMMON = ['flui.yaml', 'Dockerfile', '.dockerignore'];
const DEPLOY_FILES_BY_FRAMEWORK: Record<string, string[]> = {
  astro: ['nginx/default.conf'],
  angular: ['nginx/default.conf'],
  vitepress: ['nginx/default.conf'],
  'vue-vite': ['nginx/default.conf'],
};

function filesForFramework(framework: string): string[] {
  return [
    ...DEPLOY_FILES_COMMON,
    ...(DEPLOY_FILES_BY_FRAMEWORK[framework] ?? []),
  ];
}

type ConflictAction = 'skip' | 'overwrite' | 'backup' | 'diff';

export default class AppInit extends Command {
  static readonly description =
    'Copy Flui deploy files (Dockerfile + flui.yaml) from an official framework template into the current directory. ' +
    'Use this on an existing Git repository to make it deployable with `flui deploy`. ' +
    'Run `flui app init --list` to see the supported frameworks and versions.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> nextjs',
    '<%= config.bin %> <%= command.id %> nextjs@16',
    '<%= config.bin %> <%= command.id %> fastapi --target ./api',
    '<%= config.bin %> <%= command.id %> --list',
    '<%= config.bin %> <%= command.id %> nestjs --force',
    '<%= config.bin %> <%= command.id %> nuxt --dry-run',
  ];

  static readonly args = {
    framework: Args.string({
      description:
        'Framework template, optionally with a major version pin (e.g. `nextjs` or `nextjs@16`). Omit when using --list.',
      required: false,
    }),
  };

  static readonly flags = {
    list: Flags.boolean({
      description: 'Print supported frameworks and versions, then exit',
      default: false,
    }),
    force: Flags.boolean({
      description: 'Overwrite existing files without prompting',
      default: false,
    }),
    'dry-run': Flags.boolean({
      description: 'Print the actions that would be taken, no file writes',
      default: false,
    }),
    target: Flags.string({
      description: 'Target directory (default: current working directory)',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppInit);

    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKey();
    if (!apiKey) {
      this.error('Not logged in. Run `flui auth login` first.', { exit: 1 });
    }
    const api = new ApiClient({ baseUrl: apiUrl, apiKey });

    if (flags.list) {
      await this.printList(api);
      return;
    }

    if (!args.framework) {
      this.error(
        'Missing framework argument. Run `flui app init --list` to see the supported frameworks.',
        { exit: 1 },
      );
    }

    const { framework, version } = parseFrameworkArg(args.framework);
    const targetDir = path.resolve(flags.target ?? process.cwd());

    if (!fs.existsSync(targetDir)) {
      this.error(`Target directory does not exist: ${targetDir}`, { exit: 1 });
    }

    const template = await this.resolveTemplate(
      api,
      framework,
      version,
      flags.force,
    );
    if (!template) {
      this.exit(1);
    }

    if (template.isDeprecated) {
      console.log(
        chalk.yellow(
          `\n⚠  ${template.displayName} v${template.version} is marked as deprecated. ` +
            `Consider pinning a supported major version.\n`,
        ),
      );
    }

    const detected = detectFrameworkVersion(framework, targetDir);
    if (detected && detected.major !== template.version) {
      const stableOutput = ['astro', 'angular', 'sveltekit'].includes(
        framework,
      );
      if (stableOutput) {
        console.log(
          chalk.cyan(
            `\nℹ  Template targets ${framework}@${template.version}; your project is on ${framework}@${detected.major} (${detected.source}).`,
          ),
        );
        console.log(
          chalk.dim(
            `   The Dockerfile is a static-output build (nginx-served) and works the same across recent majors of ${framework}. No action required.\n`,
          ),
        );
      } else {
        console.log(
          chalk.yellow(
            `\n⚠  Version mismatch: your project pins ${chalk.bold(framework + '@' + detected.major)} ` +
              `(from ${detected.source}), but the template targets v${template.version}.`,
          ),
        );
        console.log(
          chalk.dim(
            `   The Dockerfile assumes the v${template.version} build artifacts (entrypoint, output paths). Either align the framework version, ` +
              `pin a matching template (\`flui app init --list\`), or review the Dockerfile before deploying.\n`,
          ),
        );
      }
    } else if (detected) {
      console.log(
        chalk.dim(
          `  Detected ${framework}@${detected.major} in this project — matches template.\n`,
        ),
      );
    }

    console.log('');
    for (const file of filesForFramework(framework)) {
      await this.processFile(template, file, targetDir, flags);
    }

    const renamed = flags['dry-run']
      ? null
      : this.autoFillFluiYamlName(targetDir);
    if (renamed) {
      console.log(
        chalk.dim(
          `  · flui.yaml metadata.name set to "${renamed.name}" (from ${renamed.source}).`,
        ),
      );
    }

    this.printPostCheckResults(framework, targetDir);

    this.printNextSteps(targetDir, template, flags['dry-run']);
  }

  /**
   * Replace the template placeholder `metadata.name` (e.g. `my-astro-app`,
   * `my-nextjs-app`, `my-app`) with a value derived from the user's project:
   *  1. `name` from package.json (if present)
   *  2. `name` from pyproject.toml `[project]`
   *  3. basename of the target directory
   * The substitution is conservative: it only triggers when the current value
   * starts with `my-` (template marker) so it never clobbers a name the user
   * has already personalised on a re-run.
   */
  private autoFillFluiYamlName(
    targetDir: string,
  ): { name: string; source: string } | null {
    const fluiYamlPath = path.join(targetDir, 'flui.yaml');
    if (!fs.existsSync(fluiYamlPath)) return null;
    const raw = fs.readFileSync(fluiYamlPath, 'utf8');
    const match = /^(\s*)name:\s*([^\s#]+)/m.exec(raw);
    if (!match) return null;
    const currentName = match[2];
    if (!currentName.startsWith('my-')) return null;

    const derived = this.deriveProjectName(targetDir);
    if (!derived || derived.name === currentName) return null;

    const sanitized = this.sanitizeAppName(derived.name);
    if (!sanitized) return null;

    const patched = raw.replace(
      /^(\s*)name:\s*([^\s#]+)/m,
      `$1name: ${sanitized}`,
    );
    fs.writeFileSync(fluiYamlPath, patched, 'utf8');
    return { name: sanitized, source: derived.source };
  }

  private deriveProjectName(
    targetDir: string,
  ): { name: string; source: string } | null {
    try {
      const pkgPath = path.join(targetDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
          name?: string;
        };
        if (parsed.name) return { name: parsed.name, source: 'package.json' };
      }
    } catch {
      /* ignore */
    }
    try {
      const pyPath = path.join(targetDir, 'pyproject.toml');
      if (fs.existsSync(pyPath)) {
        const raw = fs.readFileSync(pyPath, 'utf8');
        const m = /^\s*name\s*=\s*['"]([^'"]+)['"]/m.exec(raw);
        if (m) return { name: m[1], source: 'pyproject.toml' };
      }
    } catch {
      /* ignore */
    }
    const base = path.basename(path.resolve(targetDir));
    if (base && base !== '.' && base !== '/') {
      return { name: base, source: 'directory name' };
    }
    return null;
  }

  /**
   * Coerce an arbitrary project name into the slug shape expected by the
   * flui/v1 schema (lowercase, alphanumerics + dashes, no leading/trailing
   * dash). Falls back to null if the result is empty.
   */
  private sanitizeAppName(raw: string): string | null {
    const slug = raw
      .toLowerCase()
      .replace(/^@[^/]+\//, '')
      .replaceAll(/[^a-z0-9-]+/g, '-')
      .replaceAll(/^-+|-+$/g, '');
    return slug || null;
  }

  private printPostCheckResults(framework: string, targetDir: string): void {
    const issues = runFrameworkPostChecks(framework, targetDir);
    if (issues.length === 0) return;

    for (const issue of issues) {
      const icon =
        issue.level === 'warn' ? chalk.yellow('⚠') : chalk.cyan('ℹ');
      console.log('');
      console.log(`  ${icon} ${chalk.bold(issue.title)}`);
      console.log(chalk.dim(`     ${issue.detail}`));
      for (const line of issue.hint.split('\n')) {
        console.log(chalk.dim(`     ${line}`));
      }
    }
  }

  private async resolveTemplate(
    api: ApiClient,
    framework: string,
    version: string | undefined,
    force: boolean,
  ): Promise<TemplateInfo | undefined> {
    const refLabel = framework + (version ? `@${version}` : '');
    const spinner = ora(`Resolving template ${chalk.bold(refLabel)}…`).start();
    try {
      const template = await getTemplate(api, framework, version);
      spinner.succeed(
        `Template: ${chalk.bold(template.displayName)} v${template.version} (${template.repo})`,
      );
      return template;
    } catch (error: unknown) {
      spinner.stop();

      const available = await listVersionsFor(api, framework).catch(() => []);

      if (available.length === 0) {
        console.log(chalk.red(`\n  Template "${framework}" not found.\n`));
        return undefined;
      }

      if (!version) {
        console.log(chalk.red(`\n  ${(error as Error).message}\n`));
        return undefined;
      }

      const fallback = pickDefault(available) ?? available[0];
      const availStr = available.map((t) => `v${t.version}`).join(', ');

      console.log(
        chalk.yellow(
          `\n⚠  ${framework}@${version} is not in the registry. Available: ${availStr}.`,
        ),
      );

      if (force || !process.stdin.isTTY) {
        console.log(
          chalk.yellow(
            `   Falling back to ${chalk.bold(fallback.framework + '@' + fallback.version)} ` +
              `(${force ? '--force' : 'non-TTY'}).\n`,
          ),
        );
        return fallback;
      }

      const ok = await confirmPrompt(
        `Use ${fallback.framework}@${fallback.version} instead?`,
        true,
      );
      if (!ok) {
        console.log(chalk.dim('\n  Cancelled.\n'));
        return undefined;
      }
      console.log('');
      return fallback;
    }
  }

  private async printList(api: ApiClient): Promise<void> {
    const spinner = ora('Loading templates…').start();
    let templates: TemplateInfo[];
    try {
      templates = await listTemplates(api);
      spinner.stop();
    } catch (error: unknown) {
      spinner.fail('Failed to load templates');
      console.log(chalk.red(`\n  ${(error as Error).message}\n`));
      this.exit(1);
    }

    const sorted = [...templates].sort(
      (a, b) =>
        a.framework.localeCompare(b.framework) ||
        a.version.localeCompare(b.version),
    );

    const rows = sorted.map((t) => ({
      ref: `${t.framework}@${t.version}`,
      name: t.displayName,
      lang: t.language,
      cat: t.category,
      flags: [
        t.isDefault ? chalk.green('default') : '',
        t.isDeprecated ? chalk.yellow('deprecated') : '',
      ]
        .filter(Boolean)
        .join(' '),
    }));

    const refW = Math.max(...rows.map((r) => r.ref.length), 3);
    const nameW = Math.max(...rows.map((r) => r.name.length), 4);
    const langW = Math.max(...rows.map((r) => r.lang.length), 4);

    console.log('');
    console.log(
      `  ${chalk.bold('REF'.padEnd(refW))}  ${chalk.bold('NAME'.padEnd(nameW))}  ${chalk.bold('LANG'.padEnd(langW))}  ${chalk.bold('CATEGORY')}`,
    );
    console.log(
      `  ${'─'.repeat(refW)}  ${'─'.repeat(nameW)}  ${'─'.repeat(langW)}  ${'─'.repeat(10)}`,
    );
    for (const r of rows) {
      const flagsSuffix = r.flags ? `  ${r.flags}` : '';
      console.log(
        `  ${r.ref.padEnd(refW)}  ${r.name.padEnd(nameW)}  ${r.lang.padEnd(langW)}  ${r.cat}${flagsSuffix}`,
      );
    }
    console.log('');
    console.log(
      chalk.dim(
        '  Use `flui app init <framework>` or `flui app init <framework>@<version>` to copy deploy files.\n',
      ),
    );
  }

  private async processFile(
    template: TemplateInfo,
    filename: string,
    targetDir: string,
    flags: { force: boolean; 'dry-run': boolean },
  ): Promise<void> {
    const destPath = path.join(targetDir, filename);
    const relPath = path.relative(process.cwd(), destPath) || filename;
    const spinner = ora(`Fetching ${filename}…`).start();

    let content: string;
    try {
      content = await fetchRawFile(template.repo, filename);
      spinner.stop();
    } catch (error: unknown) {
      spinner.stop();
      console.log(
        chalk.dim(
          `  · skipped ${filename} (not in template ${template.repo}): ${(error as Error).message}`,
        ),
      );
      return;
    }

    const destDir = path.dirname(destPath);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    const exists = fs.existsSync(destPath);

    if (!exists) {
      if (flags['dry-run']) {
        console.log(`  ${chalk.green('+')} would write ${relPath}`);
        return;
      }
      fs.writeFileSync(destPath, content, 'utf8');
      console.log(`  ${chalk.green('✔')} wrote ${relPath}`);
      return;
    }

    if (flags.force) {
      if (flags['dry-run']) {
        console.log(`  ${chalk.yellow('~')} would overwrite ${relPath}`);
        return;
      }
      fs.writeFileSync(destPath, content, 'utf8');
      console.log(`  ${chalk.yellow('✔')} overwrote ${relPath}`);
      return;
    }

    if (flags['dry-run']) {
      console.log(
        `  ${chalk.yellow('?')} ${relPath} exists — would prompt for skip/overwrite/backup`,
      );
      return;
    }

    const action = await this.promptConflict(relPath, destPath, content);

    if (action === 'skip') {
      console.log(`  ${chalk.dim('·')} skipped ${relPath}`);
      return;
    }
    if (action === 'backup') {
      const backupPath = `${destPath}.bak`;
      fs.copyFileSync(destPath, backupPath);
      console.log(
        `  ${chalk.dim('·')} backed up existing → ${path.relative(process.cwd(), backupPath)}`,
      );
    }
    fs.writeFileSync(destPath, content, 'utf8');
    console.log(`  ${chalk.yellow('✔')} overwrote ${relPath}`);
  }

  private async promptConflict(
    relPath: string,
    destPath: string,
    newContent: string,
  ): Promise<ConflictAction> {
    while (true) {
      const choice = await selectWithArrows(`${relPath} already exists.`, [
        { label: 'Skip (keep existing)' },
        { label: 'Overwrite' },
        { label: 'Backup existing as .bak, then overwrite' },
        { label: 'Show diff against existing' },
      ]);

      if (choice === -1 || choice === 0) return 'skip';
      if (choice === 1) {
        const ok = await confirmPrompt(`Overwrite ${relPath}?`, false);
        if (ok) return 'overwrite';
        continue;
      }
      if (choice === 2) return 'backup';
      if (choice === 3) {
        this.printDiff(destPath, newContent);
      }
    }
  }

  private printDiff(existingPath: string, newContent: string): void {
    const existing = fs.readFileSync(existingPath, 'utf8');
    const a = existing.split('\n');
    const b = newContent.split('\n');
    const max = Math.max(a.length, b.length);
    console.log('');
    console.log(chalk.dim(`  --- existing  +++ template`));
    for (let i = 0; i < max; i++) {
      const left = a[i];
      const right = b[i];
      if (left === right) continue;
      if (left !== undefined)
        console.log(chalk.red(`  - ${left.slice(0, 200)}`));
      if (right !== undefined)
        console.log(chalk.green(`  + ${right.slice(0, 200)}`));
    }
    console.log('');
  }

  private printNextSteps(
    targetDir: string,
    template: TemplateInfo,
    dryRun: boolean,
  ): void {
    console.log('');
    if (dryRun) {
      console.log(
        chalk.dim('  (dry-run) Re-run without --dry-run to apply.\n'),
      );
      return;
    }
    console.log(chalk.dim('  Next steps:'));
    if (targetDir !== process.cwd()) {
      console.log(
        chalk.dim(`    cd ${path.relative(process.cwd(), targetDir)}`),
      );
    }
    console.log(chalk.dim(`    # 1. Review the changes`));
    console.log(chalk.dim(`    git diff`));
    console.log(
      chalk.dim(
        `    # 2. Verify flui.yaml — metadata.name is auto-filled when possible,`,
      ),
    );
    console.log(
      chalk.dim(
        `    #    confirm port=${template.port}, healthcheck=${template.healthcheckPath}, and any env vars your app needs`,
      ),
    );
    console.log(chalk.dim(`    # 3. Validate the manifest`));
    console.log(chalk.dim(`    flui catalog validate ./flui.yaml`));
    console.log(
      chalk.dim(
        `    # 4. Commit and push, then deploy (build runs on GitHub Actions)`,
      ),
    );
    console.log(
      chalk.dim(
        `    git add . && git commit -m "chore: add Flui deploy files" && git push`,
      ),
    );
    console.log(chalk.dim(`    flui deploy`));
    console.log('');
  }
}
