import { getText } from './http.mjs';
export const UPDATE_URL='https://www.agedm.io/update';
export function parseAnime(raw) {
  const text=raw.trim().replace(/[？?。！!]+$/,'').replace(/^(?:请|麻烦)?(?:帮我)?(?:查询|查一下|查查|查看|查找|看看|查)?\s*/,'');
  if(/^(?:今天|今日)(?:有(?:什么|哪些|啥))(?:动漫|番剧|新番)(?:吗|呢|呀|啊)?$/.test(text))return {today:true,keyword:''};
  if(!/(?:动漫|番剧|新番|AGE|agedm).*更新|更新.*(?:动漫|番剧|新番)|^动漫更新查找/i.test(text))return null;
  const today=/今天|今日/.test(text);
  // List questions have no title filter; keep actual titles intact below.
  if(/^(?:今天|今日|最近|最新|本周|一周)?(?:(?:有(?:什么|哪些|啥))?(?:动漫|番剧|新番)(?:有(?:什么|哪些|啥))?更新(?:了)?(?:有?(?:什么|哪些|啥))?|更新(?:了)?(?:什么|哪些|啥)(?:动漫|番剧|新番))(?:吗|呢|呀|啊)?$/i.test(text))return {today,keyword:''};
  const keyword=text.replace(/https:\/\/www\.agedm\.io\/update/gi,'').replace(/动漫|番剧|新番|agedm|AGE|更新查找|更新|今天|今日|最近|最新|一周|本周|列表|有什么|有哪些|情况|查找|查询/gi,'').replace(/^[\s:：的]+|[\s吗呢]+$/g,'').replace(/^《|》$/g,'');
  return {today,keyword};
}
function plain(html) {
  return html.replace(/<[^>]*>/g,'').replace(/&(?:amp|quot|apos|lt|gt|nbsp);/g,e=>({'&amp;':'&','&quot;':'"','&apos;':"'",'&lt;':'<','&gt;':'>','&nbsp;':' '})[e]).replace(/&#(x[\da-f]+|\d+);/gi,(_,n)=>{const code=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n);return code>0&&code<=0x10ffff?String.fromCodePoint(code):'';}).replace(/\s+/g,' ').trim();
}
export function parseUpdatePage(html) {
  const groups=html.split(/<div\b[^>]*class=["'][^"']*\bvideo_list_box recent_update\b[^"']*["'][^>]*>/i).slice(1);
  const items=[];
  for(const group of groups){
    const day=plain(/<button\b[^>]*>([\s\S]*?)<\/button>/i.exec(group)?.[1]??'');
    for(const card of group.split(/<div\b[^>]*class=["']video_item["'][^>]*>/i).slice(1)){
      const link=/<a\b[^>]*href=["']([^"']*\/detail\/\d+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(card);
      const episode=/<span\b[^>]*class=["'][^"']*video_item--info[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(card);
      if(!link)continue;
      const url=new URL(plain(link[1]),UPDATE_URL);
      if(!['www.agedm.io','agedm.io'].includes(url.hostname)||!/^\/detail\/\d+$/.test(url.pathname))continue;
      url.protocol='https:';
      const title=plain(link[2]);if(title&&day)items.push({day,title,episode:plain(episode?.[1]??''),url:url.href});
    }
  }
  if(!items.length)throw Error('页面结构变化或访问验证');
  return items;
}
export async function queryAnime(action,options={}) {
  const items=parseUpdatePage(await getText(UPDATE_URL,options));
  const found=items.filter(i=>(!action.today||/^今天|^今日/.test(i.day))&&(!action.keyword||i.title.toLowerCase().includes(action.keyword.toLowerCase())));
  const stamp=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'short'}).format(new Date());
  if(!found.length)return `AGE 一周更新页面中没有找到${action.today?'今天的':''}${action.keyword?`“${action.keyword}”`:''}更新记录。\n来源：${UPDATE_URL}\n查询时间：${stamp}（北京时间）`;
  return `AGE ${action.today?'今日':'一周'}动漫更新${action.keyword?' · '+action.keyword:''}（${found.length}条${found.length>20?'，展示前20条':''}）\n`+found.slice(0,20).map(i=>`${i.day} · ${i.title} · ${i.episode||'集数未标注'}\n${i.url}`).join('\n')+`\n来源：${UPDATE_URL}\n查询时间：${stamp}（北京时间）`;
}
