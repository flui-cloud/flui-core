import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AlertsWebhookService } from './alerts-webhook.service';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ApplicationTrafficService } from '../../observability/services/application-traffic.service';
import { AlertEventsService } from '../../observability/services/alert-events.service';
import { UserEventsGateway } from '../../auth/gateway/user-events.gateway';
import { AlertmanagerWebhookDto } from '../dto/alertmanager-webhook.dto';

const TOKEN = 'super-secret-token';

const payload = (
  labels: Record<string, string>,
  status = 'firing',
): AlertmanagerWebhookDto => ({
  status,
  alerts: [
    {
      status,
      labels,
      annotations: { summary: 'something happened' },
      fingerprint: 'fp-1',
      startsAt: '2026-07-18T10:00:00.000Z',
    },
  ],
});

describe('AlertsWebhookService', () => {
  let service: AlertsWebhookService;
  let findOne: jest.Mock;
  let find: jest.Mock;
  let configGet: jest.Mock;
  let record: jest.Mock;
  let emitAlert: jest.Mock;

  beforeEach(async () => {
    findOne = jest.fn().mockResolvedValue(null);
    find = jest.fn().mockResolvedValue([]);
    configGet = jest.fn().mockReturnValue(TOKEN);
    record = jest.fn().mockResolvedValue([]);
    emitAlert = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AlertsWebhookService,
        { provide: ConfigService, useValue: { get: configGet } },
        {
          provide: getRepositoryToken(ApplicationEntity),
          useValue: { findOne, find },
        },
        // The real service is used deliberately: the traffic alert path must match the
        // exact id format the metrics carry, so a stub would hide a drift between them.
        {
          provide: ApplicationTrafficService,
          useValue: new ApplicationTrafficService({} as never),
        },
        { provide: AlertEventsService, useValue: { record } },
        { provide: UserEventsGateway, useValue: { emitAlert } },
      ],
    }).compile();

    service = module.get(AlertsWebhookService);
  });

  describe('authentication', () => {
    it('fails closed when no token is configured', async () => {
      configGet.mockReturnValue(undefined);
      await expect(
        service.handle({ header: TOKEN }, payload({ flui_kind: 'node' })),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects a wrong token', async () => {
      await expect(
        service.handle({ header: 'nope' }, payload({ flui_kind: 'node' })),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects a missing token', async () => {
      await expect(
        service.handle({}, payload({ flui_kind: 'node' })),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('accepts the Flui header', async () => {
      const res = await service.handle(
        { header: TOKEN },
        payload({ flui_kind: 'node', instance: 'node-1:9100' }),
      );
      expect(res.received).toBe(true);
    });

    it('accepts a bearer token, which is all Alertmanager can send', async () => {
      const res = await service.handle(
        { authorization: `Bearer ${TOKEN}` },
        payload({ flui_kind: 'node', instance: 'node-1:9100' }),
      );
      expect(res.received).toBe(true);
    });

    it('ignores a non-bearer authorization scheme', async () => {
      await expect(
        service.handle(
          { authorization: `Basic ${TOKEN}` },
          payload({ flui_kind: 'node' }),
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('subject resolution', () => {
    it('resolves an application alert by slug and namespace', async () => {
      find.mockResolvedValue([
        { id: 'app-1', slug: 'vops-api-c9a2jp', k8sNamespace: 'default' },
      ]);

      const res = await service.handle(
        { header: TOKEN },
        payload({
          flui_kind: 'application',
          alertname: 'FluiAppDown',
          severity: 'critical',
          namespace: 'default',
          label_app_kubernetes_io_name: 'vops-api-c9a2jp',
        }),
      );

      expect(res.resolved).toBe(1);
      expect(record).toHaveBeenCalledWith([
        expect.objectContaining({
          applicationId: 'app-1',
          applicationSlug: 'vops-api-c9a2jp',
          namespace: 'default',
          alertname: 'FluiAppDown',
          severity: 'critical',
          status: 'firing',
        }),
      ]);
    });

    // Subject resolution used to run one query per alert; a node going down fires one
    // alert per application on it, so the batch must resolve with a bounded number.
    it('resolves a whole batch without a query per alert', async () => {
      find.mockResolvedValue([
        { id: 'app-1', slug: 'api', k8sNamespace: 'default' },
        { id: 'app-2', slug: 'web', k8sNamespace: 'default' },
      ]);

      const alert = (slug: string) => ({
        status: 'firing',
        fingerprint: `fp-${slug}`,
        startsAt: '2026-07-18T10:00:00.000Z',
        labels: {
          flui_kind: 'application',
          alertname: 'FluiAppDown',
          severity: 'critical',
          namespace: 'default',
          label_app_kubernetes_io_name: slug,
        },
        annotations: {},
      });

      const res = await service.handle(
        { header: TOKEN },
        { status: 'firing', alerts: [alert('api'), alert('web')] },
      );

      expect(res.resolved).toBe(2);
      expect(find).toHaveBeenCalledTimes(1);
    });

    it('resolves a traffic alert by rebuilding the Traefik service id', async () => {
      find.mockResolvedValue([
        { id: 'other', slug: 'web', k8sNamespace: 'default', port: 80 },
        {
          id: 'app-1',
          slug: 'vops-api-c9a2jp',
          k8sNamespace: 'default',
          port: 7799,
        },
      ]);

      const res = await service.handle(
        { header: TOKEN },
        payload({
          flui_kind: 'traffic',
          alertname: 'FluiAppHighErrorRate',
          severity: 'critical',
          service: 'default-vops-api-c9a2jp-svc-7799@kubernetes',
        }),
      );

      expect(res.resolved).toBe(1);
    });

    it('resolves a traffic alert for a namespace containing dashes', async () => {
      // Parsing `<ns>-<slug>-svc-<port>` backwards is ambiguous here; constructing
      // forward is not, which is why resolution is done that way round.
      find.mockResolvedValue([
        { id: 'app-2', slug: 'api', k8sNamespace: 'user-dawit', port: 80 },
      ]);

      const res = await service.handle(
        { header: TOKEN },
        payload({
          flui_kind: 'traffic',
          service: 'user-dawit-api-svc-80@kubernetes',
        }),
      );

      expect(res.resolved).toBe(1);
    });

    it('does not resolve a traffic alert for a TCP app, which has no HTTP route', async () => {
      find.mockResolvedValue([
        {
          id: 'db',
          slug: 'pg',
          k8sNamespace: 'default',
          port: 5432,
          portProtocol: 'tcp',
        },
      ]);

      const res = await service.handle(
        { header: TOKEN },
        payload({
          flui_kind: 'traffic',
          service: 'default-pg-svc-5432@kubernetes',
        }),
      );

      expect(res.resolved).toBe(0);
    });

    it('accepts node alerts without touching the application tables', async () => {
      const res = await service.handle(
        { header: TOKEN },
        payload({
          flui_kind: 'node',
          alertname: 'FluiNodeDiskNearFull',
          instance: '10.0.0.4:9100',
        }),
      );

      expect(findOne).not.toHaveBeenCalled();
      expect(find).not.toHaveBeenCalled();
      expect(res.alerts).toBe(1);
      expect(res.resolved).toBe(0);
    });

    it('accepts an unknown kind without failing the delivery', async () => {
      // A rejected webhook makes Alertmanager retry forever; an unrecognised alert
      // must be absorbed, not bounced.
      const res = await service.handle(
        { header: TOKEN },
        payload({ alertname: 'SomethingNew' }),
      );

      expect(res.received).toBe(true);
      expect(res.resolved).toBe(0);
    });

    it('counts only the alerts it could attribute', async () => {
      findOne.mockResolvedValue(null);
      const res = await service.handle(
        { header: TOKEN },
        {
          status: 'firing',
          alerts: [
            {
              status: 'firing',
              labels: {
                flui_kind: 'application',
                label_app_kubernetes_io_name: 'ghost',
                namespace: 'default',
              },
            },
            { status: 'firing', labels: { flui_kind: 'node', instance: 'n1' } },
          ],
        },
      );

      expect(res.alerts).toBe(2);
      expect(res.resolved).toBe(0);
    });
  });
});
