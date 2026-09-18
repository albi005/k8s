/**
 * Run Renovate for a single app from that app's own CI pipeline (PLAN.md).
 *
 * Usage (in an app repository's GitHub Actions):
 *
 *   git clone https://github.com/kir-dev/k8s --depth 1
 *   cd k8s
 *   bun install
 *   bun run renovate APP_NAME
 *
 * This renders `<APP_NAME>/renovate.ts` (which typically imports
 * `appConfig()` from `.dev/renovate-config.ts`) and hands it to Renovate.
 */
import { $ } from 'bun';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Renovate's native `re2` addon is built against Node's V8 ABI and crashes
// under bun, so bunx runs it with Node (its bin shebang) rather than `--bun`.
const RENOVATE_VERSION = '44.103.0';

const app = process.argv[2];
if (!app) {
  console.error('usage: bun run renovate APP_NAME');
  process.exit(1);
}

const configFile = resolve(import.meta.dir, '..', app, 'renovate.ts');
if (!existsSync(configFile)) {
  console.error(`✗ ${configFile} does not exist`);
  process.exit(1);
}

process.env.RENOVATE_CONFIG_FILE = configFile;
const result = await $`bunx renovate@${RENOVATE_VERSION}`.nothrow();
process.exit(result.exitCode ?? 1);
