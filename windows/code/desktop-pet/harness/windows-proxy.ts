import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const proxyKeys = new Set(['http_proxy','https_proxy','all_proxy','ws_proxy','wss_proxy']);

function localProxy(value: string | undefined): string | undefined {
  if (!value || !/^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/i.test(value)) return;
  try {
    const url = new URL(value.includes('://') ? value : 'http://' + value);
    if (!url.port || Number(url.port) < 1 || Number(url.port) > 65535) return;
    return url.origin;
  } catch { return; }
}

/** Follow an already enabled local Windows proxy without changing global settings. */
export function applyWindowsProxy(env: NodeJS.ProcessEnv, settings: {ProxyEnable?: number; ProxyServer?: string}): NodeJS.ProcessEnv {
  const result = {...env};
  if (Object.entries(env).some(([key,value]) => value && proxyKeys.has(key.toLowerCase())) || settings.ProxyEnable !== 1) return result;
  const server = settings.ProxyServer?.trim();
  if (!server) return result;
  const entries = new Map(server.split(';').map(entry => {
    const separator = entry.indexOf('=');
    return separator < 0 ? ['all',entry.trim()] : [entry.slice(0,separator).trim().toLowerCase(),entry.slice(separator+1).trim()];
  }));
  const common = localProxy(entries.get('all'));
  const http = localProxy(entries.get('http')) ?? common;
  const https = localProxy(entries.get('https')) ?? common;
  if (!http && !https) return result;
  result.HTTP_PROXY = result.WS_PROXY = http ?? https;
  result.HTTPS_PROXY = result.WSS_PROXY = result.ALL_PROXY = https ?? http;
  const bypass = Object.entries(env).find(([key]) => key.toLowerCase() === 'no_proxy')?.[1];
  result.NO_PROXY = [bypass,'localhost','127.0.0.1','::1'].filter(Boolean).join(',');
  return result;
}

export async function codexEnvironment(home: string): Promise<NodeJS.ProcessEnv> {
  const env = {...process.env,CODEX_HOME:home};
  if (process.platform !== 'win32' || Object.entries(env).some(([key,value]) => value && proxyKeys.has(key.toLowerCase()))) return env;
  try {
    const {stdout} = await runFile('powershell.exe', ['-NoProfile','-NonInteractive','-Command',
      "Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' | Select-Object ProxyEnable,ProxyServer | ConvertTo-Json -Compress"],
      {windowsHide:true,timeout:3000,maxBuffer:8192});
    return applyWindowsProxy(env,JSON.parse(stdout));
  } catch { return env; }
}
