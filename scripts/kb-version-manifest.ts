/**
 * kb-version-manifest — the version binding the assistant declares and reasons about.
 *
 * kbVersion is anchored to the CLI version (the CLI ships the KB). The manifest also
 * records the platform release the CLI pins (RELEASE) and the flui.yaml schema version,
 * so the assistant knows exactly which Flui it is talking to and can flag a runtime
 * mismatch instead of answering blind.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RELEASE } from '../src/config/release.config';

const ROOT = path.resolve(__dirname, '..');
const CLI_PKG = path.join(ROOT, 'cli/package.json');
const SOURCES = path.join(ROOT, 'src/modules/assistant/knowledge/sources');
const SCHEMAS: Array<{ key: 'catalogApp' | 'application'; file: string }> = [
  { key: 'catalogApp', file: 'flui-manifest.schema.json' },
  { key: 'application', file: 'flui-application.schema.json' },
];
const OUT_DIR = path.join(ROOT, 'src/modules/assistant/knowledge/generated');
const OUT = path.join(OUT_DIR, 'version-manifest.generated.json');

function cliVersion(): string {
  const pkg = JSON.parse(fs.readFileSync(CLI_PKG, 'utf8')) as {
    version: string;
  };
  return pkg.version;
}

interface SchemaBinding {
  schemaId: string;
  apiVersion: string;
}

/**
 * Both contracts, named separately.
 *
 * A single `spec` field forced a choice between them, and the choice that was
 * made reported the catalog schema as though it were the whole spec — so a
 * reader checking which contract the assistant held was told about the one kind
 * of manifest it was not being asked about.
 */
function specBindings(): Record<string, SchemaBinding> {
  const bindings: Record<string, SchemaBinding> = {};
  for (const { key, file } of SCHEMAS) {
    const full = path.join(SOURCES, file);
    if (!fs.existsSync(full)) {
      throw new Error(
        `kb-version-manifest: ${file} is missing — run \`pnpm kb:sync\` first.`,
      );
    }
    const schema = JSON.parse(fs.readFileSync(full, 'utf8')) as {
      $id?: string;
    };
    const id = schema.$id ?? 'unknown';
    // .../application/v1beta1.json -> application.v1beta1
    const match = id.match(/\/([^/]+)\/([^/]+)\.json$/);
    bindings[key] = {
      schemaId: id,
      apiVersion: match ? `${match[1]}.${match[2]}` : 'unknown',
    };
  }
  return bindings;
}

function main(): void {
  const cli = cliVersion();
  const manifest = {
    kbVersion: cli,
    cli,
    platform: {
      version: RELEASE.version,
      bootstrapRef: RELEASE.bootstrapRef,
      images: RELEASE.images,
    },
    spec: specBindings(),
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2) + '\n');
  console.log(
    `kb-version-manifest: kbVersion ${cli} · platform ${RELEASE.version} · spec ${manifest.spec.application.apiVersion} + ${manifest.spec.catalogApp.apiVersion}`,
  );
}

main();
