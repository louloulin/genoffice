# 部署：Docker

每个 tag 版本都会发布 Docker 镜像到
`ghcr.io/genspark-ai/genoffice-web:latest`。

## `docker run`（单实例）

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

验证：

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

## 反向代理（Caddy）

```caddyfile
genoffice.example.com {
  reverse_proxy genoffice:8080
  encode zstd gzip
  header Strict-Transport-Security "max-age=31536000; includeSubDomains"
  header X-Content-Type-Options "nosniff"
  header Referrer-Policy "no-referrer"
}
```

## 备份 `DATA_DIR`

数据目录包含：

- `files/` — 上传的文件（按 recents 键索引）。
- `webhooks.json` — webhook 注册表。
- `projects.json` — 项目元数据。
- `recents/` — recents 簿记。
- `unified-recents.json` — 统一 recents 存储。
- `kb/` · `tm/` — KB / TM 归档。
- `snapshots/` — workbook 保存快照。

用你既有的快照策略备份（如 `restic` / EBS 快照）。任意时间点还原很直接——无需协调外部数据库。

## 健康检查

```sh
docker exec genoffice \
  curl -fsS http://localhost:8080/health || exit 1
```

把它加进 Dockerfile 或 compose 的 `HEALTHCHECK` 即可。
