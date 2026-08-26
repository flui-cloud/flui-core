import {
  FLUI_WEBHOOK_SECRET,
  WorkflowGeneratorService,
} from './workflow-generator.service';

/**
 * Both generators write a file into somebody else's repository, and V1 is still
 * routed (`POST /applications/:id/generate-workflow`) even though the wizard
 * only calls V3. A fix that covered one of the two would leave the same deploy
 * trigger readable through the other, so the assertions below run against both
 * bodies and are made on the rendered text, not on the arguments.
 */
describe('the webhook credential in the generated workflow', () => {
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const service = new WorkflowGeneratorService();

  const bodies = (): Array<[string, string]> => [
    [
      'V1',
      service.generateWorkflow({
        branchName: 'main',
        githubUsername: 'someone',
        repoName: 'their-app',
        fluiAppId: '3f6d1a2b-8c4e-4f7a-9b1d-2e5c7a9f0b31',
        fluiWebhookUrl:
          'https://api.example.test/api/v1/webhooks/github-actions',
        framework: 'nextjs',
      }),
    ],
    [
      'V3',
      service.generateWorkflowV3({
        branchName: 'main',
        githubOwner: 'someone',
        repoName: 'their-app',
        appSlug: 'their-app',
        fluiAppId: '3f6d1a2b-8c4e-4f7a-9b1d-2e5c7a9f0b31',
        fluiWebhookUrl:
          'https://api.example.test/api/v1/webhooks/github-actions',
      }),
    ],
  ];

  it.each(bodies())(
    '%s calls the webhook without carrying a credential',
    (_, body) => {
      expect(body).toContain('X-Flui-Token');
      expect(body).toContain(`X-Flui-Token: $${FLUI_WEBHOOK_SECRET}`);
      expect(body).toContain(
        `${FLUI_WEBHOOK_SECRET}: \${{ secrets.${FLUI_WEBHOOK_SECRET} }}`,
      );
    },
  );

  /**
   * The `fluiAppId` above is itself a UUID and is meant to be in the file — it
   * identifies the application, it does not authorise anything. So this checks
   * that the app id is the *only* UUID left.
   */
  it.each(bodies())(
    '%s holds no secret-shaped value beyond the app id',
    (_, body) => {
      const withoutAppId = body.replace(
        'FLUI_APP_ID: 3f6d1a2b-8c4e-4f7a-9b1d-2e5c7a9f0b31',
        '',
      );
      expect(withoutAppId).not.toMatch(UUID);
    },
  );

  it.each(bodies())(
    '%s refuses to post rather than post uncredentialed',
    (_, body) => {
      expect(body).toContain(`if [ -z "$${FLUI_WEBHOOK_SECRET}" ]; then`);
      expect(body).toContain('::error::');
      expect(body).toContain('exit 1');
      expect(body).not.toContain(`secrets.${FLUI_WEBHOOK_SECRET} ||`);
      expect(body).not.toContain(`|| secrets.${FLUI_WEBHOOK_SECRET}`);
    },
  );

  /**
   * The registry login keeps its fallback: `GITHUB_TOKEN` is a second
   * credential that actually works. There is no second webhook credential,
   * which is why the two lines look different on purpose.
   */
  it.each(bodies())('%s leaves the GHCR login fallback alone', (_, body) => {
    expect(body).toContain(
      'password: ${{ secrets.FLUI_GHCR_TOKEN || secrets.GITHUB_TOKEN }}',
    );
  });

  it('says nothing about a secret when the webhook call is not generated', () => {
    const body = service.generateWorkflowV3({
      branchName: 'main',
      githubOwner: 'someone',
      repoName: 'their-app',
      appSlug: 'their-app',
      fluiAppId: '3f6d1a2b-8c4e-4f7a-9b1d-2e5c7a9f0b31',
      fluiWebhookUrl: 'https://api.example.test/api/v1/webhooks/github-actions',
      backendPollingOnly: true,
    });
    expect(body).not.toContain('X-Flui-Token');
    expect(body).not.toContain(FLUI_WEBHOOK_SECRET);
  });
});
