import { SMAAEdgesShader, SMAAWeightsShader, SMAABlendShader } from './smaa/shaders.mjs';
import { lookups } from './smaa/lookups.mjs';

// Resolve the native MSAA canvas first, then SSAA downsample and run SMAA at
// physical display resolution. Color and alpha remain premultiplied throughout.
export class SMAAPostprocess {
  constructor(gl) { this.gl=gl; this.targets=[]; this.programs=[]; this.lookups=[]; }
  program(spec) {
    const gl=this.gl, defines=Object.entries(spec.defines??{}).map(([k,v])=>`#define ${k} ${v}`).join('\n');
    const shaders=[gl.VERTEX_SHADER,gl.FRAGMENT_SHADER].map((type,i)=>{
      const shader=gl.createShader(type);
      const prefix=i===0?'attribute vec2 position; attribute vec2 uv;':'';
      gl.shaderSource(shader,`precision highp float;\n${defines}\n${prefix}\n${i===0?spec.vertexShader:spec.fragmentShader}`);
      gl.compileShader(shader);
      if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)){const message=gl.getShaderInfoLog(shader);gl.deleteShader(shader);throw Error(message);}
      return shader;
    });
    const program=gl.createProgram();shaders.forEach(s=>gl.attachShader(program,s));
    gl.bindAttribLocation(program,0,'position');gl.bindAttribLocation(program,1,'uv');gl.linkProgram(program);shaders.forEach(s=>gl.deleteShader(s));
    if(!gl.getProgramParameter(program,gl.LINK_STATUS)){const message=gl.getProgramInfoLog(program);gl.deleteProgram(program);throw Error(message);}
    this.programs.push(program);return program;
  }
  async load() {
    const gl=this.gl;
    // VAOs isolate the two fullscreen attributes from Cubism's vertex state.
    this.vaoExtension=gl.getExtension('OES_vertex_array_object');
    if(!this.vaoExtension)throw Error('SMAA requires vertex array objects');
    this.copy=this.program({vertexShader:'varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position,0.,1.);}',fragmentShader:`
      varying vec2 vUv; uniform sampler2D tColor; uniform vec2 sourceSize, destinationSize; uniform float downsample;
      void main(){
        vec4 c=vec4(0.);
        if(downsample>0.5){
          for(int y=0;y<4;y++)for(int x=0;x<4;x++){
            vec2 offset=(vec2(float(x),float(y))+.5)/4.-.5;
            c+=texture2D(tColor,vUv+offset/destinationSize);
          }
          c/=16.;
        }else c=texture2D(tColor,vUv);
        gl_FragColor=c;
      }`});
    this.edges=this.program(SMAAEdgesShader);this.weights=this.program(SMAAWeightsShader);this.blend=this.program(SMAABlendShader);
    const images=await Promise.all(lookups.map(async src=>{
      const bytes=Uint8Array.from(atob(src.split(',')[1]),c=>c.charCodeAt(0));
      const url=URL.createObjectURL(new Blob([bytes],{type:'image/png'}));
      try{const img=new Image();img.src=url;await img.decode();return img;}finally{URL.revokeObjectURL(url);}
    }));
    const previousTexture=gl.getParameter(gl.TEXTURE_BINDING_2D),premultiply=gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL),flip=gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL);
    try{
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
      images.forEach((img,i)=>{const texture=this.texture(i===1?gl.NEAREST:gl.LINEAR);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,img);this.lookups.push(texture);});
    }finally{gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,premultiply);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,flip);gl.bindTexture(gl.TEXTURE_2D,previousTexture);}
    const previousVao=gl.getParameter(this.vaoExtension.VERTEX_ARRAY_BINDING_OES),previousBuffer=gl.getParameter(gl.ARRAY_BUFFER_BINDING);
    this.vao=this.vaoExtension.createVertexArrayOES();this.vaoExtension.bindVertexArrayOES(this.vao);
    this.buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,0,0,1,-1,1,0,-1,1,0,1,1,1,1,1]),gl.STATIC_DRAW);
    for(let i=0;i<2;i++){gl.enableVertexAttribArray(i);gl.vertexAttribPointer(i,2,gl.FLOAT,false,16,i*8);}
    this.vaoExtension.bindVertexArrayOES(previousVao);gl.bindBuffer(gl.ARRAY_BUFFER,previousBuffer);this.ready=true;
  }
  texture(filter) {
    const gl=this.gl,texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,filter);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,filter);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);return texture;
  }
  target(width,height) {
    const gl=this.gl,texture=this.texture(gl.LINEAR),framebuffer=gl.createFramebuffer();
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
    gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
    if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE){gl.deleteTexture(texture);gl.deleteFramebuffer(framebuffer);throw Error('SMAA framebuffer incomplete');}
    const target={texture,framebuffer};this.targets.push(target);return target;
  }
  releaseTargets() { for(const t of this.targets){this.gl.deleteTexture(t.texture);this.gl.deleteFramebuffer(t.framebuffer);}this.targets=[];this.size=''; }
  apply(canvas) {
    if(!this.ready)return;
    const gl=this.gl,vao=this.vaoExtension;
    const saved={framebuffer:gl.getParameter(gl.FRAMEBUFFER_BINDING),viewport:gl.getParameter(gl.VIEWPORT),program:gl.getParameter(gl.CURRENT_PROGRAM),vao:gl.getParameter(vao.VERTEX_ARRAY_BINDING_OES),active:gl.getParameter(gl.ACTIVE_TEXTURE),mask:gl.getParameter(gl.COLOR_WRITEMASK),clear:gl.getParameter(gl.COLOR_CLEAR_VALUE)};
    const caps=[gl.BLEND,gl.SCISSOR_TEST,gl.CULL_FACE,gl.DEPTH_TEST,gl.STENCIL_TEST,gl.DITHER].map(c=>[c,gl.isEnabled(c)]);
    const textures=[0,1,2].map(i=>{gl.activeTexture(gl.TEXTURE0+i);return gl.getParameter(gl.TEXTURE_BINDING_2D);});
    try{
      caps.forEach(([c])=>gl.disable(c));gl.colorMask(true,true,true,true);gl.clearColor(0,0,0,0);vao.bindVertexArrayOES(this.vao);gl.activeTexture(gl.TEXTURE0);
      const ratio=globalThis.devicePixelRatio||1,w=Math.min(canvas.width,Math.max(1,Math.round(canvas.clientWidth*ratio))),h=Math.min(canvas.height,Math.max(1,Math.round(canvas.clientHeight*ratio)));
      const size=`${canvas.width},${canvas.height},${w},${h}`;
      if(this.size!==size){this.releaseTargets();this.source=this.target(canvas.width,canvas.height);this.color=this.target(w,h);this.edgeTarget=this.target(w,h);this.weightTarget=this.target(w,h);this.output=this.target(w,h);this.size=size;}
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.bindTexture(gl.TEXTURE_2D,this.source.texture);gl.copyTexSubImage2D(gl.TEXTURE_2D,0,0,0,0,0,canvas.width,canvas.height);
      const run=(program,target,width,height,inputs,downsample=0)=>{
        gl.bindFramebuffer(gl.FRAMEBUFFER,target?.framebuffer??null);gl.viewport(0,0,width,height);gl.clear(gl.COLOR_BUFFER_BIT);gl.useProgram(program);
        gl.uniform2f(gl.getUniformLocation(program,'resolution'),1/w,1/h);gl.uniform2f(gl.getUniformLocation(program,'sourceSize'),canvas.width,canvas.height);gl.uniform2f(gl.getUniformLocation(program,'destinationSize'),w,h);gl.uniform1f(gl.getUniformLocation(program,'downsample'),downsample);
        inputs.forEach(([name,texture],i)=>{gl.activeTexture(gl.TEXTURE0+i);gl.bindTexture(gl.TEXTURE_2D,texture);gl.uniform1i(gl.getUniformLocation(program,name),i);});gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
      };
      run(this.copy,this.color,w,h,[['tColor',this.source.texture]],1);
      run(this.edges,this.edgeTarget,w,h,[['tDiffuse',this.color.texture]]);
      run(this.weights,this.weightTarget,w,h,[['tDiffuse',this.edgeTarget.texture],['tArea',this.lookups[0]],['tSearch',this.lookups[1]]]);
      run(this.blend,this.output,w,h,[['tDiffuse',this.weightTarget.texture],['tColor',this.color.texture]]);
      run(this.copy,null,canvas.width,canvas.height,[['tColor',this.output.texture]]);
      canvas.dataset.smaa='active';
    }finally{
      textures.forEach((texture,i)=>{gl.activeTexture(gl.TEXTURE0+i);gl.bindTexture(gl.TEXTURE_2D,texture);});gl.activeTexture(saved.active);vao.bindVertexArrayOES(saved.vao);
      gl.useProgram(saved.program);gl.bindFramebuffer(gl.FRAMEBUFFER,saved.framebuffer);gl.viewport(...saved.viewport);gl.colorMask(...saved.mask);gl.clearColor(...saved.clear);caps.forEach(([c,on])=>on?gl.enable(c):gl.disable(c));
    }
  }
  dispose() { this.releaseTargets();this.programs.forEach(p=>this.gl.deleteProgram(p));this.lookups.forEach(t=>this.gl.deleteTexture(t));if(this.buffer)this.gl.deleteBuffer(this.buffer);if(this.vao)this.vaoExtension.deleteVertexArrayOES(this.vao);this.ready=false; }
}
