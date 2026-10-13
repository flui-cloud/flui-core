import chalk from 'chalk';
import { ApiClient } from './api-client';

export type UserKind = 'person' | 'visitor';

export interface ListedUser {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  role: string;
  state?: string;
  isSystemUser: boolean;
  kind?: UserKind;
}

export function listUsers(
  api: ApiClient,
  options: { kind?: UserKind; email?: string; limit?: number } = {},
): Promise<ListedUser[]> {
  const query = new URLSearchParams();
  if (options.kind) query.set('kind', options.kind);
  if (options.email) query.set('emailContains', options.email);
  if (options.limit) query.set('limit', String(options.limit));
  const qs = query.toString();
  return api.get<ListedUser[]>(`/auth/users${qs ? `?${qs}` : ''}`);
}

export function userLine(user: ListedUser): string {
  const kind =
    user.kind === 'visitor' ? chalk.cyan('visitor') : chalk.dim('person');
  const off = /INACTIVE|LOCKED/i.test(user.state ?? '');
  const state = off ? chalk.yellow('blocked') : '';
  return `   ${user.email.padEnd(40)} ${kind.padEnd(18)} ${user.role.padEnd(9)} ${chalk.dim(user.id)} ${state}`.trimEnd();
}
