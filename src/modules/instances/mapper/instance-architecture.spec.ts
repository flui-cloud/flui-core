import { HetznerProviderService } from '../../providers/services/hetzner-provider.service';
import { ScalewayProviderService } from '../../providers/implementations/scaleway/scaleway-provider.service';
import { ContaboProviderService } from '../../providers/services/contabo-provider.service';
import { InstanceEntity } from '../entities/instance.entity';
import { InstanceMapper } from './instance.mapper';

type EntityMapper = (...args: unknown[]) => InstanceEntity;

function privateMapper<T extends object>(
  ctor: { prototype: T },
  method: string,
): EntityMapper {
  const service = Object.create(ctor.prototype) as Record<string, EntityMapper>;
  return (...args) => service[method](...args);
}

describe('instance architecture from the provider record', () => {
  describe('Hetzner', () => {
    const map = privateMapper(
      HetznerProviderService,
      'mapHetznerInstanceToEntity',
    );
    const server = (architecture?: string) => ({
      id: 7,
      name: 'node-1',
      status: 'running',
      server_type: { name: 'cx23', cores: 2, memory: 4, architecture },
      primary_disk_size: 40,
    });

    it('reads the server type architecture', () => {
      expect(map(server('x86')).architecture).toBe('x86');
      expect(map(server('arm')).architecture).toBe('arm');
    });

    it('is null when the server type does not say', () => {
      expect(map(server()).architecture).toBeNull();
    });
  });

  describe('Scaleway', () => {
    it('normalises the instance arch', () => {
      const map = privateMapper(
        ScalewayProviderService,
        'mapInstanceServerToEntity',
      );
      const server = (arch?: string) => ({
        id: 'abc',
        name: 'node-1',
        state: 'running',
        commercial_type: 'DEV1-S',
        arch,
      });

      expect(map(server('x86_64'), 'fr-par-1').architecture).toBe('x86');
      expect(map(server('arm64'), 'fr-par-1').architecture).toBe('arm');
      expect(map(server(), 'fr-par-1').architecture).toBeNull();
    });

    it('is null for an Elastic Metal server, whose record names no architecture', () => {
      const map = privateMapper(
        ScalewayProviderService,
        'mapBaremetalServerToEntity',
      );

      expect(
        map({ id: 'bm-1', name: 'metal', status: 'ready' }, 'fr-par-2')
          .architecture,
      ).toBeNull();
    });
  });

  it('is null on Contabo, whose instance record names no architecture', () => {
    const map = privateMapper(
      ContaboProviderService,
      'mapContaboInstanceToEntity',
    );

    expect(
      map({ instanceId: 1, name: 'vps', status: 'running' }).architecture,
    ).toBeNull();
  });

  describe('InstanceMapper', () => {
    it('carries the architecture to the DTO', () => {
      const entity = new InstanceEntity();
      entity.architecture = 'arm';
      expect(InstanceMapper.toDto(entity).architecture).toBe('arm');
    });

    it('answers null rather than leaving the field out', () => {
      expect(
        InstanceMapper.toDto(new InstanceEntity()).architecture,
      ).toBeNull();
    });
  });
});
