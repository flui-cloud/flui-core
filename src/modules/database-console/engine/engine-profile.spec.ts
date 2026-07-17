import {
  DB_ENGINE_LABEL,
  declaredEngineOf,
  detectEngineFromImage,
  imageNameOf,
} from './engine-profile';

describe('imageNameOf', () => {
  it.each([
    ['docker.io/library/postgres:15-alpine', 'postgres'],
    ['ghcr.io/umami-software/umami:postgresql-v2.20.2', 'umami'],
    ['postgres', 'postgres'],
    ['postgres:15', 'postgres'],
    ['localhost:5000/myapp:dev', 'myapp'],
    ['registry:5000/team/api', 'api'],
    ['docker.io/library/postgres@sha256:abc123', 'postgres'],
  ])('%s -> %s', (ref, expected) => {
    expect(imageNameOf(ref)).toBe(expected);
  });

  it('tolerates empty input', () => {
    expect(imageNameOf(undefined)).toBe('');
    expect(imageNameOf(null)).toBe('');
  });
});

describe('declaredEngineOf', () => {
  it('takes the engine the manifest declared', () => {
    expect(declaredEngineOf({ [DB_ENGINE_LABEL]: 'valkey' })).toBe('valkey');
  });

  it('wins over an image that says otherwise (immich runs valkey under a "redis" name)', () => {
    const labels = { [DB_ENGINE_LABEL]: 'valkey' };
    expect(
      declaredEngineOf(labels) ?? detectEngineFromImage('valkey/valkey:9'),
    ).toBe('valkey');
  });

  it('ignores an engine with no console profile, leaving it to its own console', () => {
    expect(declaredEngineOf({ [DB_ENGINE_LABEL]: 'kafka' })).toBeNull();
    expect(declaredEngineOf({ [DB_ENGINE_LABEL]: 'meilisearch' })).toBeNull();
  });

  it('ignores junk and inherited object keys', () => {
    expect(declaredEngineOf({ [DB_ENGINE_LABEL]: 'postgress' })).toBeNull();
    expect(declaredEngineOf({ [DB_ENGINE_LABEL]: 'toString' })).toBeNull();
    expect(declaredEngineOf({})).toBeNull();
    expect(declaredEngineOf(undefined)).toBeNull();
  });
});

describe('detectEngineFromImage (legacy fallback)', () => {
  // Every database image the catalog actually ships — these installs predate the label,
  // so the fallback must keep classifying them.
  it.each([
    ['docker.io/library/postgres:15-alpine', 'postgres'],
    ['ghcr.io/immich-app/postgres:14-vectorchord', 'postgres'],
    ['ghcr.io/flui-cloud/flui-postgres:17-dev', 'postgres'],
    ['docker.io/bitnami/postgresql:16', 'postgres'],
    ['pgvector/pgvector:pg16', 'postgres'],
    ['ghcr.io/ferretdb/postgres-documentdb:17', 'postgres'],
    ['docker.io/library/mariadb:11', 'mariadb'],
    ['docker.io/library/mysql:8', 'mariadb'],
    ['docker.io/valkey/valkey:9', 'valkey'],
    ['docker.io/library/redis:7-alpine', 'redis'],
    ['ghcr.io/ferretdb/ferretdb:1.24', 'ferretdb'],
  ])('classifies %s as %s', (ref, expected) => {
    expect(detectEngineFromImage(ref)).toBe(expected);
  });

  // The bug: umami's Postgres-flavoured build tag made its web component read as a database.
  it.each([
    ['ghcr.io/umami-software/umami:postgresql-v2.20.2'],
    ['ghcr.io/some-org/app:mysql-8-compat'],
    ['docker.io/acme/backup-tool:redis-dump'],
  ])('does not let the tag of %s make it a database', (ref) => {
    expect(detectEngineFromImage(ref)).toBeNull();
  });

  // Companions that live right next to a database and are not one.
  it.each([
    ['rediscommander/redis-commander:latest'],
    ['postgrest/postgrest:v12'],
    ['quay.io/prometheuscommunity/postgres-exporter:v0.15'],
    ['dpage/pgadmin4:8'],
    ['ghcr.io/redis-labs/some-dashboard:1.0'],
  ])('does not classify the companion %s as a database', (ref) => {
    expect(detectEngineFromImage(ref)).toBeNull();
  });

  it('returns null for a plain web image and for no image', () => {
    expect(
      detectEngineFromImage('ghcr.io/umami-software/umami:v2.20.2'),
    ).toBeNull();
    expect(detectEngineFromImage(undefined)).toBeNull();
  });
});
