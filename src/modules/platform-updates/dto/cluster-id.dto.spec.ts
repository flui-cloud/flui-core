import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ApplyManifestsDto, PlanManifestsDto } from './manifest-refresh.dto';
import {
  ApplyInstallValuesDto,
  PlanInstallValuesDto,
} from './install-values.dto';
import { K3sUpgradePlanQueryDto } from './k3s-upgrade.dto';

const ID = '3f1c2b1e-8a4d-4c2e-9b7a-1d2e3f4a5b6c';

describe.each([
  ['PlanManifestsDto', PlanManifestsDto, {}],
  ['ApplyManifestsDto', ApplyManifestsDto, { planId: 'p' }],
  ['PlanInstallValuesDto', PlanInstallValuesDto, {}],
  ['ApplyInstallValuesDto', ApplyInstallValuesDto, { planId: 'p' }],
  ['K3sUpgradePlanQueryDto', K3sUpgradePlanQueryDto, {}],
] as const)('%s clusterId', (_name, Dto, base) => {
  const errors = async (body: object) =>
    (await validate(plainToInstance(Dto as never, { ...base, ...body }))).map(
      (e) => e.property,
    );

  it('is optional', async () => {
    expect(await errors({})).toEqual([]);
  });

  it('accepts a cluster id', async () => {
    expect(await errors({ clusterId: ID })).toEqual([]);
  });

  it('refuses anything else', async () => {
    expect(await errors({ clusterId: '../control' })).toEqual(['clusterId']);
  });
});
