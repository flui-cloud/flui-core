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
const SCHEMA = path.join(
  ROOT,
  'src/modules/assistant/knowledge/sources/flui-manifest.schema.json',
);
const OUT_DIR = path.join(ROOT, 'src/modules/assistant/knowledge/generated');
const OUT = path.join(OUT_DIR, 'version-manifest.generated.json');

function cliVersion(): string {
  const pkg = JSON.parse(fs.readFileSync(CLI_PKG, 'utf8')) as {
    version: string;
  };
  return pkg.version;
}

function specApiVersion(): { schemaId: string; apiVersion: string } {
  if (!fs.existsSync(SCHEMA)) {
    return { schemaId: 'unknown', apiVersion: 'unknown' };
  }
  const schema = JSON.parse(fs.readFileSync(SCHEMA, 'utf8')) as {
    $id?: string;
  };
  const id = schema.$id ?? 'unknown';
  // .../catalog-app/v1beta1.json -> catalog-app.v1beta1
  const match = id.match(/\/([^/]+)\/([^/]+)\.json$/);
  const apiVersion = match ? `${match[1]}.${match[2]}` : 'unknown';
  return { schemaId: id, apiVersion };
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
    spec: specApiVersion(),
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2) + '\n');
  console.log(
    `kb-version-manifest: kbVersion ${cli} · platform ${RELEASE.version} · spec ${manifest.spec.apiVersion}`,
  );
}

main();
