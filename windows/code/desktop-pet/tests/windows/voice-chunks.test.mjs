import test from 'node:test';
import assert from 'node:assert/strict';
import {VoiceChunks} from '../../app/voice-chunks.mjs';

test('early chunks wait for a consumer, arrive in order before the producer ends, and cancel clears unspoken audio',async()=>{
  const controller=new AbortController(),stream=new VoiceChunks(controller.signal);
  const early=Buffer.from('first');stream.push(early);
  const reader=stream[Symbol.asyncIterator]();assert.equal((await reader.next()).value.toString(),'first');
  const waiting=reader.next();const next=Buffer.from('next');stream.push(next);assert.equal((await waiting).value.toString(),'next');
  const unspoken=Buffer.from('unspoken');stream.push(unspoken);controller.abort();assert.deepEqual(unspoken,Buffer.alloc(8));assert.equal((await reader.next()).done,true);
  const late=Buffer.from('late');stream.push(late);assert.deepEqual(late,Buffer.alloc(4));
});

test('a waiting consumer finishes on producer failure and queued audio has a fixed bound',async()=>{
  const stream=new VoiceChunks();const next=stream[Symbol.asyncIterator]().next();stream.end();assert.equal((await next).done,true);
  const excessive=new VoiceChunks();assert.throws(()=>excessive.push(Buffer.alloc(12*1024*1024+1)),/过长/);excessive.dispose();
});
