import { IAM_PERMISSION } from './iam-permissions';
import { APP_TAB, tabsForPermissions } from './iam-tabs';

describe('the tabs an application opens', () => {
  const reader = new Set<string>([IAM_PERMISSION.APP_READ]);

  it('gives a reader of an ordinary application only what reading allows', () => {
    const tabs = tabsForPermissions(reader);
    expect(tabs).not.toContain(APP_TAB.RELEASES);
    expect(tabs).not.toContain(APP_TAB.RESOURCES);
    expect(tabs).not.toContain(APP_TAB.LOGS);
  });

  it('shows a reader of the showcase how it is sized, where it answers and its logs', () => {
    const tabs = tabsForPermissions(reader, { showcase: true });
    expect(tabs).toEqual(
      expect.arrayContaining([
        APP_TAB.OVERVIEW,
        APP_TAB.RESOURCES,
        APP_TAB.DNS,
        APP_TAB.LOGS,
      ]),
    );
    expect(tabs).not.toContain(APP_TAB.RELEASES);
  });

  it('keeps the data tabs of the showcase shut without data:access', () => {
    const tabs = tabsForPermissions(reader, { showcase: true });
    for (const tab of [
      APP_TAB.CONFIGURATION,
      APP_TAB.SNAPSHOTS,
      APP_TAB.SCHEDULES,
      APP_TAB.GATEWAY,
      APP_TAB.BUILDS,
    ]) {
      expect(tabs).not.toContain(tab);
    }
  });

  it('opens the sessions of a database to a reader holding data:access, and only then', () => {
    expect(tabsForPermissions(reader)).not.toContain(APP_TAB.SESSIONS);
    expect(tabsForPermissions(reader, { showcase: true })).not.toContain(
      APP_TAB.SESSIONS,
    );
    expect(
      tabsForPermissions(
        new Set([IAM_PERMISSION.APP_READ, IAM_PERMISSION.DATA_ACCESS]),
      ),
    ).toContain(APP_TAB.SESSIONS);
  });
});
