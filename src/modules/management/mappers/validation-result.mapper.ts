import { ValidationResultDto } from '../dto/validation-result.dto';
import { ProviderRegion } from '../entities/provider-region.entity';

export class ValidationResultMapper {
  static createSuccess(
    details?: any,
    availableRegions?: ProviderRegion[],
  ): ValidationResultDto {
    return {
      success: true,
      details,
      availableRegions,
    };
  }

  static createError(message: string, details?: any): ValidationResultDto {
    return {
      success: false,
      message,
      details,
    };
  }
}
