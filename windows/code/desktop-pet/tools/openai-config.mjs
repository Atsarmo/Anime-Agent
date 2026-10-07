import { readFile, mkdir, writeFile, rename, unlink, realpath, stat } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve, isAbsolute } from 'node:path';
import { normalizeApiKey } from '../dist/core/api-key.js';
import { restrictPrivatePathSync, isPrivateFileSync, isOutside } from '../dist/core/platform-files.js';
export const defaultOpenAIModel = 'gpt-6-sol';
export const configPath = root => resolve(root, '.local/openai-chat/config.json');
export async function readOpenAIConfig(root) {
  const config = JSON.parse(await readFile(configPath(root), 'utf8'));
  if (config.version !== 1 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(config.model) || !isAbsolute(config.credentialFile)) throw Error('OpenAI 配置格式无效。');
  return config;
}
export async function readOpenAIKey(root, config) {
  const file = await realpath(config.credentialFile), info = await stat(file);
  if (!isOutside(root, file) || info.size > 8192 || !isPrivateFileSync(file, info)) throw Error('OpenAI 凭据文件权限或位置无效。');
  const key = normalizeApiKey(await readFile(file, 'utf8'));
  if (!key) throw Error('OpenAI 凭据格式无效。');
  return key;
}
export async function saveOpenAIConfig(root, key, model) {
  const normalized = normalizeApiKey(key);
  if (!normalized || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(model)) throw Error('请输入完整 API Key 和有效模型 ID。');
  const external = resolve(homedir(), '.aaaagent/openai', createHash('sha256').update(root).digest('hex').slice(0,24));
  await mkdir(external, { recursive: true }); restrictPrivatePathSync(external);
  const credentialFile = resolve(external, randomUUID() + '.key');
  await writeFile(credentialFile, '', { flag: 'wx', mode: 0o600 }); restrictPrivatePathSync(credentialFile);
  await writeFile(credentialFile, normalized + '\n', { mode: 0o600 });
  const directory = resolve(root, '.local/openai-chat');
  await mkdir(directory, { recursive: true }); restrictPrivatePathSync(directory);
  const temporary = resolve(directory, randomUUID() + '.next');
  try {
    await writeFile(temporary, '', { flag: 'wx', mode: 0o600 }); restrictPrivatePathSync(temporary);
    await writeFile(temporary, JSON.stringify({version:1,model,credentialFile})+'\n');
    await rename(temporary, configPath(root));
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
