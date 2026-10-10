import { BadRequestException, PipeTransform } from '@nestjs/common';

const SERVER_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** A node id is an identifier; anything else is refused before it reaches a query. */
export class ServerIdPipe implements PipeTransform<string | undefined> {
  transform(value: string | undefined): string | undefined {
    if (value === undefined || value === '') return undefined;
    if (!SERVER_ID.test(value)) {
      throw new BadRequestException('serverId is not a valid node id');
    }
    return value;
  }
}
