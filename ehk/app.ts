// https://github.com/kir-dev/ehk
//
// https://ehk.kir-dev.hu
//
// Next.js + Payload CMS (Postgres) application.

import { ApiObject } from "cdk8s";
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
            S3_BUCKET: "ehk-media",
            S3_REGION: "us-east-1",
            S3_ENDPOINT: "http://ehk-seaweed-filer:8333",
        },
    });

    // Set manually in production:
    //   PAYLOAD_SECRET:
    // S3 credentials are managed by the seaweedfs-operator in the
    // `ehk-seaweed-s3` secret (see the Seaweed cluster below).
    new kube.KubeSecret(scope, "ehk-secrets", {
        metadata: {
            name: "ehk-secrets",
            annotations: { "argocd.argoproj.io/sync-wave": "-25" },
        },
        ...(environment.environment != "Production"
            ? {
                  stringData: {
                      PAYLOAD_SECRET: "local-development-secret",
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

    // Self-hosted S3-compatible object storage for the `media` collection,
    // managed by the seaweedfs-operator (see the `seaweedfs-operator` app).
    // S3 and IAM share the filer service on port 8333.
    const seaweedLabels = { "app.kubernetes.io/name": "ehk-seaweed", "app.kubernetes.io/part-of": "ehk" };
    const storageClassName = "node-local-zfs";
    const persistence = (storage: string) =>
        ({ enabled: true, storageClassName, resources: { requests: { storage } } }) as const;

    new ApiObject(scope, "ehk-seaweed", {
        apiVersion: "seaweed.seaweedfs.com/v1",
        kind: "Seaweed",
        metadata: { name: "ehk-seaweed", labels: seaweedLabels },
        spec: {
            image: versions.seaweedfs,
            imagePullPolicy: "IfNotPresent",
            volumeServerDiskCount: 1,
            master: {
                replicas: 1,
                persistence: persistence("1Gi"),
                requests: { cpu: "50m", memory: "128Mi", "ephemeral-storage": "0" },
                limits: { cpu: "500m", memory: "512Mi", "ephemeral-storage": "200Mi" },
            },
            volume: {
                replicas: 1,
                storageClassName,
                requests: { storage: "2Gi", cpu: "50m", memory: "128Mi", "ephemeral-storage": "0" },
                limits: { cpu: "500m", memory: "512Mi", "ephemeral-storage": "500Mi" },
            },
            filer: {
                replicas: 1,
                iam: true,
                s3: { enabled: true },
                // IAM objects created through the API (and the CRDs below) need
                // write access; without this the operator cannot register them.
                extraArgs: ["-s3.iam.readOnly=false"],
                persistence: persistence("1Gi"),
                requests: { cpu: "50m", memory: "128Mi", "ephemeral-storage": "0" },
                limits: { cpu: "500m", memory: "512Mi", "ephemeral-storage": "200Mi" },
            },
        },
    });

    // S3 identity and credentials. The operator generates the key pair into the
    // `ehk-seaweed-s3` secret (keys `accessKey`/`secretKey`), which the app mounts.
    new ApiObject(scope, "ehk-seaweed-identity", {
        apiVersion: "seaweed.seaweedfs.com/v1",
        kind: "S3Identity",
        metadata: { name: "ehk", labels: seaweedLabels },
        spec: { seaweedRef: { name: "ehk-seaweed" } },
    });

    new ApiObject(scope, "ehk-seaweed-credentials", {
        apiVersion: "seaweed.seaweedfs.com/v1",
        kind: "S3Credentials",
        metadata: { name: "ehk-seaweed-credentials", labels: seaweedLabels },
        spec: {
            seaweedRef: { name: "ehk-seaweed" },
            identityRef: { name: "ehk" },
            secretRef: { name: "ehk-seaweed-s3" },
        },
    });

    new ApiObject(scope, "ehk-media-bucket", {
        apiVersion: "seaweed.seaweedfs.com/v1",
        kind: "Bucket",
        metadata: { name: "ehk-media", labels: seaweedLabels },
        spec: { clusterRef: { name: "ehk-seaweed" } },
    });

    new ApiObject(scope, "ehk-media-policy", {
        apiVersion: "seaweed.seaweedfs.com/v1",
        kind: "S3Policy",
        metadata: { name: "ehk-media", labels: seaweedLabels },
        spec: {
            seaweedRef: { name: "ehk-seaweed" },
            statements: [
                {
                    effect: "Allow",
                    actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
                    resources: ["ehk-media", "ehk-media/*"],
                },
            ],
        },
    });

    new ApiObject(scope, "ehk-media-policy-binding", {
        apiVersion: "seaweed.seaweedfs.com/v1",
        kind: "S3PolicyBinding",
        metadata: { name: "ehk-media", labels: seaweedLabels },
        spec: {
            seaweedRef: { name: "ehk-seaweed" },
            policyRef: { name: "ehk-media" },
            subjects: [{ kind: "S3Identity", name: "ehk" }],
        },
    });

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
                                    name: "S3_ACCESS_KEY_ID",
                                    valueFrom: { secretKeyRef: { name: "ehk-seaweed-s3", key: "accessKey" } },
                                },
                                {
                                    name: "S3_SECRET_ACCESS_KEY",
                                    valueFrom: { secretKeyRef: { name: "ehk-seaweed-s3", key: "secretKey" } },
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
