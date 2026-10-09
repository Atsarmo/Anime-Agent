import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultVoice, readVoice, validateVoice, synthesizeVoice } from '../../tools/voice-settings.mjs';
import { startCharacterSettings } from '../../tools/character-settings.mjs';
import { withChatSpeech, withVoiceChange, VoiceBusyError } from '../../tools/voice-activity.mjs';

test('comparison audio requires settings authorization and only accepts named engines',async t=>{
  const outer=await mkdtemp(join(tmpdir(),'pet-voice-sample-')),root=join(outer,'Anime','windows');
  const samples=join(outer,'Anime','sound','.local','voice-lab','samples','stylebert');await mkdir(samples,{recursive:true});
  const wav=Buffer.alloc(64);wav.write('RIFF',0);wav.write('WAVE',8);await writeFile(join(samples,'greeting.wav'),wav);
  const trainedSamples=join(outer,'Anime','sound','.local','voice-lab','samples','fish-finetuned');await mkdir(trainedSamples,{recursive:true});await writeFile(join(trainedSamples,'greeting.wav'),wav);
  const settings=await startCharacterSettings(root);t.after(async()=>{await settings.close();await rm(outer,{recursive:true,force:true});});
  const url=new URL(settings.url),headers={Authorization:'Bearer '+url.hash.slice(7)},sample=url.origin+'/api/voice/samples/stylebert';
  assert.equal((await fetch(sample)).status,401);
  const response=await fetch(sample,{headers});assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'audio/wav');assert.deepEqual(Buffer.from(await response.arrayBuffer()),wav);
  const trained=await fetch(url.origin+'/api/voice/samples/fish-finetuned',{headers});assert.equal(trained.status,200);assert.deepEqual(Buffer.from(await trained.arrayBuffer()),wav);
  assert.equal((await fetch(url.origin+'/api/voice/samples/%2e%2e%2fconfig.json',{headers})).status,404);
  assert.equal((await fetch(url.origin+'/api/voice/samples/unknown',{headers})).status,404);
});

test('voice page protects local settings and persists independently from character profile',async t=>{
  const outer=await mkdtemp(join(tmpdir(),'pet-voice-')),root=join(outer,'Anime','windows'),settings=await startCharacterSettings(root);
  t.after(async()=>{await settings.close();await rm(outer,{recursive:true,force:true});});
  const url=new URL(settings.url),endpoint=url.origin+'/api/voice',headers={Authorization:'Bearer '+url.hash.slice(7),'Content-Type':'application/json'};
  assert.equal((await fetch(endpoint)).status,401);
  assert.equal((await fetch(endpoint,{headers:{...headers,Origin:'http://foreign.invalid'}})).status,403);
  const page=await(await fetch(url.origin)).text();assert.match(page,/当前选择/);assert.match(page,/生成试听/);
  const enginesUrl=url.origin+'/api/voice/engines';assert.equal((await fetch(enginesUrl)).status,401);
  const {engines}=await(await fetch(enginesUrl,{headers})).json();assert.equal(engines.length,6);assert.equal(engines[0].ready,true);assert.ok(engines.slice(1).every(e=>!e.ready));
  assert.ok(engines.some(e=>e.id==='fish-finetuned'));assert.equal(validateVoice({...defaultVoice,engine:'fish-finetuned'}).engine,'fish-finetuned');
  const current=await readVoice(root),body={...current,expectedRevision:current.revision,speed:1.1,fishExpression:'warm'};
  assert.equal((await fetch(endpoint,{method:'PUT',headers,body:JSON.stringify(body)})).status,200);
  assert.equal((await readVoice(root)).speed,1.1);
  assert.equal((await readVoice(root)).fishExpression,'warm');
  assert.throws(()=>validateVoice({...defaultVoice,fishExpression:'unknown'}),/语气/);
  assert.equal((await fetch(endpoint,{method:'PUT',headers,body:JSON.stringify(body)})).status,400);
  assert.throws(()=>validateVoice({...defaultVoice,endpoint:'https://remote.invalid'}));
  assert.throws(()=>validateVoice({...defaultVoice,enabled:true}),/原文/);
  assert.throws(()=>validateVoice({...defaultVoice,engine:'remote'}),/未知/);
  assert.equal(validateVoice({...defaultVoice,engine:undefined}).engine,'gpt-sovits');
  const rejected=await fetch(endpoint,{method:'PUT',headers,body:JSON.stringify({...await readVoice(root),enabled:true,engine:'cosyvoice',expectedRevision:(await readVoice(root)).revision})});
  assert.equal(rejected.status,400);assert.equal((await readVoice(root)).engine,'gpt-sovits');
});

