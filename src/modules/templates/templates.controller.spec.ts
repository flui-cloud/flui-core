// The controller's import graph reaches ESM-only packages (Octokit, via
// TemplatesService) that ts-jest cannot transform; stub them — this suite calls
// none of them, it exercises the controller against a stubbed service.
jest.mock('@octokit/rest', () => ({ Octokit: jest.fn() }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));

import { Request } from 'express';
import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';
import { TemplateConfig } from './config/template-registry';

const template = (over: Partial<TemplateConfig> = {}): TemplateConfig =>
  ({
    framework: 'nextjs',
    displayName: 'Next.js',
    description: 'React framework',
    version: '16',
    repo: 'flui-template-nextjs-16',
    repoUrl: 'https://github.com/flui-cloud/flui-template-nextjs-16',
    category: 'fullstack',
    language: 'typescript',
    port: 3000,
    healthcheckPath: '/',
    buildTool: 'next build',
    isDefault: true,
    isDeprecated: false,
    ...over,
  }) as TemplateConfig;

const controllerWith = (templates: TemplateConfig[]) =>
  new TemplatesController({
    listTemplates: () => templates,
  } as unknown as TemplatesService);

const asRequest = (user?: unknown): Request => ({ user }) as Request;

describe('TemplatesController.listTemplates', () => {
  const templates = [template(), template({ framework: 'astro', repo: 'x' })];

  // The endpoint is deliberately reachable without a token so "what can I deploy?"
  // can be answered before an account exists. The source repository is not part of
  // that answer — several template repos are private, and publishing their names
  // discloses the org's layout to anyone who asks.
  it('answers an anonymous caller with the catalogue', () => {
    const listed = controllerWith(templates).listTemplates(asRequest());
    expect(listed).toHaveLength(2);
    expect(listed[0].framework).toBe('nextjs');
    expect(listed[0].displayName).toBe('Next.js');
  });

  it('withholds the source repository from an anonymous caller', () => {
    const listed = controllerWith(templates).listTemplates(asRequest());
    for (const item of listed) {
      expect(item).not.toHaveProperty('repo');
      expect(item).not.toHaveProperty('repoUrl');
    }
    expect(JSON.stringify(listed)).not.toContain('github.com');
  });

  it('returns the full record to an authenticated caller', () => {
    const listed = controllerWith(templates).listTemplates(
      asRequest({ userId: 'u1' }),
    );
    expect(listed[0].repo).toBe('flui-template-nextjs-16');
    expect(listed[0].repoUrl).toContain('github.com');
  });
});
