import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { GrantNoticeService } from '../services/grant-notice.service';

@Injectable()
export class GrantNoticeScheduler {
  constructor(private readonly notices: GrantNoticeService) {}

  @Cron(process.env.GRANT_NOTICE_CRON || '*/10 * * * *')
  run(): Promise<void> {
    return this.notices.sweep();
  }
}
