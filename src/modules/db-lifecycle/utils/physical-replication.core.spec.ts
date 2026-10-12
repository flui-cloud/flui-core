jest.mock('@kubernetes/client-node', () => ({}));

import {
  field,
  physicalNames,
  promotedSettingsResetSql,
  removeHbaBlockScript,
  replicationHbaScript,
} from './physical-replication.core';

describe('physical-replication.core', () => {
  it('derives every per-link name from the first 12 hex characters', () => {
    const n = physicalNames('0123-4567-89ab-cdef');
    expect(n.short).toBe('0123456789ab');
    expect(n.slot).toBe('flui_phys_0123456789ab');
    expect(n.fwdNetpol).toBe('flui-db-fwd-0123456789ab');
    expect(n.fenceMarker).toBe('flui:fence:0123456789ab');
  });

  it('reads a KEY=value line out of script output', () => {
    const out = 'noise\nFLUI_HBA_BEFORE= abc \nFLUI_HBA_AFTER=def';
    expect(field(out, 'FLUI_HBA_BEFORE')).toBe('abc');
    expect(field(out, 'FLUI_HBA_AFTER')).toBe('def');
    expect(field(out, 'MISSING')).toBeUndefined();
  });

  it('resets TLS only when Flui turned it on', () => {
    expect(promotedSettingsResetSql(true)).toContain('ALTER SYSTEM RESET ssl;');
    expect(promotedSettingsResetSql(false)).not.toContain('RESET ssl;');
  });

  it('refuses a destination that is not an IPv4 address', () => {
    expect(() => replicationHbaScript('m', 'r', '10.0.0.1; rm')).toThrow();
  });

  it('removes only the marked block', () => {
    expect(removeHbaBlockScript('flui:fwd:abc')).toContain(
      '/^# flui:fwd:abc:begin$/,/^# flui:fwd:abc:end$/d',
    );
  });
});
