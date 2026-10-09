export const defaultFraming={full:{scale:100,x:0,y:0},half:{scale:100,x:0,y:0}};
export function validateFraming(value){
  const result={};
  for(const mode of ['full','half']){
    const p=value?.[mode];
    if(!p||!Number.isFinite(p.scale)||p.scale<50||p.scale>150||!Number.isFinite(p.x)||Math.abs(p.x)>40||!Number.isFinite(p.y)||Math.abs(p.y)>40)throw Error('角色缩放范围为 50～150%，位置范围为 -40～40%。');
    result[mode]={scale:p.scale,x:p.x,y:p.y};
  }
  return result;
}
export function framingTransform(mode,profile=defaultFraming){
  const p=profile[mode]??defaultFraming.full,s=p.scale/100;
  return {zoom:(mode==='half'?3.2:1)*s,x:p.x/50,y:(mode==='half'?-1.35:0)*s-p.y/50};
}
export const framingSourceScale=.8;
export function framingCrop(mode,value){
  const {zoom,x,y}=framingTransform(mode,{[mode]:value}),width=framingSourceScale/zoom;
  return {left:.5-x*framingSourceScale/(2*zoom)-width/2,top:.5+y*framingSourceScale/(2*zoom)-width/2,width};
}
export function cropFraming(mode,rect){
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v)),base=mode==='half'?3.2:1;
  const scale=clamp(framingSourceScale/(Math.max(.001,rect.width)*base)*100,50,150),zoom=base*scale/100;
  const cx=rect.left+rect.width/2,cy=rect.top+rect.width/2;
  return {scale,x:clamp((.5-cx)*100*zoom/framingSourceScale,-40,40),y:clamp(((mode==='half'?-1.35:0)*scale/100-(cy-.5)*2*zoom/framingSourceScale)*50,-40,40)};
}
