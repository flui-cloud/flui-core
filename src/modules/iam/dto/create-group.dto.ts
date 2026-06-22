import { IsOptional, IsString, Matches } from 'class-validator';

export class CreateGroupDto {
  @Matches(/^[a-z][a-z0-9-]{0,62}$/, {
    message: 'name must match ^[a-z][a-z0-9-]{0,62}$',
  })
  name: string;

  @IsOptional()
  @IsString()
  description?: string;
}
