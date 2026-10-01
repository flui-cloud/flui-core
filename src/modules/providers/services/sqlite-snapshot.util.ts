/**
 * A consistent copy of every SQLite file on a volume that is being written.
 *
 * A file copy of a live SQLite database can be torn: the copy tool reads a
 * page, the application commits, the next page read belongs to a later state.
 * SQLite's own online backup reads the whole database under its locking
 * protocol and writes a self-contained file, so the copy restores to one
 * moment. Python's standard library carries that API, which is why the step
 * runs in a Python image rather than asking the application's image for a
 * `sqlite3` binary it may not ship.
 *
 * The step writes the snapshots under `/stage/data`, mirroring their paths,
 * plus two lists: rclone filter rules that keep the live files out of an
 * upload, and the journal files a local copy has to delete after it lands.
 */
export const SQLITE_SNAPSHOT_IMAGE = 'python:3.12-alpine';

const SNAPSHOT_PY = String.raw`
import os, sqlite3
SRC, OUT = "/src", "/stage/data"
os.makedirs(OUT, exist_ok=True)
def rclone_rule(rel):
    return "".join("\\" + c if c in "[]*?{}\\" else c for c in rel)
count = 0
with open("/stage/excludes", "w") as ex, open("/stage/remove", "w") as rm:
    for root, _dirs, files in os.walk(SRC):
        for name in files:
            path = os.path.join(root, name)
            try:
                with open(path, "rb") as fh:
                    if fh.read(16) != b"SQLite format 3\x00":
                        continue
            except OSError:
                continue
            rel = os.path.relpath(path, SRC)
            dst = os.path.join(OUT, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            src = sqlite3.connect("file:" + path + "?mode=ro", uri=True, timeout=120)
            out = sqlite3.connect(dst)
            with out:
                src.backup(out)
            out.close()
            src.close()
            st = os.stat(path)
            os.chown(dst, st.st_uid, st.st_gid)
            os.chmod(dst, st.st_mode & 0o7777)
            for suffix in ("", "-wal", "-shm", "-journal"):
                ex.write("- /" + rclone_rule(rel + suffix) + "\n")
            for suffix in ("-wal", "-shm", "-journal"):
                rm.write(rel + suffix + "\n")
            count += 1
print("FLUI_SQLITE_SNAPSHOTS=%d" % count)
`;

/** YAML lines for the init container, indented for a pod spec's list. */
export function renderSqliteSnapshotInit(): string[] {
  const b64 = Buffer.from(SNAPSHOT_PY, 'utf-8').toString('base64');
  return [
    '      initContainers:',
    '        - name: sqlite-snapshot',
    `          image: ${SQLITE_SNAPSHOT_IMAGE}`,
    '          command:',
    '            - /bin/sh',
    '            - -c',
    `            - 'echo ${b64} | base64 -d | python3 -'`,
    '          volumeMounts:',
    // Writable: a reader of a database in WAL mode needs its shared-memory
    // file to take part in the locking protocol with the live writer.
    '            - name: src',
    '              mountPath: /src',
    '            - name: stage',
    '              mountPath: /stage',
  ];
}

export function renderSqliteStageVolume(): string[] {
  return ['        - name: stage', '          emptyDir: {}'];
}

/** Local copy: overwrite the torn files with the snapshots, drop their journals. */
export const SQLITE_LOCAL_FINISH =
  'while IFS= read -r f; do rm -f "/dst/$f"; done < /stage/remove; cp -a /stage/data/. /dst/';

/** The same init container as an object, for Jobs rendered as JSON. */
export function sqliteSnapshotInitContainer(): Record<string, unknown> {
  const b64 = Buffer.from(SNAPSHOT_PY, 'utf-8').toString('base64');
  return {
    name: 'sqlite-snapshot',
    image: SQLITE_SNAPSHOT_IMAGE,
    command: ['/bin/sh', '-c', `echo ${b64} | base64 -d | python3 -`],
    volumeMounts: [
      { name: 'src', mountPath: '/src' },
      { name: 'stage', mountPath: '/stage' },
    ],
  };
}
