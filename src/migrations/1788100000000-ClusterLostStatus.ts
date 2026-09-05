import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A cluster that was lost is not a cluster that was deleted.
 *
 * Destroying one is a choice, and `DELETED` records it. Losing one is an event:
 * the machines stop answering, nobody decided anything, and the applications
 * that ran there still have rows, endpoints, policies and backups. Without a
 * state of its own such a cluster stays `READY` — a valid deploy target that
 * cannot be deployed to — or gets marked `DELETED`, which claims a decision
 * nobody made.
 *
 * Same shape as the other enum additions: Postgres cannot add a value inside a
 * transaction that then uses it, hence IF NOT EXISTS and no use here.
 */
export class ClusterLostStatus1788100000000 implements MigrationInterface {
  name = 'ClusterLostStatus1788100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."infrastructure_clusters_status_enum" ADD VALUE IF NOT EXISTS 'lost'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres cannot drop an enum value, and a cluster marked lost while it
    // existed would be unreadable if it could.
  }
}
