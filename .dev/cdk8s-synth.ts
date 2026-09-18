#!/usr/bin/env bun
/**
 * Render a single cdk8s Application: ./APP_NAME/app.ts.
 *
 * `app.ts` default-exports a crafted `App` (see PLAN.md); this script just
 * imports it and calls `.synth()`. The output directory is passed through the
 * `CDK8S_OUTDIR` env var, which `new App()` picks up, so app.ts stays free of
 * build plumbing.
 *
 * Usage: bun .dev/cdk8s-synth.ts APP_NAME [--output DIR]
 *
 * ArgoCD runs this per cdk8s Application via the Config Management Plugin
 * sidecar; `dist/APP_NAME/*.k8s.yaml` is what gets applied.
 */
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const args = process.argv.slice(2);
const outputFlag = args.indexOf('--output');
const positional = args.filter((_, i) => (outputFlag < 0 ? true : i !== outputFlag && i !== outputFlag + 1));
const appName = positional[0];

if (!appName) {
  console.error('usage: bun .dev/cdk8s-synth.ts APP_NAME [--output DIR]');
  process.exit(1);
}

const outDir = outputFlag >= 0 ? args[outputFlag + 1] : join('dist', appName);
process.env.CDK8S_OUTDIR = outDir;

const appPath = resolve(import.meta.dir, '..', appName, 'app.ts');
if (!existsSync(appPath)) {
  console.error(`✗ ${appPath} does not exist`);
  process.exit(1);
}

const module = (await import(appPath)) as { default?: { synth(): void } };
if (!module.default || typeof module.default.synth !== 'function') {
  console.error(`✗ ${appPath} must default-export a cdk8s App`);
  process.exit(1);
}

module.default.synth();
console.error(`✓ synthesized ${appName} -> ${outDir}`);
