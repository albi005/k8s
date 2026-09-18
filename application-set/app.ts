import { Construct } from 'constructs';
import { App, Chart } from 'cdk8s';
import { ApplicationSet, type ApplicationSetSpec } from '../imports/argoproj.io';
import { sourceRepoUrl, sourceRevision } from '../.dev/is-local.ts';

/**
 * The app-of-apps ApplicationSet.
 *
 * Every top-level directory except dotdirs (`.dev`, `.vclusters`, ...) becomes
 * an ArgoCD Application. This ApplicationSet is itself managed by ArgoCD (it
 * carries the `application-set` directory), so the bootstrap copy is applied
 * once by `local-cluster:up` / an admin and then kept in sync.
 *
 * `sourceRepoUrl()`/`sourceRevision()` make it render against
 * github.com/kir-dev/k8s in prod and against the local git daemon's
 * `argocd-head` branch when `isLocal()`.
 */
class AppSetChart extends Chart {
  constructor(scope: Construct, id: string, repoUrl: string, revision: string) {
    super(scope, id);

    const spec: ApplicationSetSpec = {
      goTemplate: true,
      goTemplateOptions: ['missingkey=error'],
      generators: [
        {
          git: {
            repoUrl,
            revision,
            directories: [
              { path: '*' },
              { path: '.*', exclude: true },
            ],
          },
        },
      ],
      template: {
        metadata: {
          name: '{{.path.basename}}',
          finalizers: ['resources-finalizer.argocd.argoproj.io'],
        },
        spec: {
          project: 'default',
          source: {
            repoUrl,
            targetRevision: revision,
            path: '{{.path.path}}',
          },
          destination: { name: 'in-cluster' },
          syncPolicy: {
            automated: { prune: true, selfHeal: true },
            syncOptions: ['ServerSideApply=true', 'CreateNamespace=true'],
          },
        },
      },
    };

    new ApplicationSet(this, 'apps', {
      metadata: { name: 'apps', namespace: 'argocd' },
      spec,
    });
  }
}

const app = new App();
new AppSetChart(app, 'application-set', await sourceRepoUrl(), await sourceRevision());

export default app;
