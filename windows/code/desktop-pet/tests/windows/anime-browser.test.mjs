import test from 'node:test';
import assert from 'node:assert/strict';
import { AnimeBrowser, animePageURL, isAnimeOpenRequest, selectAnimePage, animeWatchTitle } from '../../mods/anime-browser.mjs';

const items=[{title:'FX战士久留美',url:'https://www.agedm.io/detail/20260260'},{title:'转生成为魔剑 第二季',url:'https://www.agedm.io/detail/20260323'}];
const result='AGE 今日动漫更新（2条）\n'+items.map(i=>`今天 (木曜日) · ${i.title} · 第02集\n${i.url}`).join('\n');
test('Chinese and Japanese open commands resolve known titles and list positions',()=>{
 const text='FX戦士くるみちゃんが見たい、ウェブサイトをあけて';
 assert.equal(isAnimeOpenRequest(text),true);assert.equal(selectAnimePage(text,items),items[0]);
 assert.equal(selectAnimePage('打开转生成为魔剑 第二季',items),items[1]);
 assert.equal(selectAnimePage('打开第2部动漫',items),items[1]);
 assert.equal(selectAnimePage('打开第一个',items),items[0]);
 assert.equal(selectAnimePage('打开第99部',items),null);
 assert.equal(isAnimeOpenRequest('不要打开FX网站'),false);
 assert.equal(isAnimeOpenRequest('サイトを開かないで'),false);
});
test('only known HTTPS AGE detail and update pages are valid browser targets',()=>{
 assert.equal(animePageURL(items[0].url),items[0].url);
 for(const url of ['javascript:alert(1)','file:///C:/test','https://www.agedm.io.evil.invalid/detail/1','https://evil@www.agedm.io/detail/1','http://www.agedm.io/detail/1','https://www.agedm.io/detail/1?next=bad','https://www.agedm.io:444/detail/1'])assert.equal(animePageURL(url),null);
});
test('screenshot request opens the remembered page and only reports acknowledged success',async()=>{
 const browser=new AnimeBrowser();browser.remember(result);let url;
 const reply=await browser.handle('FX戦士くるみちゃんが見たい、ウェブサイトをあけて',{openPage:async value=>{url=value;return true;}});
 assert.equal(url,items[0].url);assert.match(reply,/已在默认浏览器打开《FX战士久留美》/);
 assert.match(await browser.handle('打开第1部动漫',{openPage:async()=>false}),/未能打开/);
 assert.match(await browser.handle('打开第1部动漫',{openPage:async()=>{throw Error('failed');}}),/打开网页失败/);
});
test('ambiguous names and vague requests never open an arbitrary page',async()=>{
 const browser=new AnimeBrowser();browser.remember(result);
 const openPage=()=>assert.fail('must ask for a title or position');
 assert.match(await browser.handle('打开网站',{openPage}),/请指定/);
 assert.equal(selectAnimePage('FXのサイトを開いて',[items[0],{title:'FX测试',url:items[1].url}]),null);
 assert.equal(await browser.handle('你喜欢动漫吗',{openPage}),null);
});
test('after restart a Japanese FX request can look up the current update page',async()=>{
 const browser=new AnimeBrowser();let opened;
 const html='<div class="video_list_box recent_update"><button>今天</button><div class="video_item"><span class="video_item--info">第02集</span><a href="/detail/20260260">FX战士久留美</a></div></div>';
 assert.match(await browser.handle('FX戦士くるみちゃんが見たい、ウェブサイトをあけて',{fetcher:async()=>new Response(html),openPage:async url=>{opened=url;return true;}}),/已在默认浏览器打开/);
 assert.equal(opened,items[0].url);
});
test('natural viewing requests and the screenshot ASR spelling open the same known page',async()=>{
 for(const text of ['宝宝我想看fx展示久留美','宝宝，我想看FX战士久留美','我要看FX战士久留美','FX戦士くるみちゃんが見たい']){
  const browser=new AnimeBrowser();browser.remember(result);let opened;
  const reply=await browser.handle(text,{openPage:async url=>{opened=url;return true;}});
  assert.equal(opened,items[0].url,text);assert.match(reply,/已在默认浏览器打开/,text);
 }
});
test('partial season names and Chinese homophones resolve only a unique title',()=>{
 assert.equal(selectAnimePage('我想看转生成为魔剑',items),items[1]);
 assert.equal(selectAnimePage('我想看转生成为魔件',items),items[1]);
 assert.equal(selectAnimePage('我想看转生成为魔剑',[items[1],{title:'转生成为魔剑 第一季',url:items[0].url}]),null);
});
test('negative viewing statements and ordinary conversation do not open a browser',async()=>{
 const browser=new AnimeBrowser();browser.remember(result);
 for(const text of ['宝宝我不想看fx展示久留美','我先不看FX战士','我不需要打开FX战士','FX戦士くるみちゃんが見たくない','FX战士久留美好看吗']){
  assert.equal(await browser.handle(text,{openPage:()=>assert.fail('unexpected browser action')}),null,text);
 }
});
const swordPage='<div class="video_list_box recent_update"><button>今天</button><div class="video_item"><span class="video_item--info">第02集</span><a href="/detail/20260323">转生成为魔剑 第二季</a></div></div>';
test('latest-episode screenshot works on a fresh session without a previous list',async()=>{
 const text='宝宝我想看转生成魔剑的最新话!';
 assert.equal(animeWatchTitle(text),'转生成魔剑');
 const browser=new AnimeBrowser();let opened,calls=0;
 const reply=await browser.handle(text,{fetcher:async()=>{calls++;return new Response(swordPage);},openPage:async url=>{opened=url;return true;}});
 assert.equal(calls,1);assert.equal(opened,items[1].url);assert.match(reply,/已在默认浏览器打开《转生成为魔剑 第二季》/);
});
test('a named title absent from the displayed list is looked up in the full update page',async()=>{
 const browser=new AnimeBrowser();browser.remember('AGE 今日动漫更新（1条）\n今天 · FX战士久留美 · 第02集\n'+items[0].url);
 let opened;
 await browser.handle('我想看转生成魔剑的最新话',{fetcher:async()=>new Response(swordPage),openPage:async url=>{opened=url;return true;}});
 assert.equal(opened,items[1].url);
});
test('missing-character matching preserves season ambiguity and does not guess unrelated titles',()=>{
 assert.equal(selectAnimePage('我想看转生成魔剑',items),items[1]);
 assert.equal(selectAnimePage('我想看转生成魔剑',[items[1],{title:'转生成为魔剑 第一季',url:items[0].url}]),null);
 assert.equal(selectAnimePage('我想看完全不同片名',items),null);
});
test('ordinary viewing preferences on a fresh session do not query anime pages',async()=>{
 for(const text of ['我想看你笑','我想看窗外的风景','我想看电影'])assert.equal(await new AnimeBrowser().handle(text,{fetcher:()=>assert.fail('unexpected anime lookup')}),null);
});
