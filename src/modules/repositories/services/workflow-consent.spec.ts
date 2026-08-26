import {
  buildWorkflowConsent,
  describeDelivery,
  resolveWorkflowDelivery,
} from './workflow-consent';

/**
 * Two promises are pinned here. A guest never writes to somebody's branch, and
 * the consent record names every place the commit touches — a screen that lists
 * two of three writes is worse than one that lists none, because it reads as
 * complete.
 */
describe('workflow consent', () => {
  describe('where the commit lands', () => {
    it('pushes for an owner who asked for nothing in particular', () => {
      expect(resolveWorkflowDelivery({ isSandboxGuest: false })).toBe('push');
    });

    it('honours an owner who asked to be proposed to', () => {
      expect(
        resolveWorkflowDelivery({
          requested: 'pull-request',
          isSandboxGuest: false,
        }),
      ).toBe('pull-request');
    });

    it('proposes to a guest', () => {
      expect(resolveWorkflowDelivery({ isSandboxGuest: true })).toBe(
        'pull-request',
      );
    });

    it('refuses a guest who asks to push, because the client is not the repository owner', () => {
      expect(
        resolveWorkflowDelivery({ requested: 'push', isSandboxGuest: true }),
      ).toBe('pull-request');
    });
  });

  describe('what it says out loud', () => {
    it('says a pull request changes nothing until merged', () => {
      const said = describeDelivery('pull-request', 'main');
      expect(said).toContain('main');
      expect(said).toContain('until you merge');
    });

    it('says a push is itself what starts the build', () => {
      expect(describeDelivery('push', 'trunk')).toContain(
        'starts the first build',
      );
    });
  });

  describe('the record', () => {
    const base = {
      owner: 'someone',
      repo: 'their-app',
      branch: 'main',
      delivery: 'pull-request' as const,
      workflowPath: '.github/workflows/flui-their-app.yml',
      workflowYaml: 'name: Flui Deploy\n',
      webhookSecretName: 'FLUI_WEBHOOK_TOKEN' as string | null,
      writesGhcrSecret: true,
      ghcrSecretName: 'FLUI_GHCR_TOKEN',
    };

    it('names the workflow file and both repository secrets, not just the file', () => {
      const consent = buildWorkflowConsent(base);
      const targets = consent.writes.map((w) => w.target);
      expect(targets).toContain('.github/workflows/flui-their-app.yml');
      expect(targets).toContain('Repository secret FLUI_WEBHOOK_TOKEN');
      expect(targets).toContain('Repository secret FLUI_GHCR_TOKEN');
    });

    it('names a deletion when the commit contains one', () => {
      const consent = buildWorkflowConsent({
        ...base,
        removesPath: '.github/workflows/flui.yml',
      });
      expect(consent.writes.map((w) => w.target)).toContain(
        '.github/workflows/flui.yml',
      );
    });

    it('does not invent a secret write when there is none', () => {
      const consent = buildWorkflowConsent({
        ...base,
        webhookSecretName: null,
        writesGhcrSecret: false,
      });
      expect(consent.writes).toHaveLength(1);
    });

    it('carries the workflow body verbatim, never a summary of it', () => {
      const body = 'name: Flui Deploy\non:\n  push:\n    branches: [main]\n';
      expect(
        buildWorkflowConsent({ ...base, workflowYaml: body }).workflowYaml,
      ).toBe(body);
    });

    it('names the webhook secret only when the body actually reads one', () => {
      expect(buildWorkflowConsent(base).webhookSecretName).toBe(
        'FLUI_WEBHOOK_TOKEN',
      );
      expect(
        buildWorkflowConsent({ ...base, webhookSecretName: null })
          .webhookSecretName,
      ).toBeNull();
    });

    /**
     * A repository secret is an improvement on text in a committed file, and
     * it is not privacy. The sentence shown to the person consenting has to
     * carry both halves — the one that reassures and the one that does not.
     */
    it('says the file is clean and the secret is still reachable, both', () => {
      const note = buildWorkflowConsent(base).webhookSecretNote!;
      expect(note).toContain('FLUI_WEBHOOK_TOKEN');
      expect(note).toContain('contains no credentials');
      expect(note).toContain('write access');
      expect(
        buildWorkflowConsent({ ...base, webhookSecretName: null })
          .webhookSecretNote,
      ).toBeNull();
    });

    it('states the two facts the plan says to say out loud', () => {
      const consent = buildWorkflowConsent(base);
      expect(consent.usesYourActionsMinutes).toBe(true);
      expect(consent.builtOnFluiMachines).toBe(false);
    });
  });
});
