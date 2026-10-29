import { NFS_EXPORT_OPTIONS, nfsDurability } from './storage-conventions';

describe('what the shared storage promises about a confirmed write', () => {
  /** The master answers before the disk does, so a crash can take the newest writes with it. */
  it('says recent writes can be lost while the export confirms before the disk', () => {
    expect(nfsDurability(NFS_EXPORT_OPTIONS)).toEqual({
      confirmsBeforeDisk: true,
      durability:
        "Writes are confirmed before they reach the master's disk: if the master stops abruptly, the most recent ones can be lost. Keep databases on dedicated storage.",
    });
  });

  it('says writes are safe once the export waits for the disk', () => {
    expect(nfsDurability('rw,sync,no_subtree_check,no_root_squash')).toEqual({
      confirmsBeforeDisk: false,
      durability: "Writes are confirmed once they are on the master's disk.",
    });
  });

  it('reads the option itself, not a substring of another one', () => {
    expect(nfsDurability('rw, async ,no_root_squash').confirmsBeforeDisk).toBe(
      true,
    );
    expect(nfsDurability('rw,no_async_hint').confirmsBeforeDisk).toBe(false);
  });
});
