# The companion that ships a MariaDB's binary logs off the cluster.
#
# Built FROM the server's own image, and pinned to the same major, because
# `mariadb-backup` must match the server it reads: a base backup taken with one
# major does not open under another, and that mismatch surfaces during a
# recovery. Taking the tools from the same image the database runs makes the
# match a property of the tag rather than something to keep in step by hand.
# The same holds for `mariadb-binlog`, which has to understand the log format
# it is reading.
#
# Rebuild this per MariaDB major the catalog offers: `mariadb-shipper:11`
# follows `mariadb:11-jammy`. Forgetting to is a shipper that will not start —
# loud — rather than a backup that quietly stops being taken.
ARG MARIADB_MAJOR=11
FROM docker.io/library/mariadb:${MARIADB_MAJOR}-jammy

# Copied from the image already pinned for the copy pod rather than downloaded:
# one rclone version across the whole product, a reproducible build, and no
# network at build time beyond the registry. The official MariaDB image ships
# no curl or wget to download it with anyway.
COPY --from=docker.io/rclone/rclone:1.67 /usr/local/bin/rclone /usr/local/bin/rclone

# Nothing else is added: `mariadb`, `mariadb-backup`, `mariadb-binlog` and
# `gosu` are already in the base, and so is the CA bundle TLS to object storage
# needs, at /etc/ssl/certs/ca-certificates.crt.
COPY ship.sh /usr/local/bin/ship.sh
# The restore half: run as an init container before a fresh server starts, so
# the volume already holds the recovered state by the time MariaDB boots.
COPY restore.sh /usr/local/bin/restore.sh

RUN set -eux; \
    chmod 0755 /usr/local/bin/ship.sh /usr/local/bin/restore.sh /usr/local/bin/rclone; \
    rclone version; \
    mariadb-backup --version; \
    mariadb-binlog --version; \
    mbstream --version 2>/dev/null || true; \
    test -f /etc/ssl/certs/ca-certificates.crt

ENTRYPOINT ["/usr/local/bin/ship.sh"]
