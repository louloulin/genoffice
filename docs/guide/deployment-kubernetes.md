# Deployment: Kubernetes

A minimal Deployment + Service + Ingress.

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

## Scaling notes

The bundled server is stateless; horizontal scaling is safe as long as
`/data` is shared (NFS / ReadWriteMany PVC) or replaced with an
external storage backend (S3, MinIO, GCS).

For multi-replica deployments without shared storage, configure the
[storage backend](https://github.com/genspark-ai/genoffice/tree/main/packages/file-management)
to point at S3 / MinIO and disable the local file watcher.
