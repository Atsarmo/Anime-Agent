// Keep early Japanese audio private until its Chinese sentence is validated.
export class VoiceChunks {
  #queue=[];#done=false;#wake;#bytes=0;#signal;
  constructor(signal){this.#signal=signal;signal?.addEventListener('abort',()=>this.dispose(),{once:true});}
  push(audio){
    if(this.#done||this.#signal?.aborted){audio.fill(0);return;}
    this.#bytes+=audio.length;if(this.#bytes>12*1024*1024){audio.fill(0);throw Error('生成音频过长。');}
    this.#queue.push(audio);this.#wake?.();
  }
  end(){this.#done=true;this.#wake?.();}
  dispose(){this.end();for(const audio of this.#queue)audio.fill(0);this.#queue=[];}
  async *[Symbol.asyncIterator](){
    while(!this.#signal?.aborted){
      if(this.#queue.length){yield this.#queue.shift();continue;}
      if(this.#done)return;
      await new Promise(done=>{this.#wake=done;});this.#wake=undefined;
    }
  }
}
