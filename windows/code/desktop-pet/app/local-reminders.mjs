import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const zone = 'Asia/Shanghai';
const formatter = new Intl.DateTimeFormat('zh-CN', {timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
export const reminderTime = timestamp => formatter.format(new Date(timestamp));
function number(text) {
  if (/^\d+$/.test(text)) return Number(text);
  const digits='零一二三四五六七八九';
  text=text.replaceAll('两','二');
  if(text==='半')return .5;
  if(text.includes('十')){const [a,b]=text.split('十');return (a?digits.indexOf(a):1)*10+(b?digits.indexOf(b):0);}
  return text.length===1?digits.indexOf(text):NaN;
}
const help='请提供具体时间，例如“1:45分提醒我喝水”“10分钟后提醒我喝水”或“明天下午3点提醒我喝水”。时间按北京时间计算。';
export function parseReminder(raw, now=Date.now()) {
  const text=raw.trim().replace(/^(?:请|麻烦)?(?:帮我)?\s*/, '').replace(/[。！!]+$/, '');
  if(/^(?:查看|列出|显示)(?:我的|所有)?提醒$/.test(text)||text==='提醒列表')return {type:'list'};
  if(/^取消(?:所有|全部)提醒$/.test(text))return {type:'cancelAll'};
  const cancel=/^取消提醒\s*([\da-f]{8})$/i.exec(text);
  if(cancel)return {type:'cancel',id:cancel[1].toLowerCase()};
  if(/^取消提醒/.test(text))return {type:'invalid',message:'请发送“查看提醒”获取编号，再发送“取消提醒 编号”，或发送“取消所有提醒”。'};
  const intent=/^(.{0,100}?)提醒我\s*(.*)$/.exec(text);
  if(!intent)return null;
  const when=intent[1].trim(), task=intent[2].trim();
  if(!task||task.length>500)return {type:'invalid',message:'请填写提醒内容（最多500字符）。'+help};
  if(/每天|每周|每月|每隔|每个/.test(when))return {type:'invalid',message:'当前支持单次提醒。'+help};
  let dueAt;
  const relative=/^([\d零一二三四五六七八九十两半]+)\s*(秒|分钟|分|小时)(?:之)?后$/.exec(when);
  if(relative){const n=number(relative[1]);const multiplier=relative[2]==='秒'?1000:['分','分钟'].includes(relative[2])?60000:3600000;
    if(!Number.isFinite(n)||n<=0||n*multiplier>366*86400000)return {type:'invalid',message:'提醒间隔需大于0，且不超过366天。'};
    dueAt=now+n*multiplier;
  }else{
    const clock=/^(今天|明天|后天)?\s*(凌晨|早上|上午|中午|下午|晚上)?\s*([\d零一二三四五六七八九十两]+)(?:[:：]([\d零一二三四五六七八九十两]+)分?|[点时](半|[\d零一二三四五六七八九十两]+分?)?)$/.exec(when);
    if(!clock)return {type:'invalid',message:help};
    let hour=number(clock[3]), minute=clock[4]?number(clock[4]):clock[5]==='半'?30:clock[5]?number(clock[5].replace(/分$/,'')):0;
    const period=clock[2];
    if(period){if(hour<1||hour>12)return {type:'invalid',message:'上午/下午的小时请使用1到12。'};
      if(['下午','晚上','中午'].includes(period)&&hour<12)hour+=12;
      if(['凌晨','早上','上午'].includes(period)&&hour===12)hour=0;
    }
    if(!Number.isInteger(hour)||hour<0||hour>23||!Number.isInteger(minute)||minute<0||minute>59)return {type:'invalid',message:'时间无效，请使用0到23时、0到59分。'};
    const date=new Date(now+8*3600000);
    dueAt=Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate(),hour,minute)-8*3600000;
    dueAt+=(clock[1]==='明天'?1:clock[1]==='后天'?2:0)*86400000;
    if(dueAt<=now){if(clock[1])return {type:'invalid',message:'这个时间已经过去了，请指定未来的时间。'+help};dueAt+=86400000;}
  }
  return {type:'create',dueAt,task};
}

/** Pending reminders are kept until the renderer acknowledges their display. */
export class LocalReminders {
  records=[]; lastSent=new Map(); writes=Promise.resolve(); timer=null;
  constructor(file,{now=Date.now,onDue=()=>{},onError=()=>{},onCreated=()=>{}}={}){Object.assign(this,{file,now,onDue,onError,onCreated});}
  async load(){try{const data=JSON.parse(await readFile(this.file,'utf8'));
    if(data.version!==1||!Array.isArray(data.records)||data.records.some(r=>!r||!/^[-\da-f]{36}$/i.test(r.id)||typeof r.task!=='string'||r.task.length>500||!Number.isFinite(r.dueAt)||!['pending','delivered','cancelled'].includes(r.status)))throw Error('invalid reminders');
    this.records=data.records;
  }catch(e){if(e.code!=='ENOENT')throw Error('本地提醒文件无法读取，请检查文件后重启；未覆盖原文件。');}}
  async persist(){const snapshot=JSON.stringify({version:1,records:this.records});
    const write=this.writes.then(async()=>{await mkdir(dirname(this.file),{recursive:true});const temporary=this.file+'.next';await writeFile(temporary,snapshot,{mode:0o600});await rename(temporary,this.file);});
    this.writes=write.catch(()=>{});return write;
  }
  async handle(text){const action=parseReminder(text,this.now());if(!action)return null;
    if(action.type==='invalid')return action.message;
    const pending=this.records.filter(r=>r.status==='pending').sort((a,b)=>a.dueAt-b.dueAt);
    if(action.type==='list')return pending.length?'待提醒（北京时间）：\n'+pending.map(r=>`${r.id.slice(0,8)} · ${reminderTime(r.dueAt)} · ${r.task}`).join('\n')+'\n取消某项：取消提醒 编号':'目前没有待提醒事项。';
    const before=structuredClone(this.records);
    if(action.type==='create'){
      if(pending.length>=100)return '待提醒已达100条，请先取消不需要的提醒。';
      const record={id:randomUUID(),task:action.task,dueAt:action.dueAt,status:'pending',createdAt:this.now()};
      this.records=[...this.records.filter(r=>r.status==='pending'),...this.records.filter(r=>r.status!=='pending').slice(-100),record];
      try{await this.persist();}catch{this.records=before;return '提醒保存失败，尚未设置成功。请检查本地文件权限或磁盘空间。';}
      try{this.onCreated(record);}catch{}
      return `已设置：${reminderTime(record.dueAt)}（北京时间）提醒你${record.task}。\n编号：${record.id.slice(0,8)}。`;
    }
    const selected=action.type==='cancelAll'?pending:pending.filter(r=>r.id.startsWith(action.id));
    if(action.type==='cancel'&&selected.length!==1)return '未找到唯一的待提醒编号，请发送“查看提醒”核对。';
    for(const r of selected)r.status='cancelled';
    try{await this.persist();}catch{this.records=before;return '取消保存失败，请重新查看提醒后再试。';}
    return `已取消${selected.length}条提醒。`;
  }
  tick(){const now=this.now();for(const r of this.records){if(r.status!=='pending'||r.dueAt>now||now-(this.lastSent.get(r.id)??-Infinity)<30000)continue;
    this.lastSent.set(r.id,now);this.onDue({...r,overdue:now-r.dueAt>60000});}}
  start(){this.timer=setInterval(()=>this.tick(),1000);this.tick();}
  async acknowledge(id){const r=this.records.find(r=>r.id===id&&r.status==='pending'&&r.dueAt<=this.now());if(!r)return;
    r.status='delivered';try{await this.persist();}catch{r.status='pending';throw Error('提醒回执保存失败');}}
  close(){clearInterval(this.timer);return this.writes;}
}
