import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { synthesizeEngine } from '../../tools/voice-engines.mjs';

async function fixture(t, onRequest, {ready=true}={}) {
  const outer = await mkdtemp(join(tmpdir(), 'pet-voice-timeout-'));
  const root = join(outer, 'Anime', 'windows'), lab = join(outer, 'Anime', 'sound', '.local', 'voice-lab');
  const file = join(root, '..', 'sound', '.local', 'settings', 'engine-service.json');
  await mkdir(lab, {recursive:true}); await mkdir(join(root, '..', 'sound', '.local', 'settings'), {recursive:true});
  await writeFile(join(lab, 'fish-finetuned.ready.json'), JSON.stringify({ready:true}));
  let shutdowns = 0;
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer fixture-only');
    if(req.url === '/health') return res.end(JSON.stringify({ready}));
    if(req.url === '/shutdown') { shutdowns++; return res.end('{}'); }
    void onRequest(req, res, file);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  await writeFile(file, JSON.stringify({engine:'fish-finetuned',pid:process.pid,port:server.address().port,token:'fixture-only'}));
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); await rm(outer,{recursive:true,force:true}); });
  return {root, config:{engine:'fish-finetuned',speed:1,fishExpression:'warm'}, shutdowns:()=>shutdowns};
}

test('stalled synthesis is bounded, retires its worker and lets the next request finish', async t => {
  let attempts = 0;
  const wav = Buffer.alloc(48); wav.write('RIFF'); wav.write('WAVE',8);
  const f = await fixture(t, (_req, res) => {
    if(++attempts === 1) return; // CUDA never produced headers or audio.
    res.end(JSON.stringify({audio:wav.toString('base64')})+'\n');
  });
  await assert.rejects(synthesizeEngine(f.root,f.config,'おはよう',undefined,()=>{}, {timeoutMs:350}), /等待过久/);
  assert.equal(f.shutdowns(),1);
  const chunks=[];
  await synthesizeEngine(f.root,f.config,'こんにちは',undefined,a=>chunks.push(a),{timeoutMs:1000});
  assert.equal(chunks.length,1); assert.deepEqual(chunks[0],wav);
});

test('cancelling a generating reply releases the old worker rather than leaving CUDA queued', async t => {
  const controller=new AbortController();
  const f=await fixture(t,()=>controller.abort());
  await assert.rejects(synthesizeEngine(f.root,f.config,'こんにちは',controller.signal,()=>{}, {timeoutMs:1000}));
  assert.equal(f.shutdowns(),1);
});

test('a timed-out request cannot shut down a replacement worker', async t => {
  const f=await fixture(t,async(_req,_res,file)=>{
    await writeFile(file,JSON.stringify({engine:'fish-finetuned',pid:process.pid,port:12345,token:'replacement'}));
  });
  await assert.rejects(synthesizeEngine(f.root,f.config,'こんにちは',undefined,()=>{}, {timeoutMs:350}),/等待过久/);
  assert.equal(f.shutdowns(),0);
});

test('voice loading also has a deadline and releases its unresponsive warm-up',async t=>{
  let synthesis=0;
  const f=await fixture(t,()=>{synthesis++;},{ready:false});
  await assert.rejects(synthesizeEngine(f.root,f.config,'こんにちは',undefined,()=>{},{timeoutMs:350}),/等待过久/);
  assert.equal(synthesis,0); assert.equal(f.shutdowns(),1);
});

test('paragraph playback receives the complete WAV after synthesis, without partial network chunks',async t=>{
 const wav=Buffer.alloc(80);wav.write('RIFF');wav.write('WAVE',8);
 let complete=false;
 const f=await fixture(t,(_req,res)=>{
  res.write(wav.subarray(0,44));
  setTimeout(()=>{complete=true;res.end(wav.subarray(44));},40);
 });
 const audio=await synthesizeEngine(f.root,f.config,'お兄ちゃん、気をつけてね。帰ったらまた話そう。',undefined,undefined,{timeoutMs:1000});
 assert.equal(complete,true);assert.deepEqual(audio,wav);assert.equal(f.shutdowns(),0);
});
