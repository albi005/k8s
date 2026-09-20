import type { AllConfig } from "renovate/dist/config/types";

export interface RenovateAppOptions {
    /** Repository that holds the ArgoCD Applications. */
    repository?: string;
    /** Bot identity used for commits/PRs. */
    gitAuthor?: string;
}

/**
 * Build the Renovate *global* config for one cdk8s app.
 *
 * Each app's `renovate.ts` is passed via `RENOVATE_CONFIG_FILE` by
 * `.dev/renovate.ts`. Renovate runs in the app's own CI (see PLAN.md), opens a
 * PR against kir-dev/k8s updating `<app>/versions.ts`, and only that file: the
 * custom regex manager is scoped to it and every other manager is disabled.
 *
 * `versions.ts` entries are `owner/image:tag@sha256:...` strings, so the
 * `docker` datasource + `pinDigests` keeps both the tag and the digest current.
 */
export function appConfig(app: string, options: RenovateAppOptions = {}): AllConfig {
    const repository = options.repository ?? "kir-dev/k8s";
    const gitAuthor = options.gitAuthor ?? "Kir-Dev Bot <258595904+kir-dev-bot@users.noreply.github.com>";

    return {
        platform: "github",
        onboarding: false,
        requireConfig: "optional",
        gitAuthor,
        token: process.env.RENOVATE_TOKEN,
        repositories: [
            {
                repository,
                enabledManagers: ["custom.regex"],
                customManagers: [
                    {
                        customType: "regex",
                        managerFilePatterns: [`/^${app}\\/versions\\.ts$/`],
                        matchStrings: [
                            `['"](?<depName>[^@'"\\s]+):(?<currentValue>[^@'"\\s]+)(?:@(?<currentDigest>sha256:[a-f0-9]{64}))?['"]`,
                        ],
                        datasourceTemplate: "docker",
                        versioningTemplate: "docker",
                    },
                ],
                packageRules: [
                    {
                        matchManagers: ["custom.regex"],
                        groupName: `${app} images`,
                        pinDigests: true,
                    },
                ],
            },
        ],
    };
}
