import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `inference_connections.owner_user_id` — the column the two levels of decision
 * 104 stand on.
 *
 * Until now the table had eight columns and no owner, so "this connection is
 * mine and nobody else's" had nowhere to be written and the privacy the model
 * describes was not expressible: not a question of where to put the guard, but
 * of the guard having no question to ask.
 *
 * Additive and nullable, and the nullability carries the meaning rather than
 * standing for "unknown": NULL is *the installation's* — visible to everyone,
 * spendable by everyone, managed by `integration:manage`. Every row written
 * before this migration is exactly that already, so there is nothing to
 * backfill and no row changes meaning when the column lands.
 *
 * No foreign key to `users`: decision 92(b) measured what one costs on a live
 * schema, and the behaviour wanted when a person leaves is that her connection
 * goes with her — a cascade delete decided in the application, not a SET NULL
 * that would silently promote her private key to the whole installation's.
 */
export class InferenceConnectionOwner1785700000000
  implements MigrationInterface
{
  name = 'InferenceConnectionOwner1785700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "inference_connections" ADD COLUMN IF NOT EXISTS "owner_user_id" uuid`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "inference_connections" DROP COLUMN IF EXISTS "owner_user_id"`,
    );
  }
}
