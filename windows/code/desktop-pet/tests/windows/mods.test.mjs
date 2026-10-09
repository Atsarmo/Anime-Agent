import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWeather, queryWeather } from '../../mods/weather.mjs';
import { parseAnime, parseUpdatePage } from '../../mods/anime-updates.mjs';
import { handleMods } from '../../mods/index.mjs';

const card=(title='转生 &amp; 魔剑',url='/detail/123')=>`<div class="video_item"><span class="video_item--info rounded-1">第02集</span><div class="video_item-title"><a href="${url}">${title}</a></div></div>`;
const group=(day,body)=>`<div class="video_list_box recent_update mb-3 pb-3"><button>${day}</button>${body}</div>`;
const page=group('今天 (木曜日)',card())+group('昨天 (水曜日)',card('另一部动漫','http://www.agedm.io/detail/456'));
const weatherData={timezone:'Asia/Shanghai',current:{time:'2026-10-08T12:00',temperature_2m:23,weather_code:0,apparent_temperature:24,relative_humidity_2m:50,wind_speed_10m:10},daily:{time:['2026-10-08','2026-10-09','2026-10-10','2026-10-11','2026-10-12','2026-10-13','2026-10-14'],weather_code:[0,61,3,0,0,0,0],temperature_2m_max:[25,24,23,25,25,25,25],temperature_2m_min:[18,18,18,18,18,18,18],precipitation_probability_max:[0,80,10,0,0,0,0]}};
test('weather parses cities and periods; reminders retain priority',()=>{
  assert.deepEqual(parseWeather('请帮我查一下上海明天的天气怎么样？'),{city:'上海',period:'tomorrow'});
  assert.deepEqual(parseWeather('杭州未来7天天气'),{city:'杭州',period:'week'});
  assert.equal(parseWeather('明天提醒我查天气'),null);
  assert.equal(parseWeather('你好'),null);
});
test('missing city requires no network; unrelated chat falls through',async()=>{
  const fetcher=()=>{throw Error('unexpected network');};
  assert.match(await handleMods('今天天气',{fetcher}),/哪个城市/);
  assert.equal(await handleMods('你好',{fetcher}),null);
});
test('weather requests and formats current, next day and seven days independently',async()=>{
  let calls=0;
  const fetcher=async url=>{calls++;const u=new URL(url);assert.equal(u.hostname,'api.open-meteo.com');assert.equal(u.searchParams.get('timezone'),'auto');return Response.json(weatherData);};
  assert.match(await queryWeather({city:'上海',period:'today'},{fetcher}),/当前：晴，23°C/);
  const tomorrow=await handleMods('上海明天天气',{fetcher});assert.match(tomorrow,/2026-10-09：雨/);assert.doesNotMatch(tomorrow,/当前：/);
  const week=await handleMods('上海未来7天天气',{fetcher});assert.match(week,/2026-10-14/);assert.equal(calls,3);
});
test('geocoding ambiguity is reported instead of guessing',async()=>{
  const result=await queryWeather({city:'Springfield',period:'today'},{fetcher:async()=>Response.json({results:[{name:'Springfield',admin1:'Illinois',country:'US'},{name:'Springfield',admin1:'Missouri',country:'US'}]})});
  assert.match(result,/多个同名/);assert.match(result,/Illinois/);
});
test('AGE extracts date, decoded title, episode and HTTPS detail URLs',()=>{
  assert.deepEqual(parseUpdatePage(page)[0],{day:'今天 (木曜日)',title:'转生 & 魔剑',episode:'第02集',url:'https://www.agedm.io/detail/123'});
  assert.equal(parseUpdatePage(page).length,2);
  assert.throws(()=>parseUpdatePage(group('今天',card('恶意','https://evil.invalid/detail/123'))));
  assert.throws(()=>parseUpdatePage('<html>访问验证</html>'));
});
test('AGE supports today, name filtering, empty matches and display limit',async()=>{
  assert.deepEqual(parseAnime('查看今天动漫更新'),{today:true,keyword:''});
  assert.deepEqual(parseAnime('动漫更新 转生'),{today:false,keyword:'转生'});
  const fetcher=async()=>new Response(page);
  const today=await handleMods('今天动漫更新',{fetcher});assert.match(today,/第02集/);assert.doesNotMatch(today,/另一部动漫/);
  assert.match(await handleMods('动漫更新 不存在',{fetcher}),/没有找到/);
  assert.match(await handleMods('动漫更新',{fetcher:async()=>new Response(group('今天',Array.from({length:25},(_,i)=>card('番'+i,'/detail/'+i)).join('')))}),/25条，展示前20条/);
});
test('HTTP errors, invalid responses and cancellation never fabricate results',async()=>{
  assert.match(await handleMods('动漫更新',{fetcher:async()=>new Response('',{status:403})}),/查询失败/);
  assert.match(await handleMods('上海天气',{fetcher:async()=>Response.json({})}),/查询失败/);
  const controller=new AbortController();controller.abort();
  await assert.rejects(handleMods('上海天气',{signal:controller.signal,fetcher:async(_,options)=>{options.signal.throwIfAborted();}}));
});
test('screenshot question and natural list questions ignore the configured character salutation',async()=>{
  for(const text of ['爱丽丝今天有什么动漫更新呢','爱丽丝，帮我查一下今天有哪些动漫更新？','今天更新了什么动漫呢','今天动漫更新了哪些呢','今天有什么动漫呢爱丽丝','今天有什么动漫呢，爱丽丝？']){
    let calls=0;
    const reply=await handleMods(text,{characterName:'爱丽丝',fetcher:async()=>{calls++;return new Response(page);}});
    assert.equal(calls,1,text);assert.match(reply,/AGE 今日动漫更新/,text);assert.match(reply,/转生 & 魔剑/,text);assert.doesNotMatch(reply,/另一部动漫|没有找到/,text);
  }
});
test('salutation stripping preserves title filters and handles weather and renamed characters',async()=>{
  const reply=await handleMods('爱丽丝，动漫更新 另一部',{characterName:'爱丽丝',fetcher:async()=>new Response(page)});
  assert.match(reply,/另一部动漫/);assert.doesNotMatch(reply,/转生 & 魔剑/);
  assert.match(await handleMods('小星(测试)，上海天气',{characterName:'小星(测试)',fetcher:async()=>Response.json(weatherData)}),/当前：晴，23°C/);
  assert.equal(await handleMods('爱丽丝，晚上好',{characterName:'爱丽丝'}),null);
});
