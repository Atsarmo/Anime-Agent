import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalReminders, parseReminder } from '../../app/local-reminders.mjs';
import { DesktopChatLog } from '../../dist/desktop/chat-log.js';
import { COMPANION_ID } from '../../dist/contracts/character.js';
const now=Date.parse('2026-10-08T01:40:00+08:00');
test('Chinese reminder times use Beijing time and explicitly roll an unspecified past clock to tomorrow',()=>{
 assert.deepEqual(parseReminder('1:45分提醒我喝水',now),{type:'create',dueAt:Date.parse('2026-10-08T01:45:00+08:00'),task:'喝水'});
 assert.equal(parseReminder('1:20提醒我喝水',now).dueAt,Date.parse('2026-10-09T01:20:00+08:00'));
 assert.equal(parseReminder('明天下午三点半提醒我喝水',now).dueAt,Date.parse('2026-10-09T15:30:00+08:00'));
 assert.equal(parseReminder('请帮我十分钟后提醒我喝水',now).dueAt,now+600000);
 assert.equal(parseReminder('半小时后提醒我休息',now).dueAt,now+1800000);
 for(const text of ['25:10提醒我喝水','3:60提醒我喝水','今天1:20提醒我喝水','每天3点提醒我喝水','提醒我喝水','0分钟后提醒我喝水'])assert.equal(parseReminder(text,now).type,'invalid',text);
 assert.equal(parseReminder('你好',now),null);
});
test('pending reminders survive restart, catch overdue items, and stop only after a saved display acknowledgement',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'pet-reminder-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=join(dir,'reminders.json');let clock=now;const due=[];
 const first=new LocalReminders(file,{now:()=>clock});await first.load();
 assert.match(await first.handle('1:45分提醒我喝水'),/已设置/);
 const saved=JSON.parse(await readFile(file,'utf8'));assert.equal(saved.records.length,1);
 clock=now+600000;const second=new LocalReminders(file,{now:()=>clock,onDue:r=>due.push(r)});await second.load();second.tick();second.tick();
 assert.equal(due.length,1);assert.equal(due[0].overdue,true);
 await second.acknowledge(due[0].id);clock+=60000;second.tick();assert.equal(due.length,1);
 const third=new LocalReminders(file,{now:()=>clock,onDue:r=>due.push(r)});await third.load();third.tick();assert.equal(due.length,1);
});
test('listing and cancellation use persisted exact IDs; unrelated text never creates reminders',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'pet-reminder-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const s=new LocalReminders(join(dir,'reminders.json'),{now:()=>now,onDue:()=>assert.fail('cancelled reminder fired')});await s.load();
 assert.equal(await s.handle('你好'),null);assert.equal(s.records.length,0);
 await s.handle('10分钟后提醒我喝水');await s.handle('20分钟后提醒我休息');
 assert.match(await s.handle('查看提醒'),/喝水/);
 assert.match(await s.handle('取消提醒 '+s.records[0].id.slice(0,8)),/已取消1条/);
 assert.match(await s.handle('取消所有提醒'),/已取消1条/);
 s.now=()=>now+3600000;s.tick();assert.match(await s.handle('查看提醒'),/没有待提醒/);
});
test('an unreadable reminder store is preserved and cannot produce false success',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'pet-reminder-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=join(dir,'reminders.json');await writeFile(file,'corrupted');
 await assert.rejects(new LocalReminders(file).load(),/未覆盖/);assert.equal(await readFile(file,'utf8'),'corrupted');
 const blocked=new LocalReminders(join(file,'child.json'),{now:()=>now});
 assert.match(await blocked.handle('10分钟后提醒我喝水'),/尚未设置成功/);assert.equal(blocked.records.length,0);
});
test('a reminder notice does not consume a pending user turn or overwrite its reply',()=>{
 const chat=new DesktopChatLog();chat.submit(COMPANION_ID,'你好');chat.notice(COMPANION_ID,'⏰ 喝水');
 assert.equal(chat.pending(COMPANION_ID),true);assert.equal(chat.rows(COMPANION_ID).length,2);
 assert.equal(chat.rows(COMPANION_ID)[1].text,'⏰ 喝水');
});
