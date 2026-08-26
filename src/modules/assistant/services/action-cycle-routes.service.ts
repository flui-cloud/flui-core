import { Injectable, OnModuleInit } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import {
  ACTION_CYCLE_KEY,
  ActionCycleDecl,
} from '../../action-cycle/action-cycle.decorator';
import { reachesActionCycle } from './action-cycle-reach';

/**
 * Every action shape the API has put inside the cycle, read off the routes.
 *
 * Collected from the decorations at boot rather than written down anywhere: the
 * one thing this answer must never do is drift from what the guard actually
 * does. A hand-kept list would let the chat believe a route pauses after
 * somebody removed the decoration — and this answer is what decides whether the
 * chat may make a write before the person has said yes.
 *
 * Read-only on the action cycle: nothing here registers, changes or wraps a
 * route. It looks at the same metadata `ActionCycleGuard` reflects on, from the
 * one surface that needs to know the answer *before* the call.
 */
@Injectable()
export class ActionCycleRoutes implements OnModuleInit {
  private shapes: ReadonlySet<string> = new Set();

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
  ) {}

  onModuleInit(): void {
    const shapes = new Set<string>();
    for (const wrapper of this.discovery.getControllers()) {
      const instance = wrapper.instance as object | undefined;
      if (!instance) continue;
      const prototype = Object.getPrototypeOf(instance) as object;
      for (const method of this.scanner.getAllMethodNames(prototype)) {
        const handler = (prototype as Record<string, unknown>)[method];
        if (typeof handler !== 'function') continue;
        const decl = Reflect.getMetadata(ACTION_CYCLE_KEY, handler) as
          | ActionCycleDecl
          | undefined;
        if (decl?.action) shapes.add(decl.action);
      }
    }
    this.shapes = shapes;
  }

  /**
   * Would every call this tool can make be stopped and raised as a request?
   *
   * The only question the chat asks of this class, and it is asked in three
   * places that have to agree: whether to pause the call locally, whether to
   * refuse it as unapproved, and whether the person's click may be recorded as
   * the answer to the cycle's request. One predicate, so they cannot disagree.
   */
  reaches(routes: readonly string[] | undefined): boolean {
    return reachesActionCycle(routes, this.shapes);
  }

  /** The shapes found, for the sentinel that pins this against the decorations. */
  known(): ReadonlySet<string> {
    return this.shapes;
  }
}
