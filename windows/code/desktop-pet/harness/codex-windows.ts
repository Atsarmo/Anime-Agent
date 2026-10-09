import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { CodexAppConnection, CodexAppError, type CodexAppReceipt } from './codex-app.js';
import { codexEnvironment } from './windows-proxy.js';

type Pending = { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
const uuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value);
type Launcher = (executable: string, home: string, env: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams;
const launch: Launcher = (executable, _home, env) => spawn(executable, ['app-server', '--stdio'], {
  windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env,
});

/** Official newline-delimited app-server RPC; no private Mac IPC or ASAR hashes. */
export class CodexWindowsConnection extends CodexAppConnection {
  private child: ChildProcessWithoutNullStreams | undefined;
  private starting: Promise<void> | undefined;
  private pending = new Map<string, Pending>();
  private sequence = 0;
  private closing = false;
  private notifications = new Set<(message: any) => void>();
  private chatThread: string | undefined;
  private chatSetup: {cwd: string; instructions: string} | undefined;
  constructor(private readonly home: string, private readonly executable?: string, private readonly requestTimeoutMs = 60000, private readonly launcher: Launcher = launch, private readonly replyTimeoutMs = 60000) {
    super(home);
  }
  private async binary(): Promise<string> {
    const explicit = this.executable ?? process.env.PET_CODEX_EXECUTABLE;
    if (explicit) {
      if (!isAbsolute(explicit)) throw new CodexAppError('unavailable');
      await access(explicit); return explicit;
    }
    const root = join(process.env.LOCALAPPDATA ?? '', 'OpenAI', 'Codex', 'bin');
    const candidates: { path: string; changed: number }[] = [];
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const path = join(root, entry.name, 'codex.exe');
      try { const info = await stat(path); if (info.isFile()) candidates.push({ path, changed: info.mtimeMs }); } catch {}
    }
    const installed = candidates.sort((a, b) => b.changed - a.changed)[0];
    if (installed) return installed.path;
    for (const directory of (process.env.PATH ?? '').split(';').filter(Boolean)) {
      const path = join(directory, 'codex.exe');
      try { if ((await stat(path)).isFile()) return path; } catch {}
    }
    throw new CodexAppError('unavailable');
  }
  private fail() {
    for (const listener of this.notifications) listener({ method: 'connection/closed' });
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(new CodexAppError('unavailable')); }
    this.pending.clear(); this.child = undefined; this.starting = undefined;
  }
  private write(value: object) {
    if (!this.child || !this.child.stdin.writable) throw new CodexAppError('unavailable');
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  private rpc(method: string, params: object, timeoutMs = this.requestTimeoutMs): Promise<any> {
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new CodexAppError('unavailable', undefined, 'timeout')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  private async start(): Promise<void> {
    if (this.closing) throw new CodexAppError('unavailable');
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const executable = await this.binary();
      const child = this.launcher(executable, this.home, await codexEnvironment(this.home));
      this.child = child;
      // Never forward auth/plugin diagnostics or unrelated thread content to the pet log.
      child.stderr.resume();
      const failed = () => { if (this.child === child) this.fail(); };
      child.on('error', failed); child.on('exit', failed);
      child.stdin.on('error', failed);
      const decoder = new StringDecoder('utf8'); let buffer = '';
      child.stdout.on('data', chunk => {
        if (this.child !== child) return;
        buffer += decoder.write(chunk);
        if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) { child.kill(); this.fail(); return; }
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          let message; try { message = JSON.parse(line); } catch { child.kill(); this.fail(); return; }
          if (message.id === undefined && message.method) { for (const listener of this.notifications) listener(message); continue; }
          if (message.method && message.id !== undefined) {
            // An external client must not silently approve tools or answer user questions.
            if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method))
              this.write({ id: message.id, result: { decision: 'decline' } });
            else this.write({ id: message.id, error: { code: -32601, message: 'Continue this request in Codex; the companion has no approval UI.' } });
            continue;
          }
          const waiter = this.pending.get(String(message.id));
          if (!waiter) continue;
          this.pending.delete(String(message.id)); clearTimeout(waiter.timer);
          message.error ? waiter.reject(new CodexAppError('unavailable')) : waiter.resolve(message.result);
        }
      });
      await this.rpc('initialize', { clientInfo: { name: 'aaaagent_windows', title: 'AAAAGENT Windows', version: '0.1.1' } });
      this.write({ method: 'initialized' });
    })();
    try { await this.starting; } catch (error) { this.child?.kill(); this.fail(); throw error; }
  }
  async compatible(): Promise<boolean> {
    try { await this.start(); const auth = await this.rpc('account/read', { refreshToken: false }); return !!auth?.account; }
    catch { return false; }
  }
  async openChat(cwd: string, characterInstructions = ''): Promise<{ model: string; ephemeral: boolean }> {
    await this.start();
    const auth = await this.rpc('account/read', { refreshToken: false });
    if (auth?.account?.type !== 'chatgpt') throw new Error('请先在 Codex 使用 ChatGPT 登录。');
    const effective = await this.rpc('config/read', { includeLayers: false });
    const overrides: Record<string, unknown> = { 'features.shell_tool': false, 'features.apps': false,
      'features.multi_agent': false, 'features.skill_search': false, 'features.sleep_tool': false,
      web_search: 'disabled', model_reasoning_effort: 'low' };
    for (const name of Object.keys(effective?.config?.mcp_servers ?? {})) overrides[`mcp_servers.${name}.enabled`] = false;
    const started = await this.rpc('thread/start', { cwd, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never', config: overrides,
      baseInstructions: '你是中文桌面陪伴助手，进行自然、简洁的文字聊天。不要调用任何工具、访问文件或操作电脑。桌宠由本地程序处理单次提醒，用户可直接发送“10分钟后提醒我喝水”“明天下午3点提醒我喝水”“查看提醒”“取消所有提醒”。提醒按北京时间计算，需保持桌宠运行；关闭或休眠时到期，会在恢复运行后补提醒。你不能自行设置提醒，未收到本地程序实际成功回执不能声称已设置。你没有语音、长期记忆或其他任务执行能力。\n' + characterInstructions });
    if (!uuid(started?.thread?.id ?? '') || started.thread.ephemeral !== true) throw new CodexAppError('incompatible');
    this.chatThread = started.thread.id;
    this.chatSetup = {cwd, instructions: characterInstructions};
    return { model: typeof started.model === 'string' ? started.model : 'Codex', ephemeral: true };
  }
  async chat(text: string, signal: AbortSignal, onDelta?: (delta: string) => void): Promise<string> {
    if(!this.child&&this.chatSetup&&!this.closing&&!signal.aborted)await this.openChat(this.chatSetup.cwd,this.chatSetup.instructions);
    if (!this.chatThread || !text.trim() || text.length > 16000 || signal.aborted) throw new CodexAppError('invalid_target');
    const threadId = this.chatThread;
    const ownedChild = this.child;
    const retire = () => { if (this.child === ownedChild) { ownedChild?.kill(); this.fail(); } };
    let turnId: string | undefined;
    let timedOut = false;
    const completed = new Map<string, any>(), replies = new Map<string, string[]>();
    const streamed = new Map<string, {turn: string; phase: string | null; text: string; sent: number}>();
    const flush = () => {
      if (!onDelta || !turnId || signal.aborted || timedOut) return;
      for (const item of streamed.values()) if(item.turn===turnId && item.phase==='final_answer' && item.text.length>item.sent){const delta=item.text.slice(item.sent);item.sent=item.text.length;onDelta(delta);}
    };
    let resolveReply!: (reply: string) => void, rejectReply!: (error: Error) => void;
    const result = new Promise<string>((resolve, reject) => { resolveReply = resolve; rejectReply = reject; });
    // Keep the promise handled if cancellation arrives while turn/start is pending.
    void result.catch(() => {});
    let resolveTerminal!: () => void;
    const terminal = new Promise<void>(resolve => { resolveTerminal = resolve; });
    const finish = () => {
      if (!turnId || !completed.has(turnId)) return;
      resolveTerminal();
      const turn = completed.get(turnId), reply = (replies.get(turnId) ?? []).join('\n');
      if (turn.status === 'completed' && reply.trim()) resolveReply(reply);
      else rejectReply(new CodexAppError('unknown_delivery'));
    };
    const listener = (message: any) => {
      if (message.method === 'connection/closed') { resolveTerminal(); rejectReply(new CodexAppError('unavailable')); return; }
      const p = message.params;
      if (p?.threadId !== threadId) return;
      if(message.method==='item/started'&&p.item?.type==='agentMessage')streamed.set(p.item.id,{turn:p.turnId,phase:p.item.phase??null,text:'',sent:0});
      if(message.method==='item/agentMessage/delta'&&typeof p.delta==='string'){
        const item=streamed.get(p.itemId);if(item&&item.turn===p.turnId){item.text+=p.delta;flush();}
      }
      if (message.method === 'item/completed' && p.item?.type === 'agentMessage' && p.item.phase !== 'commentary' && typeof p.item.text === 'string') {
        const values = replies.get(p.turnId) ?? []; values.push(p.item.text); replies.set(p.turnId, values);
        const item=streamed.get(p.item.id);
        if(item&&p.item.text.startsWith(item.text)){item.phase='final_answer';item.text=p.item.text;}
        else if(!item)streamed.set(p.item.id??String(streamed.size),{turn:p.turnId,phase:'final_answer',text:p.item.text,sent:0});
        flush();
      }
      if (message.method === 'turn/completed') completed.set(p.turn?.id, p.turn);
      finish();
    };
    let interruption: Promise<any> | undefined;
    const abort = () => {
      if (turnId && !interruption) interruption = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          // An interrupt acknowledgement is not the terminal turn notification.
          await Promise.race([
            this.rpc('turn/interrupt', { threadId, turnId }, Math.min(this.requestTimeoutMs,2500)).then(() => terminal),
            new Promise((_, reject) => { timer=setTimeout(() => reject(new Error('interrupt timeout')),2500); }),
          ]);
        } catch { retire(); }
        finally { clearTimeout(timer); }
      })();
      rejectReply(new CodexAppError('unknown_delivery',undefined,timedOut?'timeout':undefined));
    };
    this.notifications.add(listener); signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(()=>{timedOut=true;abort();}, this.replyTimeoutMs);
    try {
      const started = await this.rpc('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] },Math.min(this.requestTimeoutMs,15000));
      if (!uuid(started?.turn?.id ?? '')) throw new CodexAppError('unknown_delivery');
      turnId = started.turn.id;
      if (signal.aborted || timedOut) abort(); else {flush();finish();}
      return await result;
    } catch(error){
      // A lost start receipt leaves the turn identity unknown; retire only this owned server.
      if(!turnId)retire();
      throw error;
    } finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); await interruption; this.notifications.delete(listener); }
  }
  override async discover(threadId: string): Promise<{ available: boolean }> {
    if (!uuid(threadId)) throw new CodexAppError('invalid_target');
    await this.start();
    const result = await this.rpc('thread/read', { threadId, includeTurns: false });
    return { available: result?.thread?.id === threadId && result.thread.status?.type !== 'active' };
  }
  override async ensureAvailable(threadId: string) { return this.discover(threadId); }
  override async send(threadId: string, text: string, requestId: string) {
    if (!uuid(threadId) || !uuid(requestId) || !text.trim() || text.length > 32768 || text.includes('\0')) throw new CodexAppError('invalid_target');
    await this.start();
    const resumed = await this.rpc('thread/resume', { threadId });
    if (resumed?.thread?.id !== threadId || resumed.thread.status?.type === 'active') throw new CodexAppError('unavailable');
    // Forwarding receipts persist dispatchAttempted before this single write.
    // A lost response remains unknown and is never automatically retried.
    try {
      const result = await this.rpc('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] });
      if (!uuid(result?.turn?.id ?? '')) throw new CodexAppError('unknown_delivery');
      return { threadId, requestId, turnId: result.turn.id as string };
    } catch { throw new CodexAppError('unknown_delivery'); }
  }
  override async receipt(threadId: string, turnId: string): Promise<CodexAppReceipt> {
    if (!uuid(threadId) || !uuid(turnId)) throw new CodexAppError('invalid_target');
    const unknown: CodexAppReceipt = { threadId, turnId, status: 'unknown' };
    try {
      await this.start();
      const result = await this.rpc('thread/read', { threadId, includeTurns: true });
      if (result?.thread?.id !== threadId) return unknown;
      const turn = result.thread.turns?.find((item: any) => item.id === turnId);
      if (turn?.status === 'completed') {
        const reply = (turn.items ?? []).filter((item: any) => item.type === 'agentMessage' && typeof item.text === 'string').map((item: any) => item.text).join('\n').slice(0, 4000);
        return { threadId, turnId, status: 'completed', reply };
      }
      return ['failed', 'interrupted'].includes(turn?.status) ? { ...unknown, reason: 'interrupted' } : unknown;
    } catch { return unknown; }
  }
  async close(): Promise<void> {
    this.closing = true;
    const child = this.child; if (!child) return;
    await new Promise<void>(done => {
      const timer = setTimeout(() => { child.kill(); done(); }, 3000);
      child.once('exit', () => { clearTimeout(timer); done(); }); child.stdin.end();
    });
    this.fail();
  }
}
