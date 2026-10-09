import { parseWeather, queryWeather } from './weather.mjs';
import { parseAnime, queryAnime, UPDATE_URL } from './anime-updates.mjs';
export const modInstructions='桌宠本地查询模组支持“上海天气”“北京明天天气”“杭州未来7天天气”“动漫更新”“今天动漫更新”“动漫更新 转生成为魔剑”。查询后支持“我想看某部动漫”“我要看某部动漫”“打开第1部动漫”“打开FX战士网页”及日语“FX戦士くるみちゃんが見たい”，本地程序可在默认浏览器打开实际查询得到的AGE详情页，也支持中文片名常见同音识别偏差。用户可自然提问，不需要照抄固定命令。城市必须由用户指定。只有本地程序实际回执能确认查询或打开网页成功，不能编造结果。';
export function queryText(text, characterName) {
  text=text.trim();
  // Match the configured name literally: names can contain regex punctuation.
  if(characterName&&text.startsWith(characterName))text=text.slice(characterName.length).replace(/^[\s，,、：:！!]+/,'');
  text=text.replace(/[\s，,、：:！!？?。]+$/,'');
  if(characterName&&text.endsWith(characterName))text=text.slice(0,-characterName.length).replace(/[\s，,、：:]+$/,'');
  return text.replace(/^(?:请|麻烦)?(?:帮我|给我)?(?:查询|查一下|查查|查看|查找|看看|查)?\s*/,'');
}
export async function handleMods(text,options={}) {
  text=queryText(text,options.characterName);
  const weather=parseWeather(text),anime=weather?null:parseAnime(text);
  if(!weather&&!anime)return null;
  try{return await(weather?queryWeather(weather,options):queryAnime(anime,options));}
  catch(error){
    if(options.signal?.aborted)throw error;
    return weather?'天气查询失败，服务暂时无法访问或数据不完整，请稍后重试。':`动漫更新查询失败，AGE 可能暂时无法访问、要求验证或更改了页面。请稍后重试，或打开：${UPDATE_URL}`;
  }
}
