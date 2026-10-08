import test from 'node:test';
import assert from 'node:assert/strict';
import { ReminderVoice } from '../../app/reminder-voice.mjs';
const profile={name:'爱丽丝',revision:'one',tone:'乖巧，可爱',personality:'温暖',relationship:'妹妹，喜欢哥哥',extra:''};
const record={id:'one',task:'喝水'};
test('reminder wording uses the saved role and refreshes when that role changes',async()=>{
 let current=profile,calls=0;
 const voice=new ReminderVoice({readProfile:async()=>current,generate:async p=>{calls++;return p.name+'：哥哥，喝点水吧～';}});
 await voice.prepare(record);
 assert.deepEqual(await voice.wording(record),{name:'爱丽丝',text:'爱丽丝：哥哥，喝点水吧～'});assert.equal(calls,1);
 current={...profile,name:'另一位角色',revision:'two'};
 assert.equal((await voice.wording(record)).name,'另一位角色');assert.equal(calls,2);
});
test('model failures and slow responses cannot block a timed reminder; fallback follows the role',async()=>{
 const failed=new ReminderVoice({readProfile:async()=>profile,generate:async()=>{throw Error('offline');}});
 assert.deepEqual(await failed.wording(record),{name:'爱丽丝',text:'哥哥，喝水的时间到啦～'});
 const slow=new ReminderVoice({readProfile:async()=>profile,generate:async()=>new Promise(()=>{}),waitMs:10});
 assert.match((await slow.wording(record)).text,/哥哥/);
});
test('duplicate reminder preparation is shared and generated boilerplate is bounded',async()=>{
 let calls=0;
 const voice=new ReminderVoice({readProfile:async()=>profile,generate:async()=>{calls++;await new Promise(done=>setTimeout(done,10));return '哥哥，喝水啦～';}});
 await Promise.all([voice.prepare(record),voice.prepare(record),voice.prepare(record)]);assert.equal(calls,1);
 const bad=new ReminderVoice({readProfile:async()=>profile,generate:async()=>'a'.repeat(200)});
 assert.equal((await bad.wording(record)).text,'哥哥，喝水的时间到啦～');
});
test('only successful reminder receipts get a character acknowledgement, with timing facts preserved',()=>{
 const voice=new ReminderVoice({readProfile:async()=>profile,generate:async()=>''});
 assert.equal(voice.confirmation(profile,null),null);
 assert.equal(voice.confirmation(profile,'提醒保存失败'),'提醒保存失败');
 assert.equal(voice.confirmation(profile,'已设置：明天3点提醒你喝水。\n编号：1234'),'哥哥，好呀，记下啦～\n明天3点提醒你喝水。\n编号：1234');
});
test('many upcoming reminders cannot start more than two model generations at once',async()=>{
 let active=0,max=0;
 const voice=new ReminderVoice({readProfile:async()=>profile,generate:async()=>{active++;max=Math.max(max,active);await new Promise(done=>setTimeout(done,10));active--;return '喝水啦～';}});
 await Promise.all(Array.from({length:8},(_,i)=>voice.prepare({task:'task'+i})));
 assert.equal(max,2);
});
