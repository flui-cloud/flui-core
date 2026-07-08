import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Multi-zone clusters: the service/API layer already supports multiple DNS
 * zone assignments per cluster (longest-suffix FQDN matching), but the
 * initial schema carried a leftover UNIQUE("clusterId") from the original
 * one-zone-per-cluster design. Replace it with uniqueness on the
 * (clusterId, dnsZoneId) pair, matching the app-layer conflict check.
 * Idempotent.
 */
export class AllowMultipleDnsZonesPerCluster1782200000000
  implements MigrationInterface
{
  name = 'AllowMultipleDnsZonesPerCluster1782200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "cluster_dns_zones" DROP CONSTRAINT IF EXISTS "UQ_7e19228a4d5966348c4bdb9a3e9"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_cluster_dns_zones_cluster_zone" ON "cluster_dns_zones" ("clusterId", "dnsZoneId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_cluster_dns_zones_cluster_zone"`,
    );
    // Restoring the single-zone constraint would fail on clusters that now
    // hold multiple zones; the multi-zone service layer works either way.
  }
}
