import { Controller, Get, Res, Sse } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Public } from '../../auth/decorators/public.decorator';
import { DemoStatusService } from '../services/demo-status.service';
import { DemoEventsService } from '../services/demo-events.service';
import { DEMO_STATUS_HTML } from '../pages/demo-status.page';

interface SseFrame {
  data: { type: string; data: unknown };
}

@ApiTags('demo')
@Public()
@Controller('demo')
export class DemoStatusController {
  constructor(
    private readonly status: DemoStatusService,
    private readonly events: DemoEventsService,
  ) {}

  @Get()
  page(@Res() res: Response): void {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(DEMO_STATUS_HTML);
  }

  @Get('status')
  getStatus() {
    return this.status.snapshot();
  }

  @Sse('events')
  stream(): Observable<SseFrame> {
    return this.events.events$.pipe(
      map((e) => ({ data: { type: e.event, data: e.data } })),
    );
  }
}
