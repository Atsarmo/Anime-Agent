import {runtimeRoot as root} from '../src/paths.mjs';
import {readVoice} from '../src/voice-settings.mjs';
import {ensureVoiceEngine} from '../src/voice-engines.mjs';
const voice=await readVoice(root);
if(voice.enabled&&voice.engine!=='gpt-sovits')await ensureVoiceEngine(root,voice.engine);
