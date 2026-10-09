"""Local, authenticated, one-engine-at-a-time voice worker. Models stay outside Git."""
import argparse, os, sys, json, io, time, wave, base64, threading, traceback, secrets
from pathlib import Path
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

parser=argparse.ArgumentParser()
parser.add_argument('--lab',required=True);parser.add_argument('--engine',choices=['stylebert','cosyvoice','fish','fish-finetuned','rvc'],required=True);parser.add_argument('--port',type=int,default=0);parser.add_argument('--state-file')
args=parser.parse_args();LAB=Path(args.lab).resolve();TOKEN=os.environ['PET_VOICE_TOKEN']
os.environ['PATH']=str(LAB/'bin')+os.pathsep+os.environ.get('PATH','')
import numpy as np
import torch
torch.set_num_threads(4)

def wav_bytes(rate,audio):
    audio=np.asarray(audio).reshape(-1)
    if audio.dtype!=np.int16:audio=(np.clip(audio,-1,1)*32767).astype('<i2')
    output=io.BytesIO()
    with wave.open(output,'wb') as f:f.setnchannels(1);f.setsampwidth(2);f.setframerate(rate);f.writeframes(audio.tobytes())
    return output.getvalue()

def load_style(name):
    repo=LAB/'repos/Style-Bert-VITS2';sys.path.insert(0,str(repo));os.chdir(repo)
    from style_bert_vits2.tts_model import TTSModel
    from style_bert_vits2.constants import Languages
    assets=repo/'model_assets'/name
    if name=='aris':
        selection=json.loads((LAB/'stylebert-model.json').read_text(encoding='utf-8'));model=Path(selection['model'])
    else:model=assets/'jvnv-F1-jp_e160_s14000.safetensors'
    return TTSModel(model_path=model,config_path=assets/'config.json',style_vec_path=assets/'style_vectors.npy',device='cuda'),Languages.JP

class StyleEngine:
    def __init__(self):self.model,self.language=load_style('aris')
    def generate(self,text,speed):
        rate,audio=self.model.infer(text=text,language=self.language,speaker_id=0,length=1/speed,split_interval=0.15,line_split=False)
        yield rate,audio

class CosyEngine:
    def __init__(self):
        repo=LAB/'repos/CosyVoice';sys.path[:0]=[str(repo),str(repo/'third_party/Matcha-TTS')];os.chdir(repo)
        import pyopenjtalk
        from cosyvoice.cli.cosyvoice import AutoModel
        self.kana=lambda text:pyopenjtalk.g2p(text,kana=True)
        self.model=AutoModel(model_dir=str(LAB/'models/cosyvoice3'),fp16=True)
        reference=json.loads((LAB/'reference.json').read_text(encoding='utf-8'))
        self.ref=reference['short_audio'];prompt='You are a helpful assistant.<|endofprompt|>'+self.kana(reference['short_text'])
        self.model.add_zero_shot_spk(prompt,self.ref,'aris')
    def generate(self,text,speed):
        # Upstream grows this value during streaming; reset it for each utterance.
        self.model.model.token_hop_len=25
        for chunk in self.model.inference_zero_shot(self.kana(text),'',self.ref,zero_shot_spk_id='aris',stream=True,speed=speed,text_frontend=False):
            yield self.model.sample_rate,chunk['tts_speech'].float().cpu().numpy().reshape(-1)

