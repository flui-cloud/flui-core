jest.mock('@kubernetes/client-node', () => ({}));

import { AppEndpointController } from './app-endpoint.controller';

describe('listing a cluster’s endpoints', () => {
  const endpoints = [
    { id: 'e1', applicationId: 'a1', certificateStatus: 'issued' },
    { id: 'e2', applicationId: 'a2', certificateStatus: 'issued' },
    { id: 'e3', applicationId: 'a1', certificateStatus: 'issued' },
    { id: 'e4', applicationId: 'gone', certificateStatus: 'issued' },
  ];

  function controller(readable: string[]) {
    const applications = {
      findById: jest.fn(),
      findByIdsLite: jest.fn(async (ids: string[]) =>
        ids.filter((id) => id !== 'gone').map((id) => ({ id })),
      ),
    };
    const appAccess = {
      filterReadable: jest.fn(async (_user: unknown, apps: { id: string }[]) =>
        apps.filter((a) => readable.includes(a.id)),
      ),
    };
    const service = {
      listEndpoints: jest.fn(async () => endpoints),
      toResponseDto: (e: { id: string }) => e.id,
    };
    const subject = new AppEndpointController(
      service as never,
      {} as never,
      {} as never,
      appAccess as never,
      applications as never,
      { refreshIfNeeded: jest.fn() } as never,
    );
    return { subject, applications };
  }

  it('reads every application once, in one lookup, without their history', async () => {
    const { subject, applications } = controller(['a1']);
    await subject.listEndpoints('c1', { user: { id: 'u' } } as never);
    expect(applications.findByIdsLite).toHaveBeenCalledTimes(1);
    expect(applications.findByIdsLite).toHaveBeenCalledWith([
      'a1',
      'a2',
      'gone',
    ]);
    expect(applications.findById).not.toHaveBeenCalled();
  });

  it('keeps the readable ones and the orphans, drops the rest', async () => {
    const { subject } = controller(['a1']);
    const listed = await subject.listEndpoints('c1', {
      user: { id: 'u' },
    } as never);
    expect(listed).toEqual(['e1', 'e3', 'e4']);
  });
});
