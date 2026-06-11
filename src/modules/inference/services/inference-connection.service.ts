import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { KeyStorageService } from '../../access/services/key-storage.service';
import { ConfigurationModeService } from '../../management/services/configuration-mode.service';
import { ValidationResultDto } from '../../management/dto/validation-result.dto';
import { InferenceConnectionRepository } from '../repositories/inference-connection.repository';
import { InferenceClientService } from './inference-client.service';
import { InferenceResolverService } from './inference-resolver.service';
import { CreateInferenceConnectionDto } from '../dto/create-inference-connection.dto';
import { InferenceConnectionDto } from '../dto/inference-connection.dto';

@Injectable()
export class InferenceConnectionService {
  constructor(
    private readonly repository: InferenceConnectionRepository,
    private readonly keyStorage: KeyStorageService,
    private readonly configurationMode: ConfigurationModeService,
    private readonly client: InferenceClientService,
    private readonly resolver: InferenceResolverService,
  ) {}

  async create(
    dto: CreateInferenceConnectionDto,
  ): Promise<InferenceConnectionDto> {
    this.assertWritable();
    if (dto.isDefault) {
      await this.repository.clearDefault();
    }
    const models =
      dto.models ?? (await this.discoverModels(dto.baseUrl, dto.apiKey));
    const entity = await this.repository.create({
      label: dto.label,
      baseUrl: dto.baseUrl,
      encryptedApiKey: this.keyStorage.encryptKeyToString(dto.apiKey),
      models,
      isDefault: dto.isDefault ?? false,
    });
    return InferenceConnectionDto.fromEntity(entity);
  }

  async list(): Promise<InferenceConnectionDto[]> {
    const entities = await this.repository.findAll();
    return entities.map((e) => InferenceConnectionDto.fromEntity(e));
  }

  async remove(id: string): Promise<void> {
    this.assertWritable();
    const deleted = await this.repository.delete(id);
    if (!deleted) {
      throw new NotFoundException(`Inference connection ${id} not found`);
    }
  }

  async validate(id: string): Promise<ValidationResultDto> {
    const endpoint = await this.resolver.resolveConnection(id);
    try {
      const models = await this.client.listModelIds(
        endpoint.baseUrl,
        endpoint.apiKey,
      );
      await this.repository.updateModels(id, models);
      return {
        success: true,
        message: `Valid — ${models.length} models reachable`,
        details: { models },
      };
    } catch (error) {
      if (error.response?.status === 401 || error.response?.status === 403) {
        return { success: false, message: 'Invalid API key' };
      }
      return { success: false, message: `Validation failed: ${error.message}` };
    }
  }

  private async discoverModels(
    baseUrl: string,
    apiKey: string,
  ): Promise<string[]> {
    try {
      return await this.client.listModelIds(baseUrl, apiKey);
    } catch {
      return [];
    }
  }

  private assertWritable(): void {
    if (this.configurationMode.isHostedMode()) {
      throw new ForbiddenException(
        'Inference connections are managed by Flui in hosted mode',
      );
    }
  }
}
