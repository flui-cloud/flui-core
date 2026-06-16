#!/usr/bin/env ts-node
/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Static validator for flui.yaml catalog manifests.
 *
 * Usage:
 *   pnpm run catalog:validate <file-or-glob> [<file> ...]
 *
 * Examples:
 *   pnpm run catalog:validate src/modules/catalog/seed/vaultwarden.flui.yaml
 *   pnpm run catalog:validate src/modules/catalog/seed/*.flui.yaml
 *
 * Exits 0 if all files validate, 1 otherwise. Meant for editor save hooks,
 * pre-commit hooks and CI.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { CatalogSchemaValidatorService } from '../src/modules/catalog/services/catalog-schema-validator.service';
import { CatalogManifestLoaderService } from '../src/modules/catalog/services/catalog-manifest-loader.service';

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

interface FileResult {
  path: string;
  ok: boolean;
  errors: string[];
  slug?: string;
  version?: string;
  appType?: string;
  checksum?: string;
}

function extractErrors(err: unknown): string[] {
  if (err && typeof err === 'object') {
    const anyErr = err as {
      response?: { errors?: string[]; message?: string | string[] };
      message?: string;
      errors?: string[];
    };
    const resp = anyErr.response;
    if (resp) {
      if (Array.isArray(resp.errors)) return resp.errors;
      if (Array.isArray(resp.message)) return resp.message;
      if (typeof resp.message === 'string') return [resp.message];
    }
    if (Array.isArray(anyErr.errors)) return anyErr.errors;
    if (typeof anyErr.message === 'string') return [anyErr.message];
  }
  return [String(err)];
}

async function validateFile(
  path: string,
  loader: CatalogManifestLoaderService,
): Promise<FileResult> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    return {
      path,
      ok: false,
      errors: [
        `cannot read file: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  try {
    const { manifest, checksum } = loader.load(raw);
    return {
      path,
      ok: true,
      errors: [],
      slug: manifest.metadata.id,
      version: manifest.metadata.version,
      appType: manifest.spec.type,
      checksum,
    };
  } catch (err) {
    return { path, ok: false, errors: extractErrors(err) };
  }
}

function printResult(result: FileResult): void {
  const rel = result.path.replace(`${process.cwd()}/`, '');
  if (result.ok) {
    process.stdout.write(
      `${GREEN}✔${RESET} ${BOLD}${rel}${RESET} ` +
        `${DIM}(${result.slug}@${result.version}, type=${result.appType}, ` +
        `checksum=${result.checksum?.slice(0, 12)}...)${RESET}\n`,
    );
  } else {
    process.stdout.write(`${RED}✘${RESET} ${BOLD}${rel}${RESET}\n`);
    for (const err of result.errors) {
      process.stdout.write(`  ${RED}→${RESET} ${err}\n`);
    }
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    process.stderr.write(
      `${YELLOW}usage:${RESET} catalog-validate <file> [<file> ...]\n`,
    );
    process.exit(2);
  }

  // Instantiate services directly — no Nest DI to avoid loading DB/Redis/etc.
  const validator = new CatalogSchemaValidatorService();
  const loader = new CatalogManifestLoaderService(validator);

  const results: FileResult[] = [];
  for (const arg of argv) {
    results.push(await validateFile(resolve(arg), loader));
  }

  for (const r of results) printResult(r);

  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.length - okCount;
  const color = failCount > 0 ? RED : GREEN;
  process.stdout.write(
    `\n${color}${BOLD}${okCount}/${results.length} valid${RESET}` +
      (failCount > 0 ? `, ${RED}${failCount} failed${RESET}` : '') +
      '\n',
  );
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(
    `${RED}fatal:${RESET} ${err instanceof Error ? err.stack : err}\n`,
  );
  process.exit(1);
});
