import * as yaml from 'js-yaml';
import { WorkflowGeneratorService } from './workflow-generator.service';

/**
 * `deploy.build.args` used to have nowhere to go: the manifest accepted it,
 * nothing forwarded it to `docker/build-push-action`, so a `NEXT_PUBLIC_*`
 * build-time value had no way to reach the image short of hardcoding an `ARG`
 * default in the Dockerfile. This pins that the generated workflow actually
 * carries it, and that the block it emits is valid YAML.
 */
describe('generateWorkflowV3 — build.args forwarded as --build-arg', () => {
  const service = new WorkflowGeneratorService();

  const base = {
    branchName: 'main',
    githubOwner: 'someone',
    repoName: 'their-app',
    appSlug: 'their-app',
    fluiAppId: '3f6d1a2b-8c4e-4f7a-9b1d-2e5c7a9f0b31',
    fluiWebhookUrl: 'https://api.example.test/api/v1/webhooks/github-actions',
  };

  it('emits no build-args input when the manifest declares none', () => {
    const body = service.generateWorkflowV3(base);
    expect(body).not.toContain('build-args:');
  });

  it('renders every declared arg as KEY=value under build-args, valid YAML', () => {
    const body = service.generateWorkflowV3({
      ...base,
      buildArgs: {
        NEXT_PUBLIC_API_URL: 'https://api.example.com',
        NODE_ENV: 'production',
      },
    });
    expect(body).toContain(
      'build-args: |\n            NEXT_PUBLIC_API_URL=https://api.example.com\n            NODE_ENV=production',
    );

    const parsed = yaml.load(body) as {
      jobs: {
        'build-and-push': {
          steps: Array<{ with?: { 'build-args'?: string } }>;
        };
      };
    };
    const buildStep = parsed.jobs['build-and-push'].steps.find(
      (s) => s.with?.['build-args'],
    );
    expect(buildStep?.with?.['build-args']).toBe(
      'NEXT_PUBLIC_API_URL=https://api.example.com\nNODE_ENV=production\n',
    );
  });

  it('omits the input for an empty args object, same as undefined', () => {
    const body = service.generateWorkflowV3({ ...base, buildArgs: {} });
    expect(body).not.toContain('build-args:');
  });
});
