import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `editor` → `operator`, `manager` → `maintainer`, wherever a row still says so.
 *
 * On the instance this was written against it renames nothing: the live bindings
 * are four `sandbox`, four `showcase_viewer` and one `owner`, and no stored
 * gateway route names a minimum role at all. That is the reason it exists rather
 * than a reason to skip it — the count is a fact about *one* database, and the
 * only thing standing between a different one and a silent loss of access is
 * this file. A binding whose role no longer appears in `BUILTIN_ROLES` resolves
 * to zero permissions: not an error anywhere, just a person who can suddenly do
 * nothing.
 *
 * Two places store a role name, and both are covered:
 *   - `iam_role_bindings.role`, the grants themselves;
 *   - `app_endpoints.gatewayConfig->auth->>minRole`, the SSO gate on a published
 *     route. Its enum is the same ladder, and an unmapped value there denies
 *     rather than defaults — a route that answered 200 yesterday would answer
 *     403 today with nothing in the logs to say why.
 *
 * Reversible in the strict sense: `down` renames them back, because the names
 * are the only thing that changed. It does not try to restore the permission
 * *sets* those roles used to carry — the definitions live in code, and a
 * migration that pretended otherwise would be describing a rollback it cannot
 * perform.
 */
export class RenameEditorAndManagerRoles1785500000000
  implements MigrationInterface
{
  name = 'RenameEditorAndManagerRoles1785500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.renameBindings(queryRunner, 'editor', 'operator');
    await this.renameBindings(queryRunner, 'manager', 'maintainer');
    await this.renameMinRole(queryRunner, 'editor', 'operator');
    await this.renameMinRole(queryRunner, 'manager', 'maintainer');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.renameBindings(queryRunner, 'operator', 'editor');
    await this.renameBindings(queryRunner, 'maintainer', 'manager');
    await this.renameMinRole(queryRunner, 'operator', 'editor');
    await this.renameMinRole(queryRunner, 'maintainer', 'manager');
  }

  private async renameBindings(
    queryRunner: QueryRunner,
    from: string,
    to: string,
  ): Promise<void> {
    await queryRunner.query(
      `UPDATE "iam_role_bindings" SET "role" = $1 WHERE "role" = $2`,
      [to, from],
    );
  }

  /**
   * Rewrites one leaf of a jsonb column, leaving the rest of the object alone —
   * `jsonb_set` rather than a rebuilt document, so a gateway config carrying
   * rate limits and IP rules keeps them.
   */
  private async renameMinRole(
    queryRunner: QueryRunner,
    from: string,
    to: string,
  ): Promise<void> {
    await queryRunner.query(
      `UPDATE "app_endpoints"
         SET "gatewayConfig" = jsonb_set(
           "gatewayConfig", '{auth,minRole}', to_jsonb($1::text), false
         )
       WHERE "gatewayConfig" -> 'auth' ->> 'minRole' = $2`,
      [to, from],
    );
  }
}
