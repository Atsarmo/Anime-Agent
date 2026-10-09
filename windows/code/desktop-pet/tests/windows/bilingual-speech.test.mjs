import test from 'node:test';
import assert from 'node:assert/strict';
import { BilingualSentences, localBilingualPrompt } from '../../app/bilingual-speech.mjs';
test('only complete paired sentences are emitted from fragmented model output',()=>{
 const emitted=[],parser=new BilingualSentences((s,i)=>emitted.push([s,i]));
 parser.push('{"zh":"你好，哥哥。","ja":"お');assert.equal(emitted.length,0);
 parser.push('兄ちゃん、こんにちは。"}\n{"zh":"喝点水吧。",');assert.equal(emitted.length,1);
 parser.push('"ja":"お水を飲んでね。"}');assert.equal(emitted.length,1);
 assert.equal(parser.finish().length,2);assert.equal(emitted[1][1],1);assert.equal(emitted[1][0].zh,'喝点水吧。');
});
test('malformed, unpaired or excessive output never becomes speech',()=>{
 for(const raw of ['思考：测试\n','{"zh":"你好"}\n','{"zh":"","ja":"はい"}\n']){const values=[],p=new BilingualSentences(s=>values.push(s));p.push(raw);assert.throws(()=>p.finish());assert.equal(values.length,0);}
 const p=new BilingualSentences();p.push(Array(9).fill('{"zh":"你好","ja":"はい"}').join('\n'));assert.throws(()=>p.finish());assert.equal(p.items.length,8);
});

test('Japanese synthesis can start before translation while playback requires a validated pair',()=>{
 const early=[],paired=[],p=new BilingualSentences(s=>paired.push(s),(ja,i)=>early.push([ja,i]));
 p.push('{"ja":"お兄ちゃん、こんにちは。",');assert.deepEqual(early,[['お兄ちゃん、こんにちは。',0]]);assert.equal(paired.length,0);
 p.push('"zh":"哥哥，你好。"}\n');assert.equal(paired.length,1);assert.equal(early.length,1);p.finish();
 const bad=new BilingualSentences(()=>assert.fail('invalid pair emitted'),()=>{});bad.push('{"ja":"はい",');bad.push('"zh":null}\n');assert.throws(()=>bad.finish());
 const escaped=new BilingualSentences(()=>{},ja=>early.push([ja,1]));escaped.push('{"ja":"これは\\"テスト\\"です。",');assert.equal(early.at(-1)[0],'これは"テスト"です。');
});
test('local result narration requests Japanese pairs and retains the actual result as quoted data',()=>{
 const result='今天更新：测试动漫 第02集\nhttps://www.agedm.io/detail/123';
 const prompt=localBilingualPrompt(result);
 assert.match(prompt,/日语播报/);assert.match(prompt,/同义中文字幕/);assert.match(prompt,/不得更改作品身份、数字、集数/);
 assert.equal(JSON.parse(prompt.split('本地结果：')[1]),result);
});
