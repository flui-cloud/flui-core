jest.mock('@kubernetes/client-node', () => ({}));

import {
  ConflictException,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
import { hashSecret } from './visitor-link.service';
import {
  ENV,
  NOW,
  VISITOR,
  build,
  later,
  throughProvider,
} from './visitor-upgrade.harness-spec';

describe('VisitorUpgradeService', () => {
  const saved = { ...process.env };
  beforeEach(() => Object.assign(process.env, ENV));
  afterAll(() => {
    process.env = saved;
  });

  describe('start', () => {
    it('binds the provider’s intent to the visitor and answers the address to sign in at', async () => {
      const h = build();

      const out = await h.service.start('v1', 'github', '/apps', NOW);

      expect(out.authUrl).toContain('github.com');
      expect(h.provider.startIntent).toHaveBeenCalledWith(
        'service-pat',
        'auth.demo.example.com',
        {
          idpId: 'idp-gh',
          successUrl:
            'https://api.example.com/api/v1/sandbox/visitor/upgrade/callback?result=success',
          failureUrl:
            'https://api.example.com/api/v1/sandbox/visitor/upgrade/callback?result=failure',
        },
      );
      expect(h.rows[0]).toEqual(
        expect.objectContaining({
          visitorUserId: 'v1',
          method: 'idp',
          intentId: 'intent-1',
          returnTo: '/apps',
          expiresAt: later(10 * 60_000),
        }),
      );
    });

    it('refuses a sign-in that is not connected', async () => {
      const h = build();

      await expect(
        h.service.start('v1', 'google', null, NOW),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(h.provider.startIntent).not.toHaveBeenCalled();
    });

    it('refuses anybody who is not a visitor', async () => {
      const h = build({ users: [{ ...VISITOR, kind: 'person' }] });

      await expect(
        h.service.start('v1', 'github', null, NOW),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('lists only connected sign-ins, without their ids', async () => {
      const h = build();

      expect(await h.service.providers()).toEqual({
        providers: [{ provider: 'github', name: 'GitHub' }],
        email: true,
      });
    });
  });

  describe('callback', () => {
    it('sends the browser back with a single-use handle, kept only as a hash', async () => {
      const h = build();
      const flow = await throughProvider(h);

      expect(flow.length).toBeGreaterThanOrEqual(40);
      expect(h.rows[0].secretHash).toBe(hashSecret(flow));
      expect(h.rows[0].intentTokenEncrypted).toBe('enc(tok)');
    });

    it('lands on the dashboard path the visitor left', async () => {
      const h = build();
      await h.service.start('v1', 'github', '/apps', NOW);

      const target = await h.service.callback(
        { result: 'success', id: 'intent-1', token: 'tok' },
        NOW,
      );

      expect(target).toMatch(
        /^https:\/\/try\.example\.com\/apps\?visitor=finish&flow=/,
      );
    });

    it('answers a second callback for the same intent with a failure', async () => {
      const h = build();
      await throughProvider(h);

      expect(
        await h.service.callback(
          { result: 'success', id: 'intent-1', token: 'tok' },
          NOW,
        ),
      ).toBe('https://try.example.com/apps?visitor=upgrade-failed');
    });

    it('answers a cancelled, unknown or expired sign-in with a failure', async () => {
      const h = build();
      await h.service.start('v1', 'github', null, NOW);

      const failed = 'https://try.example.com/?visitor=upgrade-failed';
      expect(
        await h.service.callback({
          result: 'failure',
          id: 'intent-1',
          token: undefined,
        }),
      ).toBe(failed);
      expect(
        await h.service.callback({ result: 'success', id: 'nope', token: 't' }),
      ).toBe(failed);
      expect(
        await h.service.callback(
          { result: 'success', id: 'intent-1', token: 't' },
          later(11 * 60_000),
        ),
      ).toBe(failed);
    });
  });

  describe('finish', () => {
    it('links an identity nobody has to the visitor and makes it an account on the same user', async () => {
      const h = build();
      const flow = await throughProvider(h);

      const out = await h.service.finish('v1', flow, later(2000));

      expect(out).toEqual({
        outcome: 'upgraded',
        reason: null,
        returnTo: '/apps',
        linkNonce: null,
      });
      expect(h.provider.retrieveIntent).toHaveBeenCalledWith(
        'service-pat',
        'auth.demo.example.com',
        'intent-1',
        'tok',
      );
      expect(h.provider.addIdpLink).toHaveBeenCalledWith(
        'service-pat',
        'auth.demo.example.com',
        'idp-v1',
        expect.objectContaining({ externalUserId: 'gh-42' }),
      );
      expect(h.merge.flip).toHaveBeenCalledWith(
        'v1',
        {
          email: 'mario@example.com',
          firstName: 'Mario',
          lastName: 'Rossi',
          displayName: 'Mario Rossi',
        },
        'github',
        later(2000),
      );
      expect(h.provider.setEmail).toHaveBeenCalledWith(
        'service-pat',
        'auth.demo.example.com',
        'idp-v1',
        'mario@example.com',
        true,
      );
      expect(h.provider.clearVisitorMark).toHaveBeenCalled();
      expect(h.merge.fold).not.toHaveBeenCalled();
    });

    it('keeps the placeholder locally when GitHub did not prove the address', async () => {
      const h = build({ info: { emailVerified: false } });
      const flow = await throughProvider(h);

      await h.service.finish('v1', flow, later(2000));

      expect(h.merge.flip).toHaveBeenCalledWith(
        'v1',
        expect.objectContaining({ email: null }),
        'github',
        expect.any(Date),
      );
      expect(h.provider.setEmail).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'idp-v1',
        'mario@example.com',
        false,
      );
    });

    it('folds the visitor into the account the identity already belongs to', async () => {
      const account = {
        id: 'r1',
        kind: 'person',
        oidcSub: 'idp-r1',
        email: 'r@x',
      };
      const h = build({
        users: [VISITOR, account],
        info: { linkedUserId: 'idp-r1' },
      });
      const flow = await throughProvider(h);

      const out = await h.service.finish('v1', flow, later(2000));

      expect(out.outcome).toBe('signin-as-existing');
      expect(out.linkNonce).toBeNull();
      expect(h.merge.fold).toHaveBeenCalledWith(
        'v1',
        account,
        'github',
        later(2000),
      );
      expect(h.provider.addIdpLink).not.toHaveBeenCalled();
      expect(h.merge.flip).not.toHaveBeenCalled();
    });

    it('asks an account Flui has not met yet to sign in and take the visit by link', async () => {
      const h = build({ info: { linkedUserId: 'idp-unknown' } });
      const flow = await throughProvider(h);

      const out = await h.service.finish('v1', flow, later(2000));

      expect(out).toEqual(
        expect.objectContaining({
          outcome: 'signin-as-existing',
          linkNonce: 'link-nonce',
        }),
      );
      expect(h.merge.fold).not.toHaveBeenCalled();
    });

    it('never takes over an address another account holds: that account signs in instead', async () => {
      const h = build({
        users: [
          VISITOR,
          { id: 'r2', kind: 'person', email: 'mario@example.com' },
        ],
      });
      const flow = await throughProvider(h);

      const out = await h.service.finish('v1', flow, later(2000));

      expect(out.outcome).toBe('signin-as-existing');
      expect(out.linkNonce).toBe('link-nonce');
      expect(h.provider.addIdpLink).not.toHaveBeenCalled();
      expect(h.merge.flip).not.toHaveBeenCalled();
    });

    it('refuses the link of a blocked visitor', async () => {
      const h = build({ users: [{ ...VISITOR, blockedAt: NOW }] });
      await h.service.start('v1', 'github', null, NOW).catch(() => undefined);
      h.rows.push({
        id: 'manual',
        visitorUserId: 'v1',
        method: 'idp',
        idpId: 'idp-gh',
        intentId: 'intent-x',
        intentTokenEncrypted: 'enc(tok)',
        secretHash: hashSecret('f'.repeat(43)),
        returnTo: null,
        expiresAt: later(600_000),
        claimedAt: null,
        outcome: null,
      });

      const out = await h.service.finish('v1', 'f'.repeat(43), NOW);

      expect(out).toEqual(
        expect.objectContaining({ outcome: 'refused', reason: 'blocked' }),
      );
      expect(h.provider.retrieveIntent).not.toHaveBeenCalled();
      expect(h.provider.addIdpLink).not.toHaveBeenCalled();
    });

    it('removes the link again when the account could not be made', async () => {
      const h = build();
      h.merge.flip.mockRejectedValueOnce(new Error('db down'));
      const flow = await throughProvider(h);

      const out = await h.service.finish('v1', flow, later(2000));

      expect(out).toEqual(
        expect.objectContaining({ outcome: 'refused', reason: 'failed' }),
      );
      expect(h.provider.removeIdpLink).toHaveBeenCalledWith(
        'service-pat',
        'auth.demo.example.com',
        'idp-v1',
        expect.objectContaining({ externalUserId: 'gh-42' }),
      );
      expect(h.rows[0].claimedAt).toBeNull();
      expect(h.rows[0].outcome).toBeNull();
    });

    it('refuses a handle of another visitor as unknown', async () => {
      const h = build();
      const flow = await throughProvider(h);

      await expect(
        h.service.finish('v2', flow, later(2000)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses an expired handle', async () => {
      const h = build();
      const flow = await throughProvider(h);

      await expect(
        h.service.finish('v1', flow, later(11 * 60_000)),
      ).rejects.toBeInstanceOf(GoneException);
    });

    it('answers a reused handle with the outcome it already had, doing nothing twice', async () => {
      const h = build();
      const flow = await throughProvider(h);
      await h.service.finish('v1', flow, later(2000));

      const again = await h.service.finish('v1', flow, later(3000));

      expect(again.outcome).toBe('upgraded');
      expect(h.provider.addIdpLink).toHaveBeenCalledTimes(1);
      expect(h.merge.flip).toHaveBeenCalledTimes(1);
    });

    it('gives a visitor still waiting for its account a fresh link when the answer is asked again', async () => {
      const h = build({ info: { linkedUserId: 'idp-unknown' } });
      const flow = await throughProvider(h);
      await h.service.finish('v1', flow, later(2000));
      h.links.createIntent.mockResolvedValueOnce({
        nonce: 'fresh-nonce',
        expiresAt: later(900_000),
      });

      const again = await h.service.finish('v1', flow, later(3000));

      expect(again).toEqual(
        expect.objectContaining({
          outcome: 'signin-as-existing',
          linkNonce: 'fresh-nonce',
        }),
      );
      expect(h.links.createIntent).toHaveBeenCalledTimes(2);
      expect(h.provider.retrieveIntent).toHaveBeenCalledTimes(1);
    });

    it('gives no link again once the visit already went into the account', async () => {
      const users: Array<Record<string, unknown>> = [
        VISITOR,
        { id: 'r1', kind: 'person', oidcSub: 'idp-r', email: 'r@x.test' },
      ];
      const h = build({ users, info: { linkedUserId: 'idp-r' } });
      const flow = await throughProvider(h);
      const first = await h.service.finish('v1', flow, later(2000));
      users.splice(0, 1);

      const again = await h.service.finish('v1', flow, later(3000));

      expect(first.outcome).toBe('signin-as-existing');
      expect(again).toEqual(
        expect.objectContaining({
          outcome: 'signin-as-existing',
          linkNonce: null,
        }),
      );
      expect(h.links.createIntent).not.toHaveBeenCalled();
    });

    it('refuses an identity from a provider other than the one started', async () => {
      const h = build({ info: { idpId: 'idp-other' } });
      const flow = await throughProvider(h);

      const out = await h.service.finish('v1', flow, later(2000));

      expect(out).toEqual(
        expect.objectContaining({ outcome: 'refused', reason: 'failed' }),
      );
      expect(h.provider.addIdpLink).not.toHaveBeenCalled();
    });
  });
});
