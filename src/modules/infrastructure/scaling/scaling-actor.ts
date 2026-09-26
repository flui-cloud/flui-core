import { actorFromRequest } from '../../auth/utils/actor.util';

/** Who asked, as the scaling log names them. */
export function byOf(
  req: { user?: { email?: string; displayName?: string } } & Record<
    string,
    unknown
  >,
): string {
  const actor = actorFromRequest(req as never);
  const person = req.user?.email ?? req.user?.displayName ?? 'a person';
  return actor.kind === 'agent' ? `an agent acting for ${person}` : person;
}