test('TTS sends reference, languages and speed and rejects failed or non-WAV responses',async t=>{
  let received,kind='wav';const wav=Buffer.alloc(44);wav.write('RIFF');wav.write('WAVE',8);
  const server=createServer(async(req,res)=>{let text='';for await(const c of req)text+=c;received=JSON.parse(text);if(kind==='wait')return;res.writeHead(kind==='failure'?500:200,{'Content-Type':'audio/wav'});res.end(kind==='wav'?wav:'invalid');});
  await new Promise(done=>server.listen(0,'127.0.0.1',done));t.after(()=>{server.closeAllConnections();server.close();});
  const config={...defaultVoice,enabled:true,referenceAudio:join(tmpdir(),'fixture-reference.wav'),endpoint:'http://127.0.0.1:'+server.address().port,promptText:'ようこそ、先生。',speed:1.15};
  assert.deepEqual(await synthesizeVoice(config,'你好'),wav);assert.equal(received.prompt_lang,'ja');assert.equal(received.text_lang,'auto');assert.equal(received.ref_audio_path,config.referenceAudio);assert.equal(received.speed_factor,1.15);assert.equal(received.streaming_mode,false);assert.equal(received.use_cuda_graph,false);
  kind='failure';await assert.rejects(synthesizeVoice(config,'你好'),/合成失败/);
  kind='invalid';await assert.rejects(synthesizeVoice(config,'你好'),/有效 WAV/);
  kind='wait';await assert.rejects(synthesizeVoice(config,'你好',AbortSignal.timeout(30)),e=>e.name==='TimeoutError');
});

test('saving cannot unload a voice in use, and a voice switch lets chat fall back promptly',async t=>{
 const outer=await mkdtemp(join(tmpdir(),'pet-voice-busy-')),root=join(outer,'Anime','windows'),settings=await startCharacterSettings(root);
 t.after(async()=>{await settings.close();await rm(outer,{recursive:true,force:true});});
 const url=new URL(settings.url),headers={Authorization:'Bearer '+url.hash.slice(7),'Content-Type':'application/json'},profile=await readVoice(root);
 let release;const chat=withChatSpeech(()=>new Promise(done=>{release=done;}));
 try{const response=await fetch(url.origin+'/api/voice',{method:'PUT',headers,body:JSON.stringify({...profile,expectedRevision:profile.revision})});assert.equal(response.status,409);assert.equal((await readVoice(root)).revision,profile.revision);}finally{release();await chat;}
 let finish;const change=withVoiceChange(()=>new Promise(done=>{finish=done;}));
 try{await assert.rejects(withChatSpeech(()=>assert.fail('chat waited for a voice switch')),VoiceBusyError);}finally{finish();await change;}
 assert.equal(await withChatSpeech(async()=>'ready'),'ready');
});

test('saving a ready engine for the next chat preserves the current model without loading Python',async t=>{
 const outer=await mkdtemp(join(tmpdir(),'pet-voice-save-')),root=join(outer,'Anime','windows');
 const lab=join(outer,'Anime','sound','.local','voice-lab'),stateFile=join(root,'..','sound','.local','settings','engine-service.json');
 await mkdir(lab,{recursive:true});await mkdir(join(root,'..','sound','.local','settings'),{recursive:true});
 await writeFile(join(lab,'cosyvoice.ready.json'),JSON.stringify({ready:true}));
 const state=JSON.stringify({engine:'stylebert',pid:99999999,port:0,token:'test-only'});await writeFile(stateFile,state);
 const settings=await startCharacterSettings(root);t.after(async()=>{await settings.close();await rm(outer,{recursive:true,force:true});});
 const url=new URL(settings.url),profile=await readVoice(root),headers={Authorization:'Bearer '+url.hash.slice(7),'Content-Type':'application/json'};
 const response=await fetch(url.origin+'/api/voice',{method:'PUT',headers,body:JSON.stringify({...profile,enabled:true,engine:'cosyvoice',expectedRevision:profile.revision})});
 assert.equal(response.status,200);assert.equal((await readVoice(root)).engine,'cosyvoice');assert.equal(await readFile(stateFile,'utf8'),state);
});