class FishEngine:
    def __init__(self,finetuned=False):
        from voice_cache import VoiceCache
        self.audio_cache=VoiceCache()
        try:performance=json.loads((LAB/'fish-performance.json').read_text(encoding='utf-8'))
        except (OSError,ValueError):performance={}
        verified=performance.get('cudaGraph') is True and performance.get('torch')==torch.__version__ and performance.get('gpu')==torch.cuda.get_device_name(0)
        use_graph=os.environ.get('PET_FISH_CUDA_GRAPH','1' if verified else '0')=='1'
        repo=LAB/'repos/fish-speech';sys.path.insert(0,str(repo));os.chdir(repo)
        from fish_speech.inference_engine import TTSInferenceEngine
        from fish_speech.models.dac.inference import load_model
        from fish_speech.models.text2semantic import inference as semantic
        from fish_speech.utils.schema import ServeTTSRequest,ServeReferenceAudio
        self.request=ServeTTSRequest
        reference=json.loads((LAB/'reference.json').read_text(encoding='utf-8'))
        self.reference=ServeReferenceAudio(audio=Path(reference['short_audio']).read_bytes(),text=reference['short_text'])
        self.expressive_reference=self.reference
        expression_file=LAB/'fish-expression.json'
        if expression_file.exists():
            expressive=json.loads(expression_file.read_text(encoding='utf-8'))
            audio=Path(expressive['audio']).resolve()
            if not audio.is_relative_to(LAB):raise ValueError('Fish reference must be stored in the local voice lab')
            self.expressive_reference=ServeReferenceAudio(audio=audio.read_bytes(),text=expressive['text'])
        model=LAB/'models/s2-pro'
        # Desktop replies need short contexts; a 32k KV cache competes with Live2D VRAM.
        original_init=semantic.init_model
        def init_short_context(*argv,**kwargs):
            loaded,decode=original_init(*argv,**kwargs)
            from fish_context import limit_context
            limit_context(loaded)
            if finetuned:
                from fish_adapter import merge_fast_adapter
                selection=json.loads((LAB/'fish-adapter.json').read_text(encoding='utf-8'))
                checkpoint=Path(selection['checkpoint']).resolve()
                if not checkpoint.is_relative_to(LAB):raise ValueError('Fish adapter must be stored in the local voice lab')
                merge_fast_adapter(loaded,torch.load(checkpoint,map_location='cpu',weights_only=True))
            # Release the old 32k attention mask and temporary adapter buffers
            # before loading the audio codec or capturing CUDA graphs.
            torch.cuda.empty_cache()
            if use_graph:
                from fish_acceleration import CudaTokenDecoder
                self.token_decoder=CudaTokenDecoder(decode)
                decode=self.token_decoder
            return loaded,decode
        semantic.init_model=init_short_context
        try:queue=semantic.launch_thread_safe_queue(checkpoint_path=str(model),device='cuda',precision=torch.bfloat16,compile=False)
        finally:semantic.init_model=original_init
        decoder=load_model('modded_dac_vq',str(model/'codec.pth'),device='cuda')
        from fish_codec import compact_codec
        compact_codec(decoder)
        torch.cuda.empty_cache()
        self.model=TTSInferenceEngine(llama_queue=queue,decoder_model=decoder,precision=torch.bfloat16,compile=False)
    @property
    def acceleration(self):return getattr(getattr(self,'token_decoder',None),'mode','eager')
    def generate(self,text,speed,expression='natural'):
        from fish_expression import expression_text
        from fish_pacing import punctuation_pauses
        spoken=expression_text(punctuation_pauses(text),expression)
        cached=self.audio_cache.get((text,speed,expression))
        if cached is not None:
            yield from cached
            return
        reference=self.reference if expression=='natural' else self.expressive_reference
        request=self.request(text=spoken,references=[reference],use_memory_cache='on',streaming=True,chunk_length=100,max_new_tokens=600,seed=42)
        emitted=False;frames=[]
        for result in self.model.inference(request):
            if result.code=='error':raise result.error
            if result.code=='segment' or result.code=='final' and not emitted:
                rate,audio=result.audio;emitted=True
                if speed!=1:
                    from fish_tempo import adjust_tempo
                    audio=adjust_tempo(rate,audio,speed,LAB/'bin/ffmpeg.exe')
                frames.append((rate,np.asarray(audio)))
                yield rate,audio
        self.audio_cache.put((text,speed,expression),frames)

class RvcEngine:
    def __init__(self):
        self.source,self.language=load_style('jvnv-F1-jp')
        repo=LAB/'repos/RVC';sys.path.insert(0,str(repo));os.chdir(repo)
        os.environ['weight_root']=str(repo/'assets/weights');os.environ['index_root']=str(repo/'assets/indices');os.environ['outside_index_root']=str(repo/'assets/indices');os.environ['rmvpe_root']=str(repo/'assets/rmvpe')
        # RVC's config parser owns argv; isolate it from this worker's arguments.
        saved=sys.argv;sys.argv=[saved[0]]
        try:
            from configs.config import Config
            from infer.vc.modules import VC
            self.vc=VC(Config());self.vc.get_vc('aris.pth')
        finally:sys.argv=saved
        self.index=str(repo/'assets/indices/aris.index')
    def generate(self,text,speed):
        import soundfile as sf
        rate,audio=self.source.infer(text=text,language=self.language,speaker_id=0,length=1/speed,line_split=False)
        temp=LAB/'temp/rvc-source.wav';sf.write(temp,audio,rate)
        result,output=self.vc.vc_single(0,str(temp),0,'rmvpe',self.index,0.6,0,0.25,0.33)
        rate,audio=output
        if audio is None:raise RuntimeError(result)
        yield rate,audio

