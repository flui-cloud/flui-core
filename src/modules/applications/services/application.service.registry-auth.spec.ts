jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));

import * as crypto from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { ApplicationService } from './application.service';
import { withholdDataFrom } from './application-access.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { CreateApplicationDto } from '../dto/create-application.dto';
import { UpdateApplicationDto } from '../dto/update-application.dto';
import { ApplicationEntity } from '../entities/application.entity';
import { ApplicationCategory } from '../enums/application-category.enum';
import { ApplicationSourceType } from '../enums/application-source-type.enum';
import { BadRequestException } from '@nestjs/common';

const SECRET = 'dXNlcjpyZWdpc3RyeS1wYXNzd29yZA==';

describe('ApplicationService — registry credential', () => {
  const encryption = new EncryptionService({
    get: (name: string) =>
      name === 'ENCRYPTION_KEY'
        ? crypto.randomBytes(32).toString('hex')
        : undefined,
  } as unknown as ConfigService);

  let row: ApplicationEntity;
  const applicationsRepository = {
    create: async (data: Partial<ApplicationEntity>) => {
      row = { id: 'app-1', ...data } as ApplicationEntity;
      return row;
    },
    findById: async () => row,
    update: async (_id: string, patch: Partial<ApplicationEntity>) => {
      row = { ...row, ...patch } as ApplicationEntity;
      return row;
    },
  };
  const resourceProfilesService = {
    getDefaultProfileName: () => 'small',
    resolveResources: () => ({
      cpu: { request: '100m', limit: '500m' },
      memory: { request: '128Mi', limit: '512Mi' },
    }),
  };
  const service = new (ApplicationService as unknown as new (
    ...args: unknown[]
  ) => ApplicationService)(
    applicationsRepository,
    undefined,
    undefined,
    undefined,
    encryption,
    undefined,
    resourceProfilesService,
    ...new Array(4).fill(undefined),
    {
      placementFor: async () => ({
        project: { id: 'personal-of-u1', slug: 'personal-u1' },
        namespace: 'p-personal-u1',
      }),
    },
  );

  const image = {
    type: 'docker_image',
    imageRef: 'registry.example.com/acme/api:1.2.3',
  };
  const create = (sourceConfig: Record<string, unknown>) =>
    service.create(
      'cluster-1',
      {
        name: 'api',
        slug: 'api',
        category: ApplicationCategory.USER,
        sourceType: ApplicationSourceType.DOCKER_IMAGE,
        sourceConfig,
      } as CreateApplicationDto,
      'u1',
    );

  it('refuses one on create, and stores nothing', async () => {
    row = undefined as unknown as ApplicationEntity;
    await expect(
      create({ ...image, registryAuth: SECRET }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(row).toBeUndefined();
  });

  it('refuses one on update, and leaves the source as it was', async () => {
    await create(image);
    await expect(
      service.update('app-1', {
        sourceConfig: { ...image, registryAuth: SECRET },
      } as UpdateApplicationDto),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(row.sourceConfig).toEqual(image);
  });

  it('never stores a sealed value or a marker a client sends', async () => {
    await create({
      ...image,
      registryAuthEncrypted: 'v1:x',
      hasRegistryAuth: true,
    });
    expect(row.sourceConfig).toEqual(image);
  });

  it('never returns one stored before it was refused — with or without data access', () => {
    row = {
      id: 'app-1',
      sourceConfig: { ...image, registryAuth: SECRET },
    } as unknown as ApplicationEntity;
    const dto = service.toResponseDto(row);

    expect(dto.sourceConfig).toEqual(image);
    for (const seen of [
      dto,
      withholdDataFrom(dto, { dataAccess: true }),
      withholdDataFrom(dto, { dataAccess: false }),
    ]) {
      expect(JSON.stringify(seen)).not.toContain(SECRET);
    }
  });
});
