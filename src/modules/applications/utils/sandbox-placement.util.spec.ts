import {
  stripSandboxInstallPlacement,
  stripSandboxPlacementFields,
} from './sandbox-placement.util';
import { CreateApplicationDto } from '../dto/create-application.dto';

/**
 * Node placement decides which machine — or which control plane — hosts the
 * workload. On the shared sandbox that is not the guest's decision to make:
 * these fields must not survive a guest's request, while every other caller
 * keeps them.
 */
describe('sandbox placement stripping', () => {
  it('removes the three placement fields and nothing else', () => {
    const dto = {
      name: 'probe',
      persistenceScope: 'dedicated',
      dedicatedNodeName: 'master-1',
      allowMasterPlacement: true,
    } as CreateApplicationDto;
    stripSandboxPlacementFields(dto);
    expect(dto).toEqual({ name: 'probe' });
  });

  it('is a no-op when the fields are absent', () => {
    const dto = { name: 'probe' } as CreateApplicationDto;
    stripSandboxPlacementFields(dto);
    expect(dto).toEqual({ name: 'probe' });
  });

  it('removes the master-placement switch from a catalog install', () => {
    const dto: { allowMasterPlacement?: boolean; domain?: string } = {
      allowMasterPlacement: true,
      domain: 'app.example.com',
    };
    stripSandboxInstallPlacement(dto);
    expect(dto).toEqual({ domain: 'app.example.com' });
  });
});
