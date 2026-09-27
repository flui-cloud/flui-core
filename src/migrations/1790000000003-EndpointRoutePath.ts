import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One host, several routes of the same project on different paths.
 *
 * The host alone was unique, so a second path on it was refused before it
 * reached any rule about projects. The pair (host, path) is unique instead;
 * the path is copied out of the gateway config, normalised the way the
 * gateway compiles it.
 */
export class EndpointRoutePath1790000000003 implements MigrationInterface {
  name = 'EndpointRoutePath1790000000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "app_endpoints" ADD COLUMN IF NOT EXISTS "routePath" character varying NOT NULL DEFAULT '/'`,
    );
    await queryRunner.query(`
      UPDATE "app_endpoints"
      SET "routePath" = COALESCE(
        NULLIF(
          regexp_replace(
            CASE WHEN left("gatewayConfig"->>'path', 1) = '/' THEN "gatewayConfig"->>'path'
                 ELSE '/' || ("gatewayConfig"->>'path') END,
            '/+$', ''),
          ''),
        '/')
      WHERE "gatewayConfig"->>'path' IS NOT NULL
    `);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_351642a9fa287899b7496d6449"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_app_endpoints_fqdn_route_path" ON "app_endpoints" ("fqdn", "routePath")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_app_endpoints_fqdn_route_path"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_351642a9fa287899b7496d6449" ON "app_endpoints" ("fqdn")`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_endpoints" DROP COLUMN "routePath"`,
    );
  }
}
