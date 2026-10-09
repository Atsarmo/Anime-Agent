import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const soundRoot = fileURLToPath(new URL('../', import.meta.url));
export const runtimeRoot = resolve(soundRoot, '../windows');
export const voiceLabRoot = root => resolve(root, '../sound/.local/voice-lab');
export const voiceStateRoot = root => resolve(root, '../sound/.local/settings');
