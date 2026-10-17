import { WorkflowGeneratorService } from './workflow-generator.service';

describe('the image platform of the generated workflow', () => {
  const service = new WorkflowGeneratorService();
  const common = {
    branchName: 'main',
    repoName: 'their-app',
    fluiAppId: '3f6d1a2b-8c4e-4f7a-9b1d-2e5c7a9f0b31',
    fluiWebhookUrl: 'https://api.example.test/api/v1/webhooks/github-actions',
  };

  it.each([
    [
      'V1',
      service.generateWorkflow({
        ...common,
        githubUsername: 'someone',
        framework: 'nextjs',
      }),
    ],
    [
      'V3',
      service.generateWorkflowV3({
        ...common,
        githubOwner: 'someone',
        appSlug: 'their-app',
      }),
    ],
  ])('%s builds for x86 servers only', (_name, body) => {
    expect(body.match(/platforms: linux\/amd64\n/g)).toHaveLength(1);
    expect(body).not.toContain('setup-qemu-action');
  });
});
