// https://github.com/kir-dev/ehk
//
// https://ehk.kir-dev.hu
//
// Next.js + Payload CMS (Postgres) application.

import * as kube from "../imports/k8s";
import * as environment from "../.dev/environment.ts";
import * as cnpg from "../imports/postgresql.cnpg.io.ts";
import { versions } from "./versions.ts";
import { singletonApp } from "../.dev/cdk8s-utils.ts";

export default singletonApp({ namespace: "ehk", createNamespace: true }, (scope) => {
    const labels = {
        "app.kubernetes.io/name": "ehk",
        "app.kubernetes.io/instance": "ehk",
        "app.kubernetes.io/component": "server",
        "app.kubernetes.io/part-of": "ehk",
    };

    new kube.KubeConfigMap(scope, "ehk-config", {
        metadata: {
            name: "ehk-config",
            annotations: { "argocd.argoproj.io/sync-wave": "-25" },
        },
        data: {
            NODE_ENV: "production",
            NEXT_TELEMETRY_DISABLED: "1",
        },
    });

    // Set manually in production:
    //   PAYLOAD_SECRET:
    //   S3_BUCKET:
    //   S3_ACCESS_KEY_ID:
    //   S3_SECRET_ACCESS_KEY:
    //   S3_REGION:
    //   S3_ENDPOINT:
    new kube.KubeSecret(scope, "ehk-secrets", {
        metadata: {
            name: "ehk-secrets",
            annotations: { "argocd.argoproj.io/sync-wave": "-25" },
        },
        ...(environment.environment != "Production"
            ? {
                  stringData: {
                      PAYLOAD_SECRET: "local-development-secret",
                      S3_BUCKET: "ehk-media",
                      S3_ACCESS_KEY_ID: "local",
                      S3_SECRET_ACCESS_KEY: "localpass",
                      S3_REGION: "us-east-1",
                      S3_ENDPOINT: "http://ehk-minio:9000",
                  },
              }
            : {}),
    });

    new cnpg.Cluster(scope, "ehk-db", {
        metadata: {
            name: "ehk-db",
            labels: {
                "app.kubernetes.io/name": "postgres",
                "app.kubernetes.io/instance": "postgres-ehk",
                "app.kubernetes.io/component": "database",
                "app.kubernetes.io/part-of": "ehk",
            },
            annotations: { "argocd.argoproj.io/sync-wave": "-20" },
        },
        spec: {
            primaryUpdateStrategy: cnpg.ClusterSpecPrimaryUpdateStrategy.UNSUPERVISED,
            primaryUpdateMethod: cnpg.ClusterSpecPrimaryUpdateMethod.SWITCHOVER,
            instances: 2,
            imageName: "ghcr.io/cloudnative-pg/postgresql:17.5",
            imagePullPolicy: "IfNotPresent",
            monitoring: { enablePodMonitor: true },
            postgresql: {
                parameters: {
                    wal_level: "replica",
                    shared_buffers: "128MB",
                },
            },
            resources: {
                limits: {
                    cpu: cnpg.ClusterSpecResourcesLimits.fromString("500m"),
                    memory: cnpg.ClusterSpecResourcesLimits.fromString("512Mi"),
                    "ephemeral-storage": cnpg.ClusterSpecResourcesLimits.fromString("500Mi"),
                },
                requests: {
                    cpu: cnpg.ClusterSpecResourcesRequests.fromString("100m"),
                    memory: cnpg.ClusterSpecResourcesRequests.fromString("128Mi"),
                    "ephemeral-storage": cnpg.ClusterSpecResourcesRequests.fromString("100Mi"),
                },
            },
            storage: {
                size: "1.5Gi",
                storageClass: "node-local-zfs",
            },
            bootstrap: {
                initdb: {
                    database: "ehk",
                    owner: "ehk",
                },
            },
        },
    });

    // Apply Payload migrations before the new image starts serving traffic.
    // A Sync hook (not PreSync) is required because CNPG lives in this same
    // Application and is only created in the previous sync wave.
    new kube.KubeJob(scope, "ehk-migrate", {
        metadata: {
            name: "ehk-migrate",
            labels,
            annotations: {
                "argocd.argoproj.io/hook": "Sync",
                "argocd.argoproj.io/hook-delete-policy": "BeforeHookCreation,HookSucceeded",
                "argocd.argoproj.io/sync-wave": "-10",
            },
        },
        spec: {
            backoffLimit: 1,
            activeDeadlineSeconds: 600,
            template: {
                metadata: { labels },
                spec: {
                    restartPolicy: "Never",
                    automountServiceAccountToken: false,
                    initContainers: [
                        {
                            name: "wait-for-database",
                            image: "ghcr.io/cloudnative-pg/postgresql:17.5",
                            imagePullPolicy: "IfNotPresent",
                            command: ["/bin/sh", "-ec"],
                            args: ["until pg_isready -h ehk-db-rw -p 5432 -U postgres; do sleep 2; done"],
                            resources: {
                                requests: {
                                    cpu: kube.Quantity.fromString("10m"),
                                    memory: kube.Quantity.fromString("16Mi"),
                                    "ephemeral-storage": kube.Quantity.fromString("5Mi"),
                                },
                                limits: {
                                    cpu: kube.Quantity.fromString("50m"),
                                    memory: kube.Quantity.fromString("32Mi"),
                                    "ephemeral-storage": kube.Quantity.fromString("20Mi"),
                                },
                            },
                        },
                    ],
                    containers: [
                        {
                            name: "migrate",
                            image: versions.image,
                            imagePullPolicy: "IfNotPresent",
                            command: ["yarn", "migrate"],
                            env: [
                                {
                                    name: "DATABASE_URI",
                                    valueFrom: { secretKeyRef: { name: "ehk-db-app", key: "uri" } },
                                },
                                {
                                    name: "PAYLOAD_SECRET",
                                    valueFrom: { secretKeyRef: { name: "ehk-secrets", key: "PAYLOAD_SECRET" } },
                                },
                            ],
                            resources: {
                                requests: {
                                    cpu: kube.Quantity.fromString("50m"),
                                    memory: kube.Quantity.fromString("128Mi"),
                                    "ephemeral-storage": kube.Quantity.fromString("20Mi"),
                                },
                                limits: {
                                    cpu: kube.Quantity.fromString("250m"),
                                    memory: kube.Quantity.fromString("512Mi"),
                                    "ephemeral-storage": kube.Quantity.fromString("100Mi"),
                                },
                            },
                        },
                    ],
                },
            },
        },
    });

    if (environment.environment != "Production") {
        // Local S3-compatible object storage for the `media` collection.
        // Production uses an external bucket configured via `ehk-secrets`.
        const minioLabels = { "app.kubernetes.io/name": "ehk-minio", "app.kubernetes.io/part-of": "ehk" };
        new kube.KubeDeployment(scope, "ehk-minio", {
            metadata: { name: "ehk-minio", labels: minioLabels },
            spec: {
                replicas: 1,
                selector: { matchLabels: { "app.kubernetes.io/name": "ehk-minio" } },
                template: {
                    metadata: { labels: minioLabels },
                    spec: {
                        containers: [
                            {
                                name: "minio",
                                image: versions.minio,
                                imagePullPolicy: "IfNotPresent",
                                args: ["server", "/data", "--console-address", ":9001"],
                                env: [
                                    {
                                        name: "MINIO_ROOT_USER",
                                        valueFrom: {
                                            secretKeyRef: { name: "ehk-secrets", key: "S3_ACCESS_KEY_ID" },
                                        },
                                    },
                                    {
                                        name: "MINIO_ROOT_PASSWORD",
                                        valueFrom: {
                                            secretKeyRef: { name: "ehk-secrets", key: "S3_SECRET_ACCESS_KEY" },
                                        },
                                    },
                                ],
                                ports: [
                                    { name: "api", containerPort: 9000 },
                                    { name: "console", containerPort: 9001 },
                                ],
                                resources: {
                                    requests: {
                                        cpu: kube.Quantity.fromString("50m"),
                                        memory: kube.Quantity.fromString("128Mi"),
                                        "ephemeral-storage": kube.Quantity.fromString("0"),
                                    },
                                    limits: {
                                        cpu: kube.Quantity.fromString("500m"),
                                        memory: kube.Quantity.fromString("512Mi"),
                                        "ephemeral-storage": kube.Quantity.fromString("500Mi"),
                                    },
                                },
                                volumeMounts: [{ name: "data", mountPath: "/data" }],
                            },
                        ],
                        volumes: [{ name: "data", emptyDir: {} }],
                    },
                },
            },
        });

        new kube.KubeService(scope, "ehk-minio-service", {
            metadata: { name: "ehk-minio", labels: minioLabels },
            spec: {
                selector: { "app.kubernetes.io/name": "ehk-minio" },
                ports: [{ name: "http", port: 9000, targetPort: kube.IntOrString.fromNumber(9000) }],
            },
        });

        new kube.KubeJob(scope, "ehk-minio-bucket", {
            metadata: { name: "ehk-minio-bucket", labels: minioLabels },
            spec: {
                backoffLimit: 5,
                template: {
                    metadata: { labels: minioLabels },
                    spec: {
                        restartPolicy: "Never",
                        containers: [
                            {
                                name: "create-bucket",
                                image: versions.minioClient,
                                imagePullPolicy: "IfNotPresent",
                                command: ["/bin/sh", "-ec"],
                                args: [
                                    'until mc alias set local http://ehk-minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"; do sleep 2; done; mc mb --ignore-existing local/ehk-media',
                                ],
                                env: [
                                    {
                                        name: "MINIO_ROOT_USER",
                                        valueFrom: {
                                            secretKeyRef: { name: "ehk-secrets", key: "S3_ACCESS_KEY_ID" },
                                        },
                                    },
                                    {
                                        name: "MINIO_ROOT_PASSWORD",
                                        valueFrom: {
                                            secretKeyRef: { name: "ehk-secrets", key: "S3_SECRET_ACCESS_KEY" },
                                        },
                                    },
                                ],
                                resources: {
                                    requests: {
                                        cpu: kube.Quantity.fromString("10m"),
                                        memory: kube.Quantity.fromString("16Mi"),
                                        "ephemeral-storage": kube.Quantity.fromString("0"),
                                    },
                                    limits: {
                                        cpu: kube.Quantity.fromString("100m"),
                                        memory: kube.Quantity.fromString("64Mi"),
                                        "ephemeral-storage": kube.Quantity.fromString("50Mi"),
                                    },
                                },
                            },
                        ],
                    },
                },
            },
        });
    }

    new kube.KubeService(scope, "ehk-service", {
        metadata: { name: "ehk", labels },
        spec: {
            selector: labels,
            ports: [{ name: "http", port: 80, targetPort: kube.IntOrString.fromString("http") }],
        },
    });

    new kube.KubeDeployment(scope, "ehk-deployment", {
        metadata: { name: "ehk", labels },
        spec: {
            replicas: 1,
            selector: { matchLabels: labels },
            template: {
                metadata: { labels },
                spec: {
                    automountServiceAccountToken: false,
                    containers: [
                        {
                            name: "ehk",
                            image: versions.image,
                            imagePullPolicy: "IfNotPresent",
                            ports: [{ containerPort: 3000, protocol: "TCP", name: "http" }],
                            env: [
                                {
                                    name: "DATABASE_URI",
                                    valueFrom: { secretKeyRef: { name: "ehk-db-app", key: "uri" } },
                                },
                                {
                                    name: "PAYLOAD_SECRET",
                                    valueFrom: { secretKeyRef: { name: "ehk-secrets", key: "PAYLOAD_SECRET" } },
                                },
                                {
                                    name: "S3_BUCKET",
                                    valueFrom: { secretKeyRef: { name: "ehk-secrets", key: "S3_BUCKET" } },
                                },
                                {
                                    name: "S3_ACCESS_KEY_ID",
                                    valueFrom: { secretKeyRef: { name: "ehk-secrets", key: "S3_ACCESS_KEY_ID" } },
                                },
                                {
                                    name: "S3_SECRET_ACCESS_KEY",
                                    valueFrom: { secretKeyRef: { name: "ehk-secrets", key: "S3_SECRET_ACCESS_KEY" } },
                                },
                                {
                                    name: "S3_REGION",
                                    valueFrom: { secretKeyRef: { name: "ehk-secrets", key: "S3_REGION" } },
                                },
                                {
                                    name: "S3_ENDPOINT",
                                    valueFrom: { secretKeyRef: { name: "ehk-secrets", key: "S3_ENDPOINT" } },
                                },
                            ],
                            envFrom: [{ configMapRef: { name: "ehk-config" } }],
                            startupProbe: {
                                tcpSocket: { port: kube.IntOrString.fromString("http") },
                                periodSeconds: 5,
                                failureThreshold: 60,
                            },
                            readinessProbe: {
                                tcpSocket: { port: kube.IntOrString.fromString("http") },
                                periodSeconds: 10,
                                timeoutSeconds: 3,
                                failureThreshold: 3,
                            },
                            livenessProbe: {
                                tcpSocket: { port: kube.IntOrString.fromString("http") },
                                periodSeconds: 20,
                                timeoutSeconds: 3,
                                failureThreshold: 6,
                            },
                            resources: {
                                limits: {
                                    cpu: kube.Quantity.fromString("1000m"),
                                    memory: kube.Quantity.fromString("1Gi"),
                                    "ephemeral-storage": kube.Quantity.fromString("500Mi"),
                                },
                                requests: {
                                    cpu: kube.Quantity.fromString("100m"),
                                    memory: kube.Quantity.fromString("256Mi"),
                                    "ephemeral-storage": kube.Quantity.fromString("0"),
                                },
                            },
                        },
                    ],
                    restartPolicy: "Always",
                },
            },
        },
    });

    new kube.KubeIngress(scope, "ehk-ingress", {
        metadata: {
            name: "ehk",
            labels,
            annotations: {
                "cert-manager.io/cluster-issuer": "letsencrypt",
                "acme.cert-manager.io/http01-ingress-class": "traefik",
            },
        },
        spec: {
            ingressClassName: "traefik",
            tls: [{ hosts: ["ehk.kir-dev.hu"], secretName: "ehk-tls-cert" }],
            rules: [
                {
                    host: "ehk.kir-dev.hu",
                    http: {
                        paths: [
                            {
                                path: "/",
                                pathType: "Prefix",
                                backend: { service: { name: "ehk", port: { name: "http" } } },
                            },
                        ],
                    },
                },
            ],
        },
    });
});
