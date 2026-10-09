import {JellyfishRenderer} from './cubism-renderer.mjs';
import {defaultFraming,framingCrop,cropFraming,framingSourceScale} from './model-framing.mjs';

export async function createFramingEditor({stage,source,selection,handle,output,onChange,profile,mode}){
  const renderer=new JellyfishRenderer(source,()=>{},{ssaaSamples:16,textureMaxSize:1024,assetBase:'/framing-assets/model/',shaderBase:'/framing-assets/shaders/'});
  let current=profile,currentMode=mode,drag,disposed=false,frame,lastSize='';
  try{await renderer.load();renderer.setFraming('full');renderer.setFramingProfile({...defaultFraming,full:{scale:framingSourceScale*100,x:0,y:0}});}
  catch(error){renderer.dispose();throw error;}
  function draw(){
    if(disposed||stage.clientWidth<1)return;
    const size=[source.clientWidth,source.clientHeight,devicePixelRatio].join(',');
    if(size!==lastSize){renderer.draw();lastSize=size;}
    const rect=framingCrop(currentMode,current[currentMode]);
    Object.assign(selection.style,{left:rect.left*100+'%',top:rect.top*100+'%',width:rect.width*100+'%',height:rect.width*100+'%'});
    const dpr=Math.min(2,devicePixelRatio||1),w=Math.max(1,Math.round(output.clientWidth*dpr)),h=Math.round(w*340/360);
    if(output.width!==w||output.height!==h){output.width=w;output.height=h;}
    const ctx=output.getContext('2d');ctx.clearRect(0,0,w,h);ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
    ctx.drawImage(source,rect.left*source.width,rect.top*source.height,rect.width*source.width,rect.width*source.height,0,0,w,h);
    if(currentMode==='half'){
      const fade=ctx.createLinearGradient(0,h*.88,0,h);fade.addColorStop(0,'rgba(0,0,0,1)');fade.addColorStop(1,'rgba(0,0,0,0)');
      ctx.globalCompositeOperation='destination-in';ctx.fillStyle=fade;ctx.fillRect(0,0,w,h);ctx.globalCompositeOperation='source-over';
    }
    stage.dataset.ready='true';
  }
  function apply(rect){const value=cropFraming(currentMode,rect);current={...current,[currentMode]:value};onChange(value);draw();}
  function down(event){
    if(event.button!==0||disposed)return;
    event.preventDefault();selection.focus({preventScroll:true});
    drag={id:event.pointerId,x:event.clientX,y:event.clientY,rect:framingCrop(currentMode,current[currentMode]),resize:event.target===handle};
    stage.setPointerCapture(event.pointerId);
  }
  function move(event){
    if(!drag||event.pointerId!==drag.id)return;
    const dx=(event.clientX-drag.x)/stage.clientWidth,dy=(event.clientY-drag.y)/stage.clientHeight;
    apply(drag.resize?{...drag.rect,width:Math.max(.001,drag.rect.width+(dx+dy)/2)}:{...drag.rect,left:drag.rect.left+dx,top:drag.rect.top+dy});
  }
  function end(){drag=null;}
  selection.addEventListener('pointerdown',down);stage.addEventListener('pointermove',move);stage.addEventListener('pointerup',end);stage.addEventListener('pointercancel',end);stage.addEventListener('lostpointercapture',end);
  function key(event){const steps={ArrowLeft:[-.005,0],ArrowRight:[.005,0],ArrowUp:[0,-.005],ArrowDown:[0,.005]};const step=steps[event.key];if(!step)return;event.preventDefault();const rect=framingCrop(currentMode,current[currentMode]);apply({...rect,left:rect.left+step[0],top:rect.top+step[1]});}
  selection.addEventListener('keydown',key);
  const observer=new ResizeObserver(()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(draw);});observer.observe(stage);draw();
  return {setProfile(p,m){if(m!==currentMode)drag=null;current=p;currentMode=m;draw();},dispose(){disposed=true;observer.disconnect();cancelAnimationFrame(frame);selection.removeEventListener('pointerdown',down);selection.removeEventListener('keydown',key);stage.removeEventListener('pointermove',move);stage.removeEventListener('pointerup',end);stage.removeEventListener('pointercancel',end);stage.removeEventListener('lostpointercapture',end);renderer.dispose();}};
}
