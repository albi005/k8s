import { $ } from "bun";
import { App } from "cdk8s";

export async function kubectlApplyYaml(yaml: string) {
    await $`kubectl apply -f - < ${Buffer.from(yaml)}`;
}

export async function kubectlApplyCdk8sApp(app: App) {
    await kubectlApplyYaml(app.synthYaml());
}
