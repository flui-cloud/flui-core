import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ActionBinding, subjectTableOf } from './action-cycle.core';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Puts a name where a request would otherwise show an id.
 *
 * A person deciding whether to remove "application 9f68e8cd-…" has to go and
 * look up which one that is; "application flui-managed" they can answer. The
 * name is read once, when the request is raised, and frozen into its sentence.
 */
@Injectable()
export class ActionSubjectNames {
  constructor(private readonly db: DataSource) {}

  async label(
    action: string,
    binding: ActionBinding | undefined,
  ): Promise<ActionBinding | undefined> {
    const table = subjectTableOf(action);
    const id = binding?.id;
    if (!table || !id || !UUID.test(id)) return binding;
    try {
      const rows: { name?: string }[] = await this.db.query(
        `SELECT name FROM "${table}" WHERE id = $1 LIMIT 1`,
        [id],
      );
      const name = rows[0]?.name?.trim();
      return name ? { ...binding, id: name } : binding;
    } catch {
      return binding;
    }
  }
}
