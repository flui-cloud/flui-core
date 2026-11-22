import { z } from 'zod';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import { defineTool, ToolDef } from './mcp-tool.util';

const enc = encodeURIComponent;

/** An application's own account on the NATS its cluster shares. */
export const MESSAGING_TOOLS: ToolDef[] = [
  defineTool({
    name: 'app_messaging_get',
    routes: ['GET /applications/:id/messaging'],
    description:
      'Whether an application has its own account on its cluster’s NATS (messaging with JetStream), with the address it connects to and the account’s public key. Never the credentials.',
    scope: MCP_SCOPE.APP_READ,
    inputSchema: { id: z.string() },
    run: (args, ctx) => ctx.api.get(`/applications/${enc(args.id)}/messaging`),
  }),
  defineTool({
    name: 'app_messaging_connect',
    routes: ['PUT /applications/:id/messaging'],
    description:
      'Give an application its own account on its cluster’s NATS. Puts the cluster’s NATS in place if needed; the application receives NATS_URL and NATS_CREDS (a NATS credentials file, secret) and is redeployed. Its subjects and streams are invisible to every other application. Calling it again changes nothing.',
    scope: MCP_SCOPE.APP_WRITE,
    inputSchema: { id: z.string() },
    run: (args, ctx) =>
      ctx.api.put(`/applications/${enc(args.id)}/messaging`, {}),
  }),
  defineTool({
    name: 'app_messaging_scale',
    routes: [
      'PUT /applications/:id/messaging/scaling',
      'DELETE /applications/:id/messaging/scaling',
    ],
    description:
      'Scale an application on its NATS queue instead of CPU: replicas grow while the durable consumer’s backlog passes lagThreshold per replica, up to max, and go down to min — 0 stops the worker while the queue is empty. Needs app_messaging_connect first; installs KEDA on the cluster if missing. Pass off=true to stop scaling on the queue.',
    scope: MCP_SCOPE.APP_WRITE,
    inputSchema: {
      id: z.string(),
      off: z.boolean().optional(),
      stream: z.string().optional(),
      consumer: z.string().optional(),
      lagThreshold: z.number().int().min(1).optional(),
      min: z.number().int().min(0).optional(),
      max: z.number().int().min(1).optional(),
    },
    run: (args, ctx) =>
      args.off
        ? ctx.api.delete(`/applications/${enc(args.id)}/messaging/scaling`)
        : ctx.api.put(`/applications/${enc(args.id)}/messaging/scaling`, {
            stream: args.stream,
            consumer: args.consumer,
            lagThreshold: args.lagThreshold ?? 10,
            min: args.min ?? 0,
            max: args.max ?? 5,
          }),
  }),
  defineTool({
    name: 'app_queue_list',
    routes: ['GET /applications/:id/messaging/queues'],
    description:
      'The queues in an application’s NATS account: messages waiting, in flight, redelivered, and given up on (deadLetters, null without a dead-letter queue).',
    scope: MCP_SCOPE.APP_READ,
    inputSchema: { id: z.string() },
    run: (args, ctx) =>
      ctx.api.get(`/applications/${enc(args.id)}/messaging/queues`),
  }),
  defineTool({
    name: 'app_queue_create',
    routes: ['POST /applications/:id/messaging/queues'],
    description:
      'Create a queue in an application’s NATS account: a work-queue stream on NAME and NAME.>, one durable consumer NAME the worker pulls from, and with deadLetter a NAME_DLQ that records messages given up on after maxDeliver deliveries. maxAgeHours is how long an unhandled message is kept.',
    scope: MCP_SCOPE.APP_WRITE,
    inputSchema: {
      id: z.string(),
      name: z.string().regex(/^[A-Za-z0-9_-]{1,60}$/),
      maxAgeHours: z.number().int().min(1),
      maxDeliver: z.number().int().min(1).max(100),
      deadLetter: z.boolean(),
    },
    run: (args, ctx) =>
      ctx.api.post(`/applications/${enc(args.id)}/messaging/queues`, {
        name: args.name,
        maxAgeHours: args.maxAgeHours,
        maxDeliver: args.maxDeliver,
        deadLetter: args.deadLetter,
      }),
  }),
  defineTool({
    name: 'app_queue_delete',
    routes: ['DELETE /applications/:id/messaging/queues/:name'],
    description:
      'Delete a queue and its dead letters, with every message in them. The messages cannot be recovered. Destructive.',
    scope: MCP_SCOPE.APP_DESTRUCTIVE,
    inputSchema: { id: z.string(), name: z.string() },
    run: (args, ctx) =>
      ctx.api.delete(
        `/applications/${enc(args.id)}/messaging/queues/${enc(args.name)}`,
      ),
  }),
  defineTool({
    name: 'app_messaging_disconnect',
    routes: ['DELETE /applications/:id/messaging'],
    description:
      'Take an application’s account off its cluster’s NATS: NATS_URL and NATS_CREDS are removed and the application is redeployed. Streams it kept there are not deleted by this.',
    scope: MCP_SCOPE.APP_WRITE,
    inputSchema: { id: z.string() },
    run: async (args, ctx) => {
      await ctx.api.delete(`/applications/${enc(args.id)}/messaging`);
      return { id: args.id, disconnected: true };
    },
  }),
];
