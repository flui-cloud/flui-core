import { InfrastructureOperationEntity } from './infrastructure-operations.entity';
import {
  runAsActor,
  runWithActorContext,
  setCurrentActor,
} from '../../../auth/utils/actor-context';

const KEY_ID = '11111111-2222-3333-4444-555555555555';

/**
 * The hook, not the 122 call sites.
 *
 * An operation row is built in 24 files; what is pinned here is that the stamp
 * happens on the row itself, so a call site added tomorrow inherits it without
 * anybody remembering to pass an argument.
 */
describe('operation rows and who started them', () => {
  it('stamps the actor of the request it was created in', () => {
    const op = new InfrastructureOperationEntity();
    runAsActor({ kind: 'agent', keyId: KEY_ID }, () => op.stampActor());
    expect(op.actorKind).toBe('agent');
    expect(op.actorKeyId).toBe(KEY_ID);
  });

  it('records a session as a person with no key behind it', () => {
    const op = new InfrastructureOperationEntity();
    runAsActor({ kind: 'user' }, () => op.stampActor());
    expect(op.actorKind).toBe('user');
    expect(op.actorKeyId).toBeNull();
  });

  it('leaves the columns untouched outside a request', () => {
    // A queue worker acts for nobody in particular. Null is the honest answer;
    // inheriting whichever request enqueued the job would not be.
    const op = new InfrastructureOperationEntity();
    op.stampActor();
    expect(op.actorKind).toBeUndefined();
    expect(op.actorKeyId).toBeUndefined();
  });

  it('never overwrites an actor the caller set itself', () => {
    const op = new InfrastructureOperationEntity();
    op.actorKind = 'user';
    runAsActor({ kind: 'agent', keyId: KEY_ID }, () => op.stampActor());
    expect(op.actorKind).toBe('user');
  });

  it('takes the actor the guard fills in after the context was opened', () => {
    // The store is created empty by the middleware and filled by the guard,
    // which runs later: the actor is simply not known when the context opens.
    const op = new InfrastructureOperationEntity();
    runWithActorContext(() => {
      setCurrentActor({ kind: 'key', keyId: KEY_ID });
      op.stampActor();
    });
    expect(op.actorKind).toBe('key');
    expect(op.actorKeyId).toBe(KEY_ID);
  });

  it('keeps one request out of another', async () => {
    const first = new InfrastructureOperationEntity();
    const second = new InfrastructureOperationEntity();
    await Promise.all([
      runAsActor({ kind: 'agent', keyId: KEY_ID }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        first.stampActor();
      }),
      runAsActor({ kind: 'user' }, async () => {
        second.stampActor();
      }),
    ]);
    expect(first.actorKind).toBe('agent');
    expect(second.actorKind).toBe('user');
  });

  it('ignores an actor set outside any request context', () => {
    // `setCurrentActor` is a no-op with no store open, so a background path can
    // call it blindly without leaking an actor into whatever runs next.
    setCurrentActor({ kind: 'agent' });
    const op = new InfrastructureOperationEntity();
    op.stampActor();
    expect(op.actorKind).toBeUndefined();
  });
});
