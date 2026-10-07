import { app, BrowserWindow, ipcMain, protocol, screen, Menu, shell } from 'electron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackendConnection } from './transport.mjs';
import { fitStableDisplay } from './layout.mjs';
import { assetResponse } from './assets.mjs';
import { managementUrl } from '../../tools/management-url.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const option = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const root = resolve(option('--root') || resolve(here, '..'));
const node = option('--node'), backend = option('--backend');
if (!node || !backend) throw Error('Use npm run dev or npm start to launch the Windows host.');
const preview = process.argv.includes('--preview');
const openaiChat = process.argv.includes('--openai-chat');
const codexChat = openaiChat && process.env.PET_CHAT_MODE === 'codex';
const inspect = process.argv.includes('--inspect');
const smoke = process.argv.includes('--smoke-test');
app.setName('AAAAGENT');
app.setPath('userData', resolve(app.getPath('appData'), 'AAAAGENT', smoke ? 'smoke-test' : preview ? 'preview' : codexChat ? 'codex-chat' : openaiChat ? 'openai-chat' : 'desktop'));
if (!app.requestSingleInstanceLock({ root, preview })) { app.quit(); process.exit(0); }
protocol.registerSchemesAsPrivileged([{ scheme: 'pet', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
let win, ready = false, voiceRequested = false, wakeRequested = false, panelOpen = false, beforeResize;
let prefs = { mode: 'full', width: 360, hotkey: null }, anchor, prefsFile, writes = Promise.resolve();
const deliver = (method, ...args) => { if (ready && win && !win.isDestroyed()) win.webContents.send('pet:delivery', method, ...args); };
const connection = new BackendConnection({
  onState: state => { voiceRequested = wakeRequested = false; deliver('connectionChanged', state); },
  onMessage: (message, generation) => {
    if (message.channel === 'wake_control') wakeRequested = message.enabled === true;
    if (message.channel === 'wake_error') wakeRequested = false;
    if (['capture_finish', 'capture_stop'].includes(message.channel)) voiceRequested = false;
    deliver('receive', message, generation);
  }
});
const validHotkey = code => code === null || /^(Arrow(Up|Down|Left|Right)|Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|20)|Space|Enter|Backspace|Delete|Home|End|PageUp|PageDown|Comma|Period|Slash|Semicolon|Quote|BracketLeft|BracketRight|Backslash|Minus|Equal|Backquote)$/.test(code);
function savePreferences() {
  const raw = JSON.stringify({ ...prefs, anchor });
  writes = writes.then(() => writeFile(prefsFile, raw)).catch(() => process.stderr.write('Display preferences could not be saved.\n'));
}
function layout() {
  if (!win || win.isDestroyed()) return;
  const display = screen.getDisplayNearestPoint({ x: Math.round(anchor.x), y: Math.round(anchor.y) });
  const fitted = fitStableDisplay(prefs.width, panelOpen, display.workArea, anchor, prefs.mode);
  anchor = fitted.anchor;
  const current = win.getBounds();
  if (['x', 'y', 'width', 'height'].some(key => current[key] !== fitted.bounds[key])) win.setBounds(fitted.bounds);
  deliver('displayConfig', fitted.config);
}
const trusted = event => win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && event.senderFrame.url === 'pet://app/index.html';
const start = () => connection.start(node, [backend], process.env);

ipcMain.on('pet:desktop', (event, value) => {
  if (!trusted(event) || !value || value.generation !== connection.generation || connection.state !== 'ready' || !value.message || typeof value.message !== 'object') return;
  const type = value.message.command?.type;
  if (['start_voice', 'click_invitation'].includes(type)) voiceRequested = true;
  if (['finish_voice', 'cancel', 'submit_text'].includes(type)) voiceRequested = false;
  connection.send(value.message, value.generation);
});
ipcMain.on('pet:shell', (event, value) => {
  if (!trusted(event) || !value || typeof value !== 'object') return;
  switch (value.type) {
    case 'ready':
      if (ready) return;
      ready = true; layout(); deliver('hotkeyConfig', { code: prefs.hotkey }); start(); break;
    case 'panel': panelOpen = value.open === true; layout(); if (panelOpen) win.focus(); break;
    case 'focus': win.focus(); break;
    case 'pointer_region':
      if (typeof value.interactive === 'boolean') win.setIgnoreMouseEvents(!value.interactive, { forward: true });
      break;
    case 'drag':
      if (Number.isFinite(value.dx) && Number.isFinite(value.dy) && Math.abs(value.dx) < 2000 && Math.abs(value.dy) < 2000) {
        anchor.x += value.dx; anchor.y += value.dy; layout(); savePreferences();
      } break;
    case 'set_display': if (['full', 'half'].includes(value.mode)) { prefs.mode = value.mode; layout(); savePreferences(); } break;
    case 'resize_model':
      if (value.phase === 'begin') beforeResize ??= prefs.width;
      else if (beforeResize !== undefined) {
        if (value.phase === 'cancel') { prefs.width = beforeResize; beforeResize = undefined; }
        else if (['update', 'commit'].includes(value.phase) && Number.isFinite(value.width)) {
          prefs.width = Math.max(220, Math.min(720, value.width));
          if (value.phase === 'commit') { beforeResize = undefined; savePreferences(); }
        }
        layout();
      } break;
    case 'set_hotkey': if (validHotkey(value.code)) { prefs.hotkey = value.code; savePreferences(); deliver('hotkeyConfig', { code: prefs.hotkey }); } break;
    case 'reconnect': if (['failed', 'disconnected'].includes(connection.state)) start(); break;
    case 'disconnect': if (value.generation === connection.generation) connection.close(); break;
    case 'open_management':
      if (openaiChat) {
        const setupUrl = process.env.PET_OPENAI_SETUP_URL;
        if (!setupUrl || new URL(setupUrl).hostname !== '127.0.0.1' || new URL(setupUrl).protocol !== 'http:') { deliver('managementResult', {ok:false}); break; }
        void shell.openExternal(setupUrl).then(() => deliver('managementResult',{ok:true})).catch(() => deliver('managementResult',{ok:false})); break;
      }
      if (preview) { deliver('managementResult', { ok: false }); break; }
      void managementUrl(process.env.PET_TRIAL_CONFIG).then(url => shell.openExternal(url)).then(() => deliver('managementResult', { ok: true })).catch(() => deliver('managementResult', { ok: false })); break;
    case 'quit': app.quit(); break;
  }
});
ipcMain.on('pet:diagnostic', (event, value) => {
  if (!trusted(event) || !value) return;
  // Don't copy arbitrary renderer text, chat or media into diagnostic logs.
  if (['model-ready', 'model-error', 'script-error', 'promise-error'].includes(value.type)) process.stderr.write(`Renderer: ${value.type}\n`);
});

// Do not await readiness at module scope: Electron must finish loading this ESM
// entry before it can emit ready. Keep initialization in the ready callback.
void app.whenReady().then(async () => {
await mkdir(app.getPath('userData'), { recursive: true });
prefsFile = resolve(app.getPath('userData'), 'windows-display.json');
try {
  const saved = JSON.parse(await readFile(prefsFile, 'utf8'));
  if (['full', 'half'].includes(saved.mode)) prefs.mode = saved.mode;
  if (Number.isFinite(saved.width)) prefs.width = Math.max(220, Math.min(720, saved.width));
  if (validHotkey(saved.hotkey)) prefs.hotkey = saved.hotkey;
  if (Number.isFinite(saved.anchor?.x) && Number.isFinite(saved.anchor?.y)) anchor = saved.anchor;
} catch {}
const area = screen.getPrimaryDisplay().workArea;
anchor ??= { x: area.x + area.width - 220, y: area.y + Math.max(0, area.height - 430) };
win = new BrowserWindow({ title: preview ? 'AAAAGENT · Offline preview' : 'AAAAGENT', width: 380, height: 376,
  frame: false, transparent: true, backgroundColor: '#00000000', alwaysOnTop: true, hasShadow: false, resizable: false, show: !smoke,
  webPreferences: { preload: resolve(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true,
    partition: 'aaaagent-desktop', backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
win.setIgnoreMouseEvents(true, { forward: true });
Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'AAAAGENT', submenu: [
  { label: 'Reload', accelerator: 'Ctrl+R', click: () => { connection.close(); ready = false; win.webContents.reload(); } },
  { label: 'Developer tools', accelerator: 'Ctrl+Shift+I', click: () => win.webContents.toggleDevTools() }, { role: 'quit' }
] }, { role: 'editMenu' }]));
await win.webContents.session.protocol.handle('pet', request => assetResponse(root, request.url));
const mediaAllowed = (wc, permission, origin, types, mainFrame) => !preview && wc === win.webContents && permission === 'media'
  && origin?.startsWith('pet://app/') && mainFrame !== false && types.length > 0
  && types.every(type => type === 'audio' ? voiceRequested || wakeRequested : type === 'video' && voiceRequested);
win.webContents.session.setPermissionRequestHandler((wc, permission, callback, details) => callback(mediaAllowed(wc, permission, details.requestingUrl, details.mediaTypes || [], details.isMainFrame)));
win.webContents.session.setPermissionCheckHandler((wc, permission, origin, details) => mediaAllowed(wc, permission, origin + '/', [details.mediaType], details.isMainFrame));
win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
win.webContents.on('will-navigate', event => event.preventDefault());
win.webContents.on('will-attach-webview', event => event.preventDefault());
win.webContents.on('render-process-gone', () => { ready = false; connection.close(); });
win.on('blur', () => { if (beforeResize !== undefined) { prefs.width = beforeResize; beforeResize = undefined; layout(); } deliver('hotkeyEvent', { type: 'cancel' }); });
screen.on('display-metrics-changed', layout); screen.on('display-removed', layout);
app.on('second-instance', () => { win.show(); win.focus(); });
let quitDrained = false, quitPending = false;
app.on('before-quit', event => {
  if (quitDrained) return;
  event.preventDefault();
  if (quitPending) return;
  quitPending = true;
  // Keep pipes and the Electron event loop alive until backend EOF cleanup
  // finishes. Otherwise Windows can leave backend.lock after the window closes.
  void connection.close().then(() => writes).finally(() => { quitDrained = true; app.quit(); });
});
app.on('window-all-closed', () => app.quit());
layout();
await win.loadURL('pet://app/index.html');
if (inspect) win.webContents.openDevTools({ mode: 'detach' });
if (smoke) {
  try {
    // Exercise the real Electron renderer in an offscreen window; no account or device access.
    const deadline = Date.now() + 20000;
    let loaded = false;
    while (Date.now() < deadline) {
      loaded = await win.webContents.executeJavaScript("!!window.petBridge && document.getElementById('loading').hidden && !document.getElementById('send').disabled");
      if (loaded) break;
      await new Promise(done => setTimeout(done, 200));
    }
    if (!loaded) throw Error('Renderer or offline backend did not become ready: ' + await win.webContents.executeJavaScript("document.getElementById('status').textContent"));
    const closedBounds = win.getBounds();
    const closedModelPosition = await win.webContents.executeJavaScript("(() => { const r=document.getElementById('model').getBoundingClientRect();return {x:r.x,y:r.y}; })()");
    const stableCanvas = await win.webContents.executeJavaScript("document.getElementById('model').getContext('webgl').getContextAttributes().preserveDrawingBuffer");
    if (!stableCanvas) throw Error('Transparent model canvas must retain its frame between redraws');
    const secondaryClickSafe = await win.webContents.executeJavaScript("(() => { const drawer = document.getElementById('drawer'), before = drawer.hidden, character = document.getElementById('character'); for (const type of ['pointerdown', 'pointerup']) character.dispatchEvent(new PointerEvent(type, {button:2, pointerId:7, isPrimary:true, bubbles:true})); return before === drawer.hidden; })()");
    if (!secondaryClickSafe) throw Error('Secondary click unexpectedly toggled the model drawer');
    await win.webContents.executeJavaScript("document.getElementById('open').click();document.getElementById('text').value='Windows bridge smoke test';document.getElementById('form').requestSubmit();");
    await new Promise(done => setTimeout(done, 400));
    const openBounds = win.getBounds();
    const openModelPosition = await win.webContents.executeJavaScript("(() => { const r=document.getElementById('model').getBoundingClientRect();return {x:r.x,y:r.y}; })()");
    if (JSON.stringify(closedBounds) !== JSON.stringify(openBounds) || JSON.stringify(closedModelPosition) !== JSON.stringify(openModelPosition)) throw Error('Opening the drawer moved the native surface or character');
    const echoed = await win.webContents.executeJavaScript("document.getElementById('reply').textContent.includes('Offline preview received')");
    if (!echoed) throw Error('Text did not complete a backend round trip');
    await win.webContents.executeJavaScript("document.getElementById('close').click()");
    const reminder={channel:'reminder_due',reminder:{id:'reminder-smoke',text:'测试提醒：喝水',dueAt:Date.now()}};
    connection.onMessage(reminder,connection.generation);
    connection.onMessage(reminder,connection.generation);
    await new Promise(done=>setTimeout(done,200));
    const reminderVisible=await win.webContents.executeJavaScript("document.getElementById('drawer').hidden && !document.getElementById('reminder-bubble').hidden && document.getElementById('reminder-bubble-text').textContent==='测试提醒：喝水' && document.getElementById('reply').textContent.split('测试提醒：喝水').length===2");
    if(!reminderVisible)throw Error('Reminder bubble was not shown with the drawer closed');
    if(JSON.stringify(closedBounds)!==JSON.stringify(win.getBounds()))throw Error('Reminder moved the native surface');
    const bubbleFits=await win.webContents.executeJavaScript("(() => {const b=document.getElementById('reminder-bubble').getBoundingClientRect(),c=document.getElementById('character').getBoundingClientRect();return b.left>=0&&b.top>=0&&b.right<=innerWidth&&b.bottom<=innerHeight&&b.top<c.top+c.height/2;})()");
    if(!bubbleFits)throw Error('Reminder bubble was clipped or placed below the character');
    connection.onMessage({channel:'reminder_due',reminder:{id:'reminder-smoke-second',text:'第二条提醒',dueAt:Date.now()}},connection.generation);
    await new Promise(done=>setTimeout(done,100));
    const queued=await win.webContents.executeJavaScript("document.getElementById('reminder-bubble-text').textContent==='测试提醒：喝水' && document.getElementById('reminder-bubble-label').textContent.includes('2条')");
    if(!queued)throw Error('A second reminder replaced the first');
    await win.webContents.executeJavaScript("document.getElementById('reminder-bubble-close').click()");
    const next=await win.webContents.executeJavaScript("document.getElementById('reminder-bubble-text').textContent==='第二条提醒' && document.getElementById('drawer').hidden");
    if(!next)throw Error('Dismiss did not advance the reminder queue');
    await win.webContents.executeJavaScript("document.getElementById('reminder-bubble-close').click()");
    if(!await win.webContents.executeJavaScript("document.getElementById('reminder-bubble').hidden"))throw Error('Dismiss did not hide the reminder bubble');
    deliver('showReminder',reminder.reminder);
    console.log('WINDOWS_SMOKE_OK: Live2D renderer, isolated preload, backend round trip, panel layout, reminder display and deduplication.');
    if (option('--screenshot')) {
      win.showInactive();
      await new Promise(done => setTimeout(done, 600));
      const visible = await win.webContents.executeJavaScript("!document.getElementById('reminder-bubble').hidden && document.getElementById('drawer').hidden");
      if (!visible) throw Error('Reminder bubble is not visible');
      await writeFile(resolve(option('--screenshot')), (await win.webContents.capturePage()).toPNG());
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  app.quit();
}
}).catch(error => { console.error(error.message); app.exit(1); });
