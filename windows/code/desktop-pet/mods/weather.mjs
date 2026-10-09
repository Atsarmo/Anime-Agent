import { pinyin } from 'pinyin-pro';
import { getText } from './http.mjs';

// Stable coordinates also keep common Chinese cities usable when geocoding is unavailable.
const cities = { 北京:[39.9042,116.4074], 上海:[31.2304,121.4737], 广州:[23.1291,113.2644], 深圳:[22.5431,114.0579], 杭州:[30.2741,120.1551], 成都:[30.5728,104.0668], 重庆:[29.563,106.5516], 武汉:[30.5928,114.3055], 西安:[34.3416,108.9398], 南京:[32.0603,118.7969], 苏州:[31.2989,120.5853], 天津:[39.3434,117.3616], 长沙:[28.2282,112.9388], 郑州:[34.7466,113.6254], 青岛:[36.0671,120.3826], 厦门:[24.4798,118.0894], 福州:[26.0745,119.2965], 昆明:[25.0389,102.7183], 济南:[36.6512,117.1201], 合肥:[31.8206,117.2272], 哈尔滨:[45.8038,126.5349], 沈阳:[41.8057,123.4315], 长春:[43.8171,125.3235], 大连:[38.914,121.6147], 南宁:[22.817,108.3669], 南昌:[28.6829,115.8579], 贵阳:[26.647,106.6302], 海口:[20.044,110.1999], 香港:[22.3193,114.1694], 台北:[25.033,121.5654] };
export function parseWeather(raw) {
  let text=raw.trim().replace(/[？?。！!]+$/,'');
  if (!/(?:天气|气温|下雨)/.test(text) || /提醒我/.test(text)) return null;
  const period=/未来(?:七|7|一周)天?|一周|七天|7天/.test(text)?'week':/后天/.test(text)?'after':/明天/.test(text)?'tomorrow':'today';
  text=text.replace(/^(?:请|麻烦)?(?:帮我|给我)?(?:查询|查一下|查查|查看|查找|看看|查)?\s*/, '')
    .replace(/未来(?:七|7)天|未来一周|一周|七天|7天|今天|明天|后天|现在|实时/g,'')
    .replace(/天气预报|天气|气温|会不会下雨|是否下雨|下雨/g,'')
    .replace(/怎么样|如何|怎样|多少度|多少|情况|预报|查询|更新|查一下|查看|吗|呢/g,'').replace(/的/g,'').trim();
  if(text.length>60 || /[，,。！!？?]/.test(text)) return null;
  return { city:text.replace(/市$/,''), period };
}
function condition(code) {
  if(code===0)return '晴'; if([1,2].includes(code))return '少云'; if(code===3)return '阴';
  if([45,48].includes(code))return '雾'; if([51,53,55,56,57].includes(code))return '毛毛雨';
  if([61,63,65,66,67,80,81,82].includes(code))return '雨';
  if([71,73,75,77,85,86].includes(code))return '雪'; if([95,96,99].includes(code))return '雷雨'; return '天气状况未知';
}
const value=n=>Number.isFinite(n)?n:'暂无';
export async function queryWeather(action, options={}) {
  if(!action.city)return '请告诉我要查哪个城市，例如“上海天气”“北京明天天气”或“杭州未来7天天气”。';
  let location;
  if(cities[action.city]){const [latitude,longitude]=cities[action.city];location={name:action.city,latitude,longitude};}
  else {
    let results;
    for(const name of [...new Set([action.city,pinyin(action.city,{toneType:'none',separator:''})])]){
      const url=new URL('https://geocoding-api.open-meteo.com/v1/search');url.search=new URLSearchParams({name,count:'5',language:'zh',format:'json'}).toString();
      const data=JSON.parse(await getText(url,options));results=data.results;
      if(results?.length)break;
    }
    if(!results?.length)return `未找到城市“${action.city}”，请补充省份或使用城市英文名。`;
    if(results.length>1)return '找到多个同名地点，请使用更具体的地点名称：\n'+results.map(r=>[r.name,r.admin1,r.country].filter(Boolean).join(' · ')).join('\n');
    location=results[0];
  }
  const url=new URL('https://api.open-meteo.com/v1/forecast');
  url.search=new URLSearchParams({latitude:String(location.latitude),longitude:String(location.longitude),current:'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m',daily:'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',timezone:'auto',forecast_days:'7'}).toString();
  const data=JSON.parse(await getText(url,options)),d=data.daily,c=data.current;
  if(!Array.isArray(d?.time)||d.time.length<7||!c?.time)throw Error('天气响应不完整');
  const indexes=action.period==='week'?[0,1,2,3,4,5,6]:[action.period==='tomorrow'?1:action.period==='after'?2:0];
  const rows=indexes.map(i=>`${d.time[i]}：${condition(d.weather_code?.[i])}，${value(d.temperature_2m_min?.[i])}～${value(d.temperature_2m_max?.[i])}°C，降水概率 ${value(d.precipitation_probability_max?.[i])}%`);
  if(action.period==='today')rows.unshift(`当前：${condition(c.weather_code)}，${value(c.temperature_2m)}°C（体感 ${value(c.apparent_temperature)}°C），湿度 ${value(c.relative_humidity_2m)}%，风速 ${value(c.wind_speed_10m)} km/h`);
  return `${location.name}天气\n${rows.join('\n')}\n数据时间：${c.time}（${data.timezone}）\n来源：Open-Meteo https://open-meteo.com/`;
}
