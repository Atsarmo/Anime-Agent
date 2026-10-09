export function ssaaSize(cssWidth,cssHeight,dpr,samples,limit=4096){
  const baseWidth=Math.max(1,Math.round(cssWidth*dpr)),baseHeight=Math.max(1,Math.round(cssHeight*dpr));
  const requested=Math.sqrt(Math.max(1,samples));
  const scale=Math.min(requested,limit/baseWidth,limit/baseHeight,Math.sqrt(32000000/(baseWidth*baseHeight)));
  const width=Math.max(1,Math.floor(baseWidth*scale)),height=Math.max(1,Math.floor(baseHeight*scale));
  const actualSamples=width*height/(baseWidth*baseHeight);
  return {width,height,actualSamples,limited:actualSamples+0.02<Math.max(1,samples)};
}
export class GpuTimer{
  constructor(gl){this.gl=gl;this.ext=gl.getExtension('EXT_disjoint_timer_query');this.ms=null;}
  begin(){const gl=this.gl,e=this.ext;if(!e)return;
    if(gl.getParameter(e.GPU_DISJOINT_EXT)){this.ms=null;if(this.pending){e.deleteQueryEXT(this.pending);this.pending=null;}return;}
    if(this.pending&&e.getQueryObjectEXT(this.pending,e.QUERY_RESULT_AVAILABLE_EXT)){const ms=e.getQueryObjectEXT(this.pending,e.QUERY_RESULT_EXT)/1e6;this.ms=this.ms===null?ms:this.ms*.8+ms*.2;e.deleteQueryEXT(this.pending);this.pending=null;}
    if(!this.pending){this.active=e.createQueryEXT();e.beginQueryEXT(e.TIME_ELAPSED_EXT,this.active);}
  }
  end(){if(this.active){this.ext.endQueryEXT(this.ext.TIME_ELAPSED_EXT);this.pending=this.active;this.active=null;}}
  dispose(){if(this.pending)this.ext.deleteQueryEXT(this.pending);}
}
