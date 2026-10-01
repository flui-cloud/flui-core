import { parseRestorePoint, restorePointLabel } from './restore-point.util';

describe('restore points', () => {
  it('names a restore point with nothing a quoted literal could break on', () => {
    expect(restorePointLabel("9e5b'17a1; DROP")).toBe(
      'flui-before-deploy-9e5b17a1drop',
    );
    expect(restorePointLabel('')).toBe('flui-before-deploy-unknown');
  });

  it('reads the moment and the position the engine reported', () => {
    expect(
      parseRestorePoint('noise\nFLUI_RESTORE_POINT=1790000000123 0/3000090\n'),
    ).toEqual({
      at: new Date(1790000000123).toISOString(),
      position: '0/3000090',
    });
    expect(parseRestorePoint('FLUI_RESTORE_POINT=1790000000123 ')).toEqual({
      at: new Date(1790000000123).toISOString(),
    });
  });

  it('refuses to report a restore point the database did not confirm', () => {
    expect(() => parseRestorePoint('psql: error')).toThrow(
      'did not report a restore point',
    );
    expect(() => parseRestorePoint('FLUI_RESTORE_POINT= ')).toThrow();
  });
});
