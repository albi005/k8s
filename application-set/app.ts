import { Construct } from "constructs";
import { App, Chart } from "cdk8s";
import { ApplicationSet } from "../imports/argoproj.io";
import * as environment from "../.dev/environment.ts";

class AppSetChart extends Chart {
    constructor(scope: Construct, id: string) {
        super(scope, id);

        new ApplicationSet(this, "apps", {
            metadata: {
                name: "apps",
                namespace: "argocd",
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
                                // exclude directories starting with .
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
                            repoUrl,
                            targetRevision: revision,
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
    }
}

const app = new App();
new AppSetChart(app, "application-set", await sourceRepoUrl(), await sourceRevision());

export default app;
