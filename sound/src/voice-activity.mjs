let chatSpeech=0,changing=false;
export class VoiceBusyError extends Error {}
export async function withChatSpeech(task){
  if(changing)throw new VoiceBusyError('正在切换声音，先显示文字回复。');
  chatSpeech++;
  try{return await task();}finally{chatSpeech--;}
}
export async function withVoiceChange(task){
  if(chatSpeech||changing)throw new VoiceBusyError('正在准备聊天声音，请稍后保存。');
  changing=true;
  try{return await task();}finally{changing=false;}
}
