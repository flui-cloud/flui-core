import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Observable, Subject, interval, merge } from 'rxjs';
import { map } from 'rxjs/operators';

export enum DemoEventType {
  HEARTBEAT = 'heartbeat',
  CYCLE_STARTED = 'cycle-started',
  MIGRATION_PROGRESS = 'migration-progress',
  WINDOW_OPENED = 'window-opened',
  WINDOW_CLOSED = 'window-closed',
  CYCLE_COMPLETED = 'cycle-completed',
  CYCLE_FAILED = 'cycle-failed',
  DRAIN_STARTED = 'drain-started',
  COUNTERS = 'counters',
  CONFIG_CHANGED = 'config-changed',
}

export interface DemoEvent {
  event: DemoEventType;
  data: unknown;
}

const HEARTBEAT_MS = 15_000;

@Injectable()
export class DemoEventsService implements OnModuleDestroy {
  private readonly subject = new Subject<DemoEvent>();

  private readonly heartbeat$ = interval(HEARTBEAT_MS).pipe(
    map<number, DemoEvent>(() => ({
      event: DemoEventType.HEARTBEAT,
      data: { ts: new Date().toISOString() },
    })),
  );

  readonly events$: Observable<DemoEvent> = merge(
    this.heartbeat$,
    new Observable<DemoEvent>((subscriber) => {
      const sub = this.subject.subscribe(subscriber);
      return () => sub.unsubscribe();
    }),
  );

  emit(event: DemoEventType, data: unknown): void {
    this.subject.next({ event, data });
  }

  onModuleDestroy(): void {
    this.subject.complete();
  }
}
