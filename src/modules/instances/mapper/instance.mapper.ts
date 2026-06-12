import { InstanceDto } from '../dto/instance.dto';
import { InstanceEntity } from '../entities/instance.entity';

export class InstanceMapper {
  static toDto(entity: InstanceEntity): InstanceDto {
    return {
      id: entity.id,
      userId: entity.userId,
      name: entity.name,
      displayName: entity.displayName,
      type: entity.type,
      provider: entity.provider,
      providerId: entity.providerId,
      status: entity.status,
      dataCenter: entity.dataCenter,
      region: entity.region,
      regionName: entity.regionName,
      cpuCores: entity.cpuCores,
      ramMb: entity.ramMb,
      diskMb: entity.diskMb,
      osType: entity.osType,
      ipConfig: entity.ipConfig,
      macAddress: entity.macAddress,
      productType: entity.productType,
      productName: entity.productName,
      defaultUser: entity.defaultUser,
      additionalIps: entity.additionalIps,
      metadata: entity.metadata,
      ownership: entity.ownership,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      cancelDate: entity.cancelDate,
    };
  }

  static toDtoList(entities: InstanceEntity[]): InstanceDto[] {
    return entities.map((entity) => this.toDto(entity));
  }
}
