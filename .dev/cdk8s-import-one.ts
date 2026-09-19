/**
 * Usage: bun .dev/cdk8s-import-one.ts <spec>
 */
import { createRequire } from "node:module";
import { patchCdk8sDownload } from "./lib/fetch-download";

const require = createRequire(import.meta.url);
patchCdk8sDownload(require);

const { matchImporter } = require("../node_modules/cdk8s-cli/lib/import/dispatch");

const spec = process.argv[2];

const importSpec = { source: spec, moduleNamePrefix: undefined as string | undefined };
const importer = await matchImporter(importSpec, { exclude: [] });
if (!importer) throw new Error(`unable to determine import type for "${spec}"`);

process.stderr.write(`Importing ${spec}...\n`);
await importer.import({
    moduleNamePrefix: importSpec.moduleNamePrefix,
    targetLanguage: "typescript",
    classNamePrefix: undefined,
});
process.exit(0);
