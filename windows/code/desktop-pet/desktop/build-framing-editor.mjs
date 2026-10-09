import {build} from 'esbuild';
import {modelPlugins} from './model-build-options.mjs';
import {fileURLToPath} from 'node:url';
await build({entryPoints:[fileURLToPath(new URL('./framing-editor.mjs',import.meta.url))],bundle:true,format:'esm',platform:'browser',target:['safari17','chrome130'],outfile:fileURLToPath(new URL('./build/framing-editor.js',import.meta.url)),legalComments:'eof',plugins:modelPlugins});
