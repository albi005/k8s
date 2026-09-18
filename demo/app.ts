import { Construct } from 'constructs';
import { App, Chart } from 'cdk8s';
import { KubeDeployment, KubeNamespace, KubeService, Quantity } from '../imports/k8s';
import { versions } from './versions.ts';

/**
 * A trivial cdk8s app that renders a Deployment + Service, proving that
 * ArgoCD can synthesize and apply cdk8s manifests through the `cdk8s`
 * Config Management Plugin.
 */
class DemoChart extends Chart {
  constructor(scope: Construct, ns: string) {
    super(scope, ns);

    new KubeNamespace(this, 'demo-namespace', { metadata: { name: 'demo' } });

    const labels = { app: 'demo' };
    const metadata = { name: 'demo', namespace: 'demo', labels };

    new KubeDeployment(this, 'demo-deployment', {
      metadata,
      spec: {
        replicas: 2,
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            containers: [
              {
                name: 'demo',
                image: versions.image,
                ports: [{ containerPort: 80 }],
                resources: {
                  requests: {
                    cpu: Quantity.fromString('10m'),
                    memory: Quantity.fromString('32Mi'),
                  },
                  limits: {
                    cpu: Quantity.fromString('100m'),
                    memory: Quantity.fromString('128Mi'),
                    'ephemeral-storage': Quantity.fromString('50Mi'),
                  },
                },
              },
            ],
          },
        },
      },
    });

    new KubeService(this, 'demo-service', {
      metadata,
      spec: {
        selector: labels,
        ports: [{ port: 80, targetPort: 80 }],
      },
    });
  }
}

const app = new App();
new DemoChart(app, 'demo');

export default app;
