jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ApplicationService } from './application.service';
import { ApplicationWorkflowService } from './application-workflow.service';
import { CreateApplicationDto } from '../dto/create-application.dto';
import { UpdateApplicationDto } from '../dto/update-application.dto';
import { ApplicationEntity } from '../entities/application.entity';
import { ApplicationCategory } from '../enums/application-category.enum';
import { ApplicationSourceType } from '../enums/application-source-type.enum';
import { RepositoriesRepository } from '../../repositories/repositories/repositories.repository';

const THEIRS = '7b0c3a52-3f0e-4c55-9a51-6f1e2d3c4b5a';
const MINE = '0f9e8d7c-6b5a-4c3d-8e2f-1a2b3c4d5e6f';
const SERVICE = '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a';
const OWNER = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const GUEST = 'f6e5d4c3-b2a1-4f0e-9d8c-7b6a5f4e3d2c';

const rows = [
  { id: THEIRS, userId: OWNER, owner: 'owner', repositoryName: 'private' },
  { id: MINE, userId: GUEST, owner: 'guest', repositoryName: 'site' },
  {
    id: SERVICE,
    userId: 'cli-bootstrap',
    owner: 'ops',
    repositoryName: 'showcase',
  },
];
const matches = (
  row: Record<string, unknown>,
  where: Record<string, unknown>,
) => Object.entries(where).every(([k, v]) => row[k] === v);
const repositories = new RepositoriesRepository({
  findOne: async ({ where }: { where: Record<string, unknown> }) =>
    rows.find((r) => matches(r, where)) ?? null,
} as never);

const gitBuild = (repositoryId: string) => ({
  type: 'git_build',
  repositoryId,
  branch: 'main',
});

describe('an application is linked only to its own owner’s repository', () => {
  let row: ApplicationEntity;
  const service = new (ApplicationService as unknown as new (
    ...args: unknown[]
  ) => ApplicationService)(
    {
      create: async (data: Partial<ApplicationEntity>) => {
        row = { id: 'app-1', ...data } as ApplicationEntity;
        return row;
      },
      findById: async () => row,
      update: async (_id: string, patch: Partial<ApplicationEntity>) => {
        row = { ...row, ...patch } as ApplicationEntity;
        return row;
      },
    },
    undefined,
    undefined,
    repositories,
    undefined,
    undefined,
    {
      getDefaultProfileName: () => 'small',
      resolveResources: () => ({
        cpu: { request: '100m', limit: '500m' },
        memory: { request: '128Mi', limit: '512Mi' },
      }),
    },
    ...new Array(4).fill(undefined),
    {
      placementFor: async () => ({
        project: { id: 'personal-of-guest', slug: 'personal-guest' },
        namespace: 'p-personal-guest',
      }),
    },
  );

  const create = (repositoryId: string) =>
    service.create(
      'cluster-1',
      {
        name: 'site',
        slug: 'site',
        category: ApplicationCategory.USER,
        sourceType: ApplicationSourceType.GIT_BUILD,
        sourceConfig: gitBuild(repositoryId),
      } as CreateApplicationDto,
      GUEST,
    );

  it('refuses to create one on somebody else’s repository', async () => {
    await expect(create(THEIRS)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('creates one on the caller’s own repository', async () => {
    await expect(create(MINE)).resolves.toMatchObject({ userId: GUEST });
  });

  it('refuses to repoint an existing one at somebody else’s repository', async () => {
    await create(MINE);

    await expect(
      service.update('app-1', {
        sourceConfig: gitBuild(THEIRS),
      } as UpdateApplicationDto),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect((row.sourceConfig as { repositoryId: string }).repositoryId).toBe(
      MINE,
    );
  });
});

describe('a workflow is generated only into the owner’s own repository', () => {
  const workflows = new (ApplicationWorkflowService as unknown as new (
    ...args: unknown[]
  ) => ApplicationWorkflowService)(undefined, repositories);
  const resolve = (app: object) =>
    (
      workflows as unknown as {
        resolveLinkedRepository: (a: object) => Promise<unknown>;
      }
    ).resolveLinkedRepository(app);

  it('does not reach a repository the application’s owner did not connect', async () => {
    await expect(
      resolve({ id: 'a', userId: GUEST, sourceConfig: gitBuild(THEIRS) }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('does not reach a person’s repository for an application with no owner', async () => {
    await expect(
      resolve({ id: 'a', sourceConfig: gitBuild(MINE) }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lets an application a service identity created reach a repository a service identity connected', async () => {
    await expect(
      resolve({ id: 'a', userId: null, sourceConfig: gitBuild(SERVICE) }),
    ).resolves.toMatchObject({ repositoryName: 'showcase' });
  });

  it('does not let a person’s application reach a service identity’s repository', async () => {
    await expect(
      resolve({ id: 'a', userId: GUEST, sourceConfig: gitBuild(SERVICE) }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reaches the owner’s own repository', async () => {
    await expect(
      resolve({ id: 'a', userId: GUEST, sourceConfig: gitBuild(MINE) }),
    ).resolves.toMatchObject({ repositoryName: 'site' });
  });
});
