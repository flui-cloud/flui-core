import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stops a single DELETE from erasing what a rebuild is built from.
 *
 * Destroying a cluster through Flui marks its row `DELETED` and leaves it in
 * place, so the applications, endpoints and policies of a lost cluster survive
 * pointing at it — which is the only reason re-materialising them is possible
 * at all.
 *
 * But those three tables reference the cluster `ON DELETE CASCADE`. One hard
 * `DELETE FROM infrastructure_clusters` — a cleanup script, a future "purge
 * deleted clusters" feature, a hand at a psql prompt — takes every application,
 * endpoint and policy of that cluster with it, in one statement, silently. The
 * backups themselves would survive in object storage, and nothing would be left
 * that knows they exist or what they belonged to.
 *
 * `RESTRICT` makes that delete fail instead. The rows of a lost cluster have to
 * be un-deletable by accident: retiring a cluster for good is a deliberate act
 * that must move its applications somewhere first.
 *
 * Nodes, firewalls, certificates and DNS zones keep cascading: they describe
 * infrastructure that ceases to exist with the cluster, not records of what
 * ran on it.
 */
export class ProtectRecordsFromClusterDelete1787900000000
  implements MigrationInterface
{
  name = 'ProtectRecordsFromClusterDelete1787900000000';

  private readonly constraints: Array<[string, string]> = [
    ['applications', 'FK_30166ad87f87f4d9d8c294cd4ec'],
    ['app_endpoints', 'FK_5a83de5b9813a89a382b08cc551'],
    ['backup_policies', 'FK_6a683b4928e2d435d363f311f9c'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [table, name] of this.constraints) {
      await queryRunner.query(
        `ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${name}"`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD CONSTRAINT "${name}" FOREIGN KEY ("clusterId") ` +
          `REFERENCES "infrastructure_clusters"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const [table, name] of this.constraints) {
      await queryRunner.query(
        `ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${name}"`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD CONSTRAINT "${name}" FOREIGN KEY ("clusterId") ` +
          `REFERENCES "infrastructure_clusters"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
      );
    }
  }
}
