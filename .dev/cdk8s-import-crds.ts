/**
 * Import every CRD source into a single module per API group.
 *
 * cdk8s-cli writes one file per API group, so importing several files that
 * define CRDs in the same group separately makes the last one win. This
 * downloads and combines all sources first (see cdk8s-crd-merge-patch.ts).
 *
 * Usage: bun .dev/cdk8s-import-crds.ts <spec>...
 */
import { createRequire } from "node:module";
import { patchCdk8sDownload } from "./cdk8s-download-patch";
import { patchCdk8sCrdMerge } from "./cdk8s-crd-merge-patch";

const require = createRequire(import.meta.url);
patchCdk8sDownload(require);
patchCdk8sCrdMerge(require);

const sources = process.argv.slice(2);
if (sources.length === 0) {
    console.error("usage: bun .dev/cdk8s-import-crds.ts <spec>...");
    process.exit(1);
}

const { ImportCustomResourceDefinition } = require("../node_modules/cdk8s-cli/lib/import/crd");

process.stderr.write(`Importing ${sources.length} CRD sources...\n`);
const importer = await ImportCustomResourceDefinition.fromSpecs(sources.map((source: string) => ({ source })));
await importer.import({
    moduleNamePrefix: undefined,
    targetLanguage: "typescript",
    outdir: "imports",
    classNamePrefix: undefined,
});
process.exit(0);
