# 部署：Kubernetes

最简的 Deployment + Service + Ingress。

## `deployment.yaml`

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: genoffice
  labels: { app: genoffice }
spec:
  replicas: 2
  selector:
    matchLabels: { app: genoffice }
  template:
    metadata:
      labels: { app: genoffice }
    spec:
      containers:
        - name: genoffice
          image: ghcr.io/genspark-ai/genoffice-web:latest
          ports:
            - containerPort: 8080
          env:
            - name: GENOFFICE_JWT_SECRET
              valueFrom:
                secretKeyRef: { name: genoffice-secrets, key: jwt-secret }
            - name: WEB_TOKEN
              valueFrom:
                secretKeyRef: { name: genoffice-secrets, key: web-token }
            - name: WEB_CORS_ORIGINS
              value: 'https://app.example.com'
          readinessProbe:
            httpGet: { path: /health, port: 8080 }
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet: { path: /health, port: 8080 }
            initialDelaySeconds: 30
            periodSeconds: 30
          resources:
            requests: { cpu: '500m', memory: '512Mi' }
            limits:   { cpu: '2',    memory: '2Gi' }
          volumeMounts:
            - name: data
              mountPath: /data
      volumes:
        - name: data
          persistentVolumeClaim: { claimName: genoffice-data }
```

## `service.yaml`

```yaml
apiVersion: v1
kind: Service
metadata: { name: genoffice }
spec:
  selector: { app: genoffice }
  ports:
    - port: 80
      targetPort: 8080
```

## `ingress.yaml`

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: genoffice
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  tls:
    - hosts: [genoffice.example.com]
      secretName: genoffice-tls
  rules:
    - host: genoffice.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service: { name: genoffice, port: { number: 80 } }
```

## `pvc.yaml`

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: genoffice-data }
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests: { storage: 50Gi }
```

## 扩缩容要点

自带服务器是无状态的；只要 `/data` 是共享的（NFS / ReadWriteMany PVC）或替换为外部存储后端（S3 / MinIO / GCS），水平扩缩就是安全的。

如果多副本部署又没有共享存储，把[存储后端](https://github.com/genspark-ai/genoffice/tree/main/packages/file-management)切到 S3 / MinIO，并关掉本地文件监听。
