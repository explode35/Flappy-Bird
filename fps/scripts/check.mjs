// Syntax/import check for a single module without needing the whole app to build.
import { build } from 'esbuild';
const target = process.argv[2];
if (!target) { console.error('usage: node scripts/check.mjs <file>'); process.exit(2); }
await build({
  entryPoints: [target], bundle: true, write: false, format: 'esm', target: 'es2022',
  external: ['three', 'three/*', 'three-mesh-bvh'],
  logLevel: 'info',
}).then(() => console.log('OK ' + target)).catch(() => process.exit(1));
