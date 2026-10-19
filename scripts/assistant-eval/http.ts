import { API } from './config';
import { ModelTarget } from './models';
import { Page } from './browser';
import { Question, TurnCapture } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */

export function parseSse(raw: string): Partial<TurnCapture> {
  const out: Partial<TurnCapture> = {
    steps: [],
    error: null,
    content: '',
    type: null,
    pending: [],
    docLinks: [],
  };
  for (const frame of raw.split('\n\n')) {
    if (!frame.startsWith('data:')) continue;
    let ev: any;
    try {
      ev = JSON.parse(frame.slice(5));
    } catch {
      continue;
    }
    if (ev.type === 'done') {
      const r = ev.result;
      out.type = r.type;
      out.content = r.content ?? '';
      out.steps = (r.steps ?? []).map((s: any) => ({
        name: s.name,
        ok: s.ok,
        error: s.error,
        toolCallId: s.toolCallId,
      }));
      out.pending = (r.pending ?? []).map((p: any) => ({
        name: p.name,
        label: p.label,
      }));
      out.docLinks = r.docLinks ?? [];
      out.transcript = (r.messages ?? []).map((msg: any) => ({
        role: msg.role,
        content:
          typeof msg.content === 'string'
            ? msg.content.slice(0, msg.role === 'tool' ? 300 : 4000)
            : msg.content,
        tool_calls: msg.tool_calls?.map((c: any) => ({
          id: c.id,
          name: c.function?.name,
          args: String(c.function?.arguments ?? '').slice(0, 300),
        })),
      }));
    } else if (ev.type === 'error') {
      out.error = {
        message: ev.message,
        code: ev.code,
        retryAfter: ev.retryAfter,
      };
    }
  }
  return out;
}

export async function askHttp(
  tab: Page,
  q: Question,
  m: ModelTarget,
): Promise<TurnCapture> {
  const body: Record<string, unknown> = {
    model: m.model,
    messages: [{ role: 'user', content: q.question }],
  };
  if (m.provider) body.provider = m.provider;
  if (m.connectionId) body.connectionId = m.connectionId;
  const r = await tab.evaluate(
    async ([api, bd]: [string, any]) => {
      const tok = sessionStorage.getItem('access_token');
      const t0 = performance.now();
      const res = await fetch(`${api}/assistant/v1/agent/stream`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tok}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(bd),
      });
      let ttft: number | null = null;
      let firstStep: number | null = null;
      let raw = '';
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = dec.decode(value, { stream: true });
        raw += chunk;
        if (ttft === null && chunk.includes('"type":"delta"'))
          ttft = performance.now() - t0;
        if (firstStep === null && chunk.includes('"type":"step"'))
          firstStep = performance.now() - t0;
      }
      return {
        status: res.status,
        ttft,
        firstStep,
        total: performance.now() - t0,
        raw,
      };
    },
    [API, body],
  );
  const parsed = parseSse(r.raw);
  return {
    status: r.status,
    ttftMs: r.ttft,
    firstStepMs: r.firstStep,
    totalMs: r.total,
    content: parsed.content ?? '',
    type: parsed.type ?? null,
    steps: parsed.steps ?? [],
    pending: parsed.pending ?? [],
    docLinks: parsed.docLinks ?? [],
    error: parsed.error ?? null,
    transcript: parsed.transcript,
    sent: {
      model: m.model,
      provider: m.provider,
      connectionId: m.connectionId,
    },
  };
}
