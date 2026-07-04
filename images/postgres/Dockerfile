# Flui-managed Postgres: postgres 17 + pgBackRest, born migratable.
# pgBackRest comes from the PGDG apt repo (already configured in the official
# postgres:17 image) so it is new enough to support PG17 (>= 2.53).
FROM docker.io/library/postgres:17

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends pgbackrest ca-certificates; \
    update-ca-certificates; \
    rm -rf /var/lib/apt/lists/*; \
    pgbackrest version; \
    test -f /etc/ssl/certs/ca-certificates.crt

# Born-migratable defaults, included from postgresql.conf; overridable by ALTER SYSTEM.
COPY postgresql.flui.conf /etc/flui/postgresql.flui.conf
# First-init hook: make the generated postgresql.conf include the flui base config.
COPY 00-flui-conf.sh /docker-entrypoint-initdb.d/00-flui-conf.sh
# Wrapper entrypoint: adds a restore-bootstrap mode, then delegates to the stock entrypoint.
COPY flui-entrypoint.sh /usr/local/bin/flui-entrypoint.sh

RUN chmod 0644 /etc/flui/postgresql.flui.conf \
    && chmod 0755 /docker-entrypoint-initdb.d/00-flui-conf.sh /usr/local/bin/flui-entrypoint.sh

ENTRYPOINT ["flui-entrypoint.sh"]
CMD ["postgres"]
