/** Prepare character dialogue ahead of time; scheduling never depends on model availability. */
export class ReminderVoice {
  cache=new Map(); pending=new Map(); failures=new Map();
  active=0; waiting=[];
  constructor({readProfile,generate,waitMs=1200,now=Date.now}){Object.assign(this,{readProfile,generate,waitMs,now});}
  key(profile,record){return JSON.stringify([profile.revision,record.task]);}
  async prepare(record){
    const profile=await this.readProfile(),key=this.key(profile,record);
    if(this.cache.has(key))return this.cache.get(key);
    if(this.pending.has(key))return this.pending.get(key);
    if(this.now()-(this.failures.get(key)??-Infinity)<60000)return null;
    const operation=(async()=>{
      if(this.active>=2)await new Promise(done=>this.waiting.push(done));else this.active++;
      try{
      const text=(await this.generate(profile,record)).trim();
      if(!text||text.length>180||/[\r\n]/.test(text))throw Error('invalid reminder dialogue');
      this.cache.set(key,text);if(this.cache.size>100)this.cache.delete(this.cache.keys().next().value);return text;
    }catch{this.failures.set(key,this.now());return null;}finally{this.pending.delete(key);const next=this.waiting.shift();if(next)next();else this.active--;}})();
    this.pending.set(key,operation);return operation;
  }
  confirmation(profile,receipt){
    if(!receipt?.startsWith('已设置：'))return receipt;
    const cute=/乖巧|可爱|亲昵|撒娇/.test(profile.tone+' '+profile.personality);
    const address=/喜欢哥哥|称呼.{0,8}哥哥/.test(profile.relationship+' '+profile.tone+' '+profile.extra)?'哥哥，':'';
    return `${address}${cute?'好呀，记下啦～':'好，记下了。'}\n${receipt.slice('已设置：'.length)}`;
  }
  fallback(profile,record){
    const affectionate=/乖巧|可爱|亲昵|撒娇/.test(profile.tone+' '+profile.personality);
    const address=/喜欢哥哥|称呼.{0,8}哥哥/.test(profile.relationship+' '+profile.tone+' '+profile.extra)?'哥哥，':'';
    return `${address}${record.task}的时间到${affectionate?'啦～':'了。'}`;
  }
  async wording(record){
    const profile=await this.readProfile(),key=this.key(profile,record);
    let timer;
    const text=this.cache.get(key)??await Promise.race([this.prepare(record),new Promise(done=>{timer=setTimeout(()=>done(null),this.waitMs);})]);
    clearTimeout(timer);
    return {name:profile.name,text:text||this.fallback(profile,record)};
  }
}
