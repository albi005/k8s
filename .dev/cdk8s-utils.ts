import { App, Chart } from "cdk8s";
import { Construct } from "constructs";

// Helper for cdk8s apps that can only have a single instance in the cluster.
//
// Always specify resource names so that cdk8s doesn't generate it.
export function singletonApp(namespace: string, factory: (scope: Construct) => void): App {
    const app = new App();
    const chart = new Chart(app, "chart", { namespace });
    factory(chart);
    return app;
}
