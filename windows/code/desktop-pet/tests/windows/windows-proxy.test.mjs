import test from 'node:test';
import assert from 'node:assert/strict';
import { applyWindowsProxy } from '../../dist/harness/windows-proxy.js';

test('Codex inherits an enabled local Windows proxy for HTTP and WebSocket traffic',()=>{
 const env={CODEX_HOME:'C:/private',NO_PROXY:'internal.example'},settings={ProxyEnable:1,ProxyServer:'127.0.0.1:7890'};
 const actual=applyWindowsProxy(env,settings);
 for(const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','WS_PROXY','WSS_PROXY'])assert.equal(actual[key],'http://127.0.0.1:7890');
 assert.equal(actual.NO_PROXY,'internal.example,localhost,127.0.0.1,::1');
 assert.deepEqual(env,{CODEX_HOME:'C:/private',NO_PROXY:'internal.example'});
 const split=applyWindowsProxy({}, {ProxyEnable:1,ProxyServer:'http=127.0.0.1:7890;https=127.0.0.1:7891'});
 assert.equal(split.HTTP_PROXY,'http://127.0.0.1:7890');assert.equal(split.WSS_PROXY,'http://127.0.0.1:7891');
});

test('explicit environment, disabled proxies, remote addresses and credentials are preserved without automatic routing',()=>{
 for(const key of ['HTTP_PROXY','https_proxy','ALL_PROXY','WS_PROXY','wss_proxy']){
  const env={[key]:'http://explicit.example:8080'};assert.deepEqual(applyWindowsProxy(env,{ProxyEnable:1,ProxyServer:'127.0.0.1:7890'}),env);
 }
 for(const settings of [{ProxyEnable:0,ProxyServer:'127.0.0.1:7890'}, {ProxyEnable:1,ProxyServer:'remote.example:7890'}, {ProxyEnable:1,ProxyServer:'http://user:secret@127.0.0.1:7890'}, {ProxyEnable:1,ProxyServer:'127.0.0.1:99999'}])assert.deepEqual(applyWindowsProxy({},settings),{});
});
