import {fileURLToPath} from 'node:url';
import {assetResponse} from '../desktop/electron/assets.mjs';
const root=fileURLToPath(new URL('../desktop/',import.meta.url));
export function framingAsset(value){
  const url=new URL(value,'http://127.0.0.1'),name=url.pathname.slice('/framing-assets/'.length);
  let file;
  if(name==='editor.js')file='build/framing-editor.js';
  else if(name==='core.js')file='vendor/cubism/Core/live2dcubismcore.min.js';
  else if(name.startsWith('model/'))file='assets/local-model/'+name.slice(6);
  else if(name.startsWith('shaders/'))file='vendor/cubism/Framework/Shaders/WebGL/'+name.slice(8);
  else return new Response(null,{status:404});
  return assetResponse(root,'pet://app/'+file);
}
