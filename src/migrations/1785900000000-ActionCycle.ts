import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The action cycle: two new tables, and two nullable columns that join them to
 * what an agent actually started.
 *
 * `action_proposals` is the wait made a row — an agent's attempt, held as state
 * rather than as an open connection, so the same key on `curl` gets the same
 * answer as the same key on MCP. `agent_concessions` is "allow always" made
 * revocable: a route shape, the resource it is pinned to, and the sentence the
 * person read at the moment of the yes, stored verbatim.
 *
 * Neither table names a permission, and that is on purpose: `iam_role_bindings`
 * is the ceiling, and a consent that wrote there could raise the ceiling it
 * hangs from. A concession only ever removes a pause on a route the guards have
 * already let through.
 *
 * The two columns on `infrastructure_operations` follow the procedure the last
 * three rounds established rather than the convenience of the moment: additive,
 * nullable, no foreign key, no type changed on an existing column, and the
 * entity edited in the same pass as the migration — because
 * `RdbmsSchemaBuilder.dropRemovedColumns` deletes any column the database has
 * and the entity does not. `grantId` is the join the revoke dialog needs;
 * `cancelRequestedAt` is a *request* to stop, honoured at a step boundary,
 * never an abort — `CANCELLED` has been in the enum since the initial schema
 * with nothing in the module ever writing it.
 */
export class ActionCycle1785900000000 implements MigrationInterface {
  name = 'ActionCycle1785900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "action_proposals" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "ownerUserId" character varying NOT NULL,
        "keyId" character varying,
        "action" character varying NOT NULL,
        "routePath" character varying,
        "binding" jsonb,
        "argsDigest" character varying NOT NULL,
        "sentence" text NOT NULL,
        "offersAlways" boolean NOT NULL DEFAULT false,
        "estimateRef" character varying,
        "estimate" jsonb,
        "status" character varying NOT NULL DEFAULT 'PENDING',
        "expiresAt" TIMESTAMP WITH TIME ZONE,
        "decidedAt" TIMESTAMP WITH TIME ZONE,
        "decidedByUserId" character varying,
        "concessionId" character varying,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_action_proposals" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_action_proposals_owner_status" ON "action_proposals" ("ownerUserId", "status")`,
    );
    // The upsert key of an attempt: same person, same shape, same arguments is
    // the same question, and an agent that retries must not fill an inbox.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_action_proposals_digest" ON "action_proposals" ("ownerUserId", "action", "argsDigest")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "agent_concessions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "keyId" character varying,
        "ownerUserId" character varying NOT NULL,
        "action" character varying NOT NULL,
        "binding" jsonb,
        "sentence" text NOT NULL,
        "fromProposalId" character varying,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "lastUsedAt" TIMESTAMP WITH TIME ZONE,
        "revokedAt" TIMESTAMP WITH TIME ZONE,
        "revokedByUserId" character varying,
        CONSTRAINT "PK_agent_concessions" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_agent_concessions_owner_revoked" ON "agent_concessions" ("ownerUserId", "revokedAt")`,
    );
    // What the guard asks on every agent request, so it stays one index hit.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_agent_concessions_lookup" ON "agent_concessions" ("ownerUserId", "keyId", "action")`,
    );

    await queryRunner.query(
      `ALTER TABLE "infrastructure_operations" ADD COLUMN IF NOT EXISTS "grantId" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "infrastructure_operations" ADD COLUMN IF NOT EXISTS "cancelRequestedAt" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "infrastructure_operations" DROP COLUMN IF EXISTS "cancelRequestedAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "infrastructure_operations" DROP COLUMN IF EXISTS "grantId"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_agent_concessions_lookup"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_agent_concessions_owner_revoked"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "agent_concessions"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_action_proposals_digest"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_action_proposals_owner_status"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "action_proposals"`);
  }
}
