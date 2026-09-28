import { Request } from 'express';
import { auditEntryFor, outcomeOf } from './audit.middleware';
import { noteAuditPermission, noteDataAccess } from './audit-request';

function request(over: Record<string, unknown> = {}): Request {
  return {
    method: 'GET',
    route: { path: '/api/v1/iam/grants/:id' },
    params: { id: 'g1' },
    headers: {},
    body: { password: 'hunter2' },
    user: { userId: 'u1', email: 'op@support.example' },
    ...over,
  } as unknown as Request;
}

describe('what the audit record keeps', () => {
  it('records a change with its route shape, target and permission', () => {
    const req = request({ method: 'DELETE' });
    noteAuditPermission(req, 'iam:assign-role');
    expect(auditEntryFor(req, 200)).toEqual(
      expect.objectContaining({
        action: 'DELETE /iam/grants/:id',
        target: { id: 'g1' },
        email: 'op@support.example',
        outcome: 'ok',
        permission: 'iam:assign-role',
        dataAccess: false,
      }),
    );
  });

  it('skips a plain read of the platform', () => {
    expect(auditEntryFor(request(), 200)).toBeNull();
  });

  it('records a read that reached application data', () => {
    const req = request({
      route: { path: '/api/v1/observability/applications/:id/logs' },
    });
    noteDataAccess(req);
    expect(auditEntryFor(req, 200)).toEqual(
      expect.objectContaining({ dataAccess: true, outcome: 'ok' }),
    );
  });

  it('records every refusal, reads included', () => {
    expect(auditEntryFor(request(), 403)).toEqual(
      expect.objectContaining({ outcome: 'refused', status: 403 }),
    );
  });

  it('never keeps the body', () => {
    const entry = auditEntryFor(request({ method: 'POST' }), 201);
    expect(JSON.stringify(entry)).not.toContain('hunter2');
  });

  it('records nothing without an authenticated principal or a matched route', () => {
    expect(
      auditEntryFor(request({ user: undefined, method: 'POST' }), 401),
    ).toBeNull();
    expect(
      auditEntryFor(request({ route: undefined, method: 'POST' }), 404),
    ).toBeNull();
  });

  it('reads the outcome from the status', () => {
    expect(outcomeOf(204)).toBe('ok');
    expect(outcomeOf(401)).toBe('refused');
    expect(outcomeOf(403)).toBe('refused');
    expect(outcomeOf(404)).toBe('failed');
    expect(outcomeOf(500)).toBe('failed');
  });
});
