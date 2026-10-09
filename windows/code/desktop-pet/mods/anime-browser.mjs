import { getText } from './http.mjs';
import { parseUpdatePage, UPDATE_URL } from './anime-updates.mjs';
import { pinyin } from 'pinyin-pro';

export function animePageURL(raw) {
  try {
    const url=new URL(raw);
    return url.protocol==='https:'&&['www.agedm.io','agedm.io'].includes(url.hostname)&&!url.port&&!url.username&&!url.password&&/^\/(?:detail\/\d+|update)$/.test(url.pathname)&&!url.search&&!url.hash?url.href:null;
  } catch { return null; }
}
export function isAnimeOpenRequest(text) {
  if(/不要|别打开|不用打开|不想|不看|不想看|暂时不|先不|不需要|見たくない|見ない|開かない|開けない|開かなく|開けなく/.test(text))return false;
  return /打开|開いて|開けて|あけて|ひらいて|オープン|(?:我)?(?:想看|要看|想观看)|(?:を|が)見たい/.test(text);
}
const normalized=s=>s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const phonetic=s=>normalized(pinyin(s,{toneType:'none',separator:''}));
export function animeWatchTitle(text) {
  const quoted=/《([^》]+)》/.exec(text);
  if(quoted)return quoted[1].trim();
  const chinese=/(?:想观看|想看|要看|打开)\s*(.+)/.exec(text);
  const japanese=/(.+?)(?:が|を)見たい/.exec(text);
  return (chinese?.[1]??japanese?.[1]??'').replace(/[!！?？。]+$/,'')
    .replace(/(?:的)?(?:最新(?:一)?[话話集]|最新更新|最新一集|最新章节|最新章節|网页|网站|链接).*$/,'')
    .replace(/(?:吧|呀|呢|啊|哦|啦)+$/,'').replace(/的$/,'').trim();
}
function distance(a,b) {
  let previous=Array.from({length:b.length+1},(_,i)=>i);
  for(let i=0;i<a.length;i++){
    const next=[i+1];for(let j=0;j<b.length;j++)next.push(Math.min(next[j]+1,previous[j+1]+1,previous[j]+(a[i]===b[j]?0:1)));
    previous=next;
  }
  return previous[b.length];
}
export function selectAnimePage(text,items) {
  const ordinal=/(?:第\s*([1-9]\d*)\s*(?:个|部|条)|([1-9]\d*)\s*(?:番目))/.exec(text);
  if(ordinal)return items[Number(ordinal[1]??ordinal[2])-1]??null;
  if(/第一个|第一部|一番目/.test(text))return items[0]??null;
  const query=normalized(text);
  const exact=items.filter(item=>query.includes(normalized(item.title)));
  if(exact.length===1)return exact[0];
  const spoken=phonetic(text);
  const variants=items.filter(item=>{
    const base=item.title.replace(/\s*第[一二三四五六七八九十\d]+[季期部].*$/,'').trim();
    return normalized(base).length>=4&&(query.includes(normalized(base))||spoken.includes(phonetic(base)));
  });
  if(variants.length===1)return variants[0];
  const requested=normalized(animeWatchTitle(text));
  if(requested.length>=4&&requested.length<=80){
    const near=items.map(item=>({item,base:normalized(item.title.replace(/\s*第[一二三四五六七八九十\d]+[季期部].*$/,''))}))
      .filter(({base})=>base.length>=4&&Math.abs(base.length-requested.length)<=1)
      .map(entry=>({...entry,distance:distance(requested,entry.base)})).filter(entry=>entry.distance<=1);
    const best=Math.min(...near.map(entry=>entry.distance));
    const matches=near.filter(entry=>entry.distance===best);
    if(matches.length===1)return matches[0].item;
  }
  // Distinctive Latin title tokens also match Chinese/Japanese variants (e.g. FX).
  const tokens=[...text.normalize('NFKC').matchAll(/[a-zA-Z]{2,}/g)].map(m=>m[0].toLowerCase()).filter(t=>!['https','www','agedm','io','website','open'].includes(t));
  const matching=items.filter(item=>tokens.some(t=>(item.title.toLowerCase().match(/[a-z]{2,}/g)??[]).includes(t)));
  if(matching.length===1)return matching[0];
  if(items.length===1&&/(?:这个|这部|网页|网站|链接|これ|この|サイト|ページ|リンク)/.test(text))return items[0];
  return null;
}
export class AnimeBrowser {
  items=[];
  remember(result) {
    if(!result.startsWith('AGE ')||!result.includes('动漫更新（')&&!result.includes('动漫更新 · '))return;
    this.items=[...result.matchAll(/^([^\n]+) · ([^\n]+) · ([^\n]+)\n(https:\/\/www\.agedm\.io\/detail\/\d+)$/gm)].map(m=>({title:m[2],url:m[4]}));
  }
  async handle(text,options={}) {
    if(!isAnimeOpenRequest(text))return null;
    let selected=selectAnimePage(text,this.items);
    const title=animeWatchTitle(text);
    const named=normalized(title).length>=4&&!/^(?:你|您|我|他|她|大家|窗外|电影|电视剧|电视|风景)/.test(title);
    const hint=/动漫|番剧|AGE|agedm|アニメ|FX|《.+》/i.test(text);
    if(!this.items.length&&!hint&&!named)return null;
    if(!selected&&(!this.items.length||named)){
      try{
        const fresh=parseUpdatePage(await getText(UPDATE_URL,options));
        if(!this.items.length)this.items=fresh;
        selected=selectAnimePage(text,fresh);
      }
      catch(error){if(options.signal?.aborted)throw error;return '动漫页面暂时无法查询，请稍后重试。';}
    }
    if(!selected)return named?`AGE 一周更新列表中未找到唯一匹配的“${title}”，请补充完整片名或季数；尚未打开网页。`:'请指定要打开的动漫名称或列表序号，例如“打开第1部动漫”。\n'+this.items.slice(0,20).map((i,n)=>`${n+1}. ${i.title}`).join('\n');
    const url=animePageURL(selected.url);
    if(!url)return '动漫链接无效，未打开网页。';
    try {
      if(!options.openPage||!await options.openPage(url,options.signal))return `未能打开网页，请点击链接：\n${url}`;
      return `已在默认浏览器打开《${selected.title}》的动漫详情页。\n${url}`;
    } catch(error) {if(options.signal?.aborted)throw error;return `打开网页失败，请点击链接：\n${url}`;}
  }
}
