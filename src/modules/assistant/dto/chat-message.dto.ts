import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsString } from 'class-validator';

export enum ChatRole {
  SYSTEM = 'system',
  USER = 'user',
  ASSISTANT = 'assistant',
}

export class ChatMessageDto {
  @ApiProperty({ enum: ChatRole })
  @IsEnum(ChatRole)
  role: ChatRole;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  content: string;
}
