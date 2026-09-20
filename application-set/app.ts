import { ApplicationSet } from "../imports/argoproj.io";
import * as environment from "../.dev/environment.ts";
import { k8sRepoRevision, k8sRepoUrl } from "../.dev/environment.ts";
import { singletonApp } from "../.dev/cdk8s-utils.ts";

export default singletonApp("argocd", (scope) => {
    new ApplicationSet(scope, "application-set", {
        metadata: {
            name: "application-set",
        },
        spec: {
            goTemplate: true,
            goTemplateOptions: ["missingkey=error"],
            generators: [
                {
                    git: {
                        repoUrl: environment.k8sRepoUrl,
                        revision: environment.k8sRepoRevision ?? "HEAD",
                        directories: [
                            // include all directories
                            {
                                path: "*",
                            },
                            // exclude .directories
                            {
                                path: ".*",
                                exclude: true,
                            },
                        ],
                    },
                },
            ],
            template: {
                metadata: {
                    name: "{{.path.basename}}",
                    finalizers: ["resources-finalizer.argocd.argoproj.io"],
                },
                spec: {
                    project: "default",
                    source: {
                        repoUrl: k8sRepoUrl,
                        targetRevision: k8sRepoRevision,
                        path: "{{.path.path}}",
                    },
                    destination: { name: "in-cluster" },
                    syncPolicy: {
                        automated: {
                            prune: true,
                            selfHeal: true,
                        },
                        syncOptions: ["ServerSideApply=true", "CreateNamespace=true"],
                    },
                },
            },
        },
    });
});