model=None;load_error=None;lock=threading.Lock()
def initialize():
    global model,load_error
    try:
        candidate={'stylebert':StyleEngine,'cosyvoice':CosyEngine,'fish':FishEngine,'fish-finetuned':lambda:FishEngine(finetuned=True),'rvc':RvcEngine}[args.engine]()
        # Load lazy text/audio components before reporting that the service is ready.
        for rate,audio in candidate.generate('先生、おかえりなさい。',1):
            if not np.isfinite(np.asarray(audio)).all():raise ValueError('Invalid warm-up audio')
        model=candidate
    except Exception as e:
        load_error=str(e);traceback.print_exc()
        # A failed capture can invalidate the CUDA context; restart eagerly next time.
        if args.engine in ('fish','fish-finetuned') and getattr(getattr(locals().get('candidate'),'token_decoder',None),'disabled',False):
            (LAB/'fish-performance.json').write_text(json.dumps(dict(cudaGraph=False)),encoding='utf-8')

class Handler(BaseHTTPRequestHandler):
    def log_message(self,format,*values):
        if self.path!='/health':super().log_message(format,*values)
    def json(self,code,value):
        data=json.dumps(value,ensure_ascii=False).encode();self.send_response(code);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
    def authorized(self):return self.headers.get('Authorization')=='Bearer '+TOKEN
    def do_GET(self):
        if not self.authorized():return self.json(401,{'error':'Unauthorized'})
        if self.path=='/health':return self.json(200,dict(engine=args.engine,ready=model is not None,error=load_error,pid=os.getpid(),acceleration=getattr(model,'acceleration','standard')))
        self.json(404,{'error':'Unknown route'})
    def do_POST(self):
        if not self.authorized():return self.json(401,{'error':'Unauthorized'})
        if self.path=='/shutdown':
            self.json(200,{'ok':True});threading.Thread(target=lambda:(time.sleep(.1),os._exit(0)),daemon=True).start();return
        if self.path!='/tts':return self.json(404,{'error':'Unknown route'})
        if model is None:return self.json(503,{'error':'Model not ready'})
        started=False
        try:
            length=int(self.headers.get('Content-Length','0'))
            if length<=0 or length>20000:raise ValueError('Invalid body')
            body=json.loads(self.rfile.read(length));text=body['text'];speed=body.get('speed',1)
            if not isinstance(text,str) or not text.strip() or len(text)>1500 or not isinstance(speed,(int,float)) or not .5<=speed<=2:raise ValueError('Invalid text or speed')
            with lock:
                chunks=[]
                generated=model.generate(text,speed,body.get('fishExpression','natural')) if isinstance(model,FishEngine) else model.generate(text,speed)
                for rate,audio in generated:
                    if body.get('stream'):
                        if not started:self.send_response(200);self.send_header('Content-Type','application/x-ndjson');self.end_headers();started=True
                        data={'audio':base64.b64encode(wav_bytes(rate,audio)).decode()};self.wfile.write(json.dumps(data).encode()+b'\n');self.wfile.flush()
                    else:chunks.append(np.asarray(audio))
                if not body.get('stream'):
                    audio=wav_bytes(rate,np.concatenate(chunks));self.send_response(200);self.send_header('Content-Type','audio/wav');self.send_header('Content-Length',str(len(audio)));self.end_headers();started=True;self.wfile.write(audio)
        except (BrokenPipeError,ConnectionResetError,ConnectionAbortedError):pass
        except Exception:
            traceback.print_exc()
            if started:
                try:self.wfile.write(b'{"error":"Synthesis failed"}\n');self.wfile.flush()
                except OSError:pass
            else:self.json(500,{'error':'Synthesis failed'})

if __name__=='__main__':
    for attempt in range(16):
        try:
            server=ThreadingHTTPServer(('127.0.0.1',args.port or 49152+secrets.randbelow(16384)),Handler)
            break
        except OSError:
            if args.port or attempt==15:raise
    if args.state_file:
        file=Path(args.state_file);temporary=file.with_suffix('.next')
        temporary.write_text(json.dumps(dict(engine=args.engine,token=TOKEN,pid=os.getpid(),port=server.server_address[1])),encoding='utf-8')
        temporary.replace(file)
    threading.Thread(target=initialize,daemon=True).start()
    server.serve_forever()
