import { AlertEventEntity } from '../entities/alert-event.entity';
import { alertDashboardPath } from './alert-mail.template';

const event = (fields: Partial<AlertEventEntity>) =>
  ({ labels: {}, ...fields }) as AlertEventEntity;

describe('the dashboard page an alert links to', () => {
  it('sends the registry space alert to the registry page', () => {
    expect(alertDashboardPath(event({ fluiKind: 'registry' }))).toBe(
      '/management/registry',
    );
  });

  it('still prefers the application an alert is about', () => {
    expect(
      alertDashboardPath(event({ fluiKind: 'registry', applicationId: 'a1' })),
    ).toBe('/apps/applications/a1/monitoring');
  });
});
