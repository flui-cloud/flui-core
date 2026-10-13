import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { GitHubAppManifestStartDto } from '../dto/github-oauth.dto';
import {
  GithubAppManifestStateService,
  githubAppCreationUrl,
} from './github-app-manifest-state.service';

describe('where GitHub creates the App', () => {
  it('is the confirming person’s own account when no organisation is named', () => {
    expect(githubAppCreationUrl()).toBe('https://github.com/settings/apps/new');
    expect(githubAppCreationUrl('  ')).toBe(
      'https://github.com/settings/apps/new',
    );
  });

  it('is the organisation’s New-App form when one is named', () => {
    expect(githubAppCreationUrl('acme')).toBe(
      'https://github.com/organizations/acme/settings/apps/new',
    );
    expect(githubAppCreationUrl(' Acme-Labs2 ')).toBe(
      'https://github.com/organizations/Acme-Labs2/settings/apps/new',
    );
  });

  it.each([
    ['a path', 'acme/../../settings'],
    ['a query', 'acme?x=1'],
    ['a leading hyphen', '-acme'],
    ['a trailing hyphen', 'acme-'],
    ['two hyphens in a row', 'ac--me'],
    ['an underscore', 'ac_me'],
    ['forty characters', 'a'.repeat(40)],
    ['a URL', 'https://github.com/acme'],
  ])('refuses %s, which is no GitHub login', (_label, value) => {
    expect(() => githubAppCreationUrl(value)).toThrow(BadRequestException);
  });

  it('accepts the longest login GitHub allows', () => {
    expect(githubAppCreationUrl('a'.repeat(39))).toContain(
      `/organizations/${'a'.repeat(39)}/`,
    );
  });
});

describe('GithubAppManifestStateService.buildManifestStart', () => {
  const build = () => {
    const saved: unknown[] = [];
    const repo = {
      create: (row: unknown) => row,
      save: async (row: unknown) => {
        saved.push(row);
        return row;
      },
      delete: async () => ({ affected: 0 }),
    };
    const service = new GithubAppManifestStateService(
      { get: () => undefined } as never,
      repo as never,
    );
    return { service, saved };
  };

  it('hands back the organisation’s URL with the same manifest and callback as an account App', async () => {
    const { service } = build();
    const personal = await service.buildManifestStart('u1', {
      name: 'flui-acme',
      publicApiUrl: 'https://flui.acme.test',
    });
    const org = await service.buildManifestStart('u1', {
      name: 'flui-acme',
      publicApiUrl: 'https://flui.acme.test',
      organization: 'acme',
    });

    expect(personal.githubUrl).toBe('https://github.com/settings/apps/new');
    expect(org.githubUrl).toBe(
      'https://github.com/organizations/acme/settings/apps/new',
    );
    const withoutState = (m: Record<string, unknown>) => ({
      ...m,
      redirect_url: String(m.redirect_url).replace(/[^/]+$/, ''),
    });
    expect(withoutState(org.manifestJson)).toEqual(
      withoutState(personal.manifestJson),
    );
    expect(org.manifestJson.redirect_url).toBe(
      `https://flui.acme.test/api/v1/repositories/github/setup/github-app/manifest-callback/${org.state}`,
    );
  });

  it('issues no state for an organisation it refuses', async () => {
    const { service, saved } = build();
    await expect(
      service.buildManifestStart('u1', {
        publicApiUrl: 'https://flui.acme.test',
        organization: 'acme/../x',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(saved).toEqual([]);
  });
});

describe('the organisation on the manifest-start body', () => {
  const errorsFor = async (organization?: string) =>
    (
      await validate(
        plainToInstance(GitHubAppManifestStartDto, {
          name: 'flui-acme',
          webhooksEnabled: false,
          organization,
        }),
      )
    ).map((e) => e.property);

  it('is optional', async () => {
    expect(await errorsFor(undefined)).toEqual([]);
  });

  it('takes a GitHub login', async () => {
    expect(await errorsFor('acme-labs')).toEqual([]);
  });

  it('refuses anything that could reshape the URL', async () => {
    expect(await errorsFor('acme/../settings')).toEqual(['organization']);
    expect(await errorsFor('-acme')).toEqual(['organization']);
  });
});
