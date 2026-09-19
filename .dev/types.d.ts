/**
 * Renovate is run via `bunx renovate@<pin>` (see .dev/renovate.ts) instead of
 * being installed, so its real types aren't on disk. This declares just the
 * shape `.dev/renovate-config.ts` imports.
 */
declare module "renovate/dist/config/types" {
    export interface AllConfig {
        platform?: string;
        token?: string;
        onboarding?: boolean;
        requireConfig?: string;
        gitAuthor?: string;
        repositories?: unknown[];
        [key: string]: unknown;
    }
}
