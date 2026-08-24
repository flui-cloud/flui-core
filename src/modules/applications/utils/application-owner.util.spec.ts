import { ownerUserIdFor } from './application-owner.util';
import { SERVICE_IDENTITY } from '../../auth/constants/service-identities';

/**
 * The two dangling owners found on the live instance were not both deleted
 * people: one was `service-account`, the install credential's principal. A
 * foreign key to `users` refuses that value outright, so the write path has to
 * stop offering it before the key exists — otherwise `flui app create` with the
 * credential `flui env create` installs stops working.
 */
describe('ownerUserIdFor', () => {
  it('keeps a real user id', () => {
    const id = '6de6dc6c-0b50-45fa-9130-8cc99fcb716e';
    expect(ownerUserIdFor(id)).toBe(id);
  });

  it('records no owner for every declared service identity', () => {
    const principals = [
      ...Object.values(SERVICE_IDENTITY).map((d) => d.id),
      ...Object.values(SERVICE_IDENTITY).flatMap((d) => d.legacyUserIds),
    ];
    expect(principals.length).toBeGreaterThan(0);
    expect(principals.map((p) => ownerUserIdFor(p))).toEqual(
      principals.map(() => null),
    );
  });

  it('records no owner when there is no principal at all', () => {
    expect(ownerUserIdFor(undefined)).toBeNull();
    expect(ownerUserIdFor(null)).toBeNull();
    expect(ownerUserIdFor('')).toBeNull();
  });
});
