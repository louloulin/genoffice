# Deployment: Docker

The Docker image is published as
`ghcr.io/genspark-ai/genoffice-web:latest` on every tagged release.

## `docker run` (single instance)

```sh
docker run -d \
  --name genoffice \
  --restart unless-stopped \
  -p 8080:8080 \
  -e GENOFFICE_JWT_SECRET=$(openssl rand -hex 32) \
  -e WEB_TOKEN=$(openssl rand -hex 32) \
  -e WEB_CORS_ORIGINS=https://app.example.com \
  -v genoffice-data:/data \
  ghcr.io/genspark-ai/genoffice-web:latest
```

Verify:

```sh
curl http://localhost:8080/health
```

## `docker-compose.yml`

```yaml
version: '3.9'
services:
  genoffice:
    image: ghcr.io/genspark-ai/genoffice-web:latest
    restart: unless-stopped
    ports:
      - '8080:8080'
    environment:
      GENOFFICE_JWT_SECRET: ${GENOFFICE_JWT_SECRET}
      WEB_TOKEN: ${WEB_TOKEN}
      WEB_CORS_ORIGINS: ${WEB_CORS_ORIGINS}
    volumes:
      - genoffice-data:/data

volumes:
  genoffice-data:
```

## Reverse proxy (Caddy)

```caddyfile
genoffice.example.com {
  reverse_proxy genoffice:8080
  encode zstd gzip
  header Strict-Transport-Security "max-age=31536000; includeSubDomains"
  header X-Content-Type-Options "nosniff"
  header Referrer-Policy "no-referrer"
}
```

## Backing up `DATA_DIR`

The data directory contains:

- `files/` — uploaded files (recents-keyed).
- `webhooks.json` — webhook registry.
- `projects.json` — project metadata.
- `recents/` — recents book-keeping.
- `unified-recents.json` — unified recents store.
- `kb/` · `tm/` — KB / TM archives.
- `snapshots/` — workbook-save snapshots.

Back up with your existing snapshot strategy (e.g. `restic`, EBS
snapshots). Point-in-time restore is straightforward — no external
database to coordinate.

## Health check

```sh
docker exec genoffice \
  curl -fsS http://localhost:8080/health || exit 1
```

Add this as a `HEALTHCHECK` in your Dockerfile or compose file.
