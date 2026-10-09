import {startCharacterSettings} from '../../tools/character-settings.mjs';
import {readRender,saveRender,renderMetricsFile} from '../../tools/render-settings.mjs';
import { app, BrowserWindow, ipcMain, protocol, screen, Menu, shell, Tray, nativeImage } from 'electron';
import { createTrayImage } from './tray-icon.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackendConnection } from './transport.mjs';
import { animePageURL } from '../../mods/anime-browser.mjs';
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
let smokeRendererErrors=0;
let smokeVoiceScope,smokeVoiceStates=[];
app.setName('AAAAGENT');
app.setPath('userData', resolve(app.getPath('appData'), 'AAAAGENT', smoke ? 'smoke-test' : preview ? 'preview' : codexChat ? 'codex-chat' : openaiChat ? 'openai-chat' : 'desktop'));
if (!app.requestSingleInstanceLock({ root, preview })) { app.quit(); process.exit(0); }
protocol.registerSchemesAsPrivileged([{ scheme: 'pet', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
let win, ready = false, voiceRequested = false, wakeRequested = false, panelOpen = false, beforeResize;
let tray,trayMenu,characterName='桌宠',dragState=null;
function endDrag(){if(!dragState)return;dragState=null;layout(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()));savePreferences();updateTrayMenu();}
function updateTrayMenu(){
  if(!tray||tray.isDestroyed()||!win||win.isDestroyed())return;
  tray.setToolTip(`${characterName} · 桌宠`);
  trayMenu=Menu.buildFromTemplate([
    {label:win.isVisible()?'隐藏桌宠':'显示桌宠',click:()=>{if(win.isVisible())win.hide();else win.showInactive();updateTrayMenu();}},
    {label:'打开对话',click:()=>{win.show();deliver('openChat');win.focus();}},
    {label:'角色设置',enabled:Boolean(characterSettingsUrl),click:()=>{if(characterSettingsUrl)void shell.openExternal(characterSettingsUrl).catch(()=>{});}},
    {type:'separator'},
    {label:'退出桌宠',click:()=>app.quit()}
  ]);
  tray.setContextMenu(trayMenu);
}
let prefs = { mode: 'full', width: 360, hotkey: null, ssaaSamples:16 }, anchor, prefsFile, writes = Promise.resolve();
const renderRoot=smoke?app.getPath('userData'):fileURLToPath(new URL('../../../../',import.meta.url));
let renderProfile={samples:16,revision:'default'},renderWrites=Promise.resolve(),renderSaving=false;
let characterSettingsUrl;
const deliver = (method, ...args) => { if (ready && win && !win.isDestroyed()) win.webContents.send('pet:delivery', method, ...args); };
const connection = new BackendConnection({
  onState: state => { voiceRequested = wakeRequested = false; deliver('connectionChanged', state); },
  onMessage: (message, generation) => {
    if(message.channel==='open_anime_page'){
      const url=animePageURL(message.url);
      void (url?shell.openExternal(url):Promise.reject(Error('invalid anime URL'))).then(()=>true,()=>false).then(ok=>connection.send({channel:'anime_page_result',requestId:message.requestId,ok},generation));
      return;
    }
    if(smoke&&option('--speech-smoke-file')&&message.channel==='event'){
      if(message.event.type==='turn')smokeVoiceScope=message.event.input.scope;
      if(message.event.type==='presentation'&&message.event.presentation.state==='idle'&&smokeVoiceScope)return;
    }
    if(message.channel==='character_settings'&&typeof message.url==='string'){
      try{const url=new URL(message.url);if(url.hostname==='127.0.0.1'&&url.protocol==='http:')characterSettingsUrl=message.url;}catch{}
      if(typeof message.name==='string'&&message.name.length<=40)characterName=message.name;
      updateTrayMenu();
    }
    if(message.channel==='reminder_due'&&!smoke&&win&&!win.isVisible())win.showInactive();
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
function layout(targetDisplay) {
  if (!win || win.isDestroyed() || dragState) return;
  const display = targetDisplay?.workArea ? targetDisplay : screen.getDisplayNearestPoint({ x: Math.round(anchor.x), y: Math.round(anchor.y) });
  const fitted = fitStableDisplay(prefs.width, panelOpen, display.workArea, anchor, prefs.mode);
  anchor = fitted.anchor;
  const current = win.getBounds();
  if (['x', 'y', 'width', 'height'].some(key => current[key] !== fitted.bounds[key])) win.setBounds(fitted.bounds);
  deliver('displayConfig', {...fitted.config,ssaaSamples:renderProfile.samples});
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
    case 'open_anime_page': {
      const url=animePageURL(value.url);
      if(url)void shell.openExternal(url).catch(()=>deliver('externalPageResult',{ok:false}));
      break;
    }
    case 'ready':
      if (ready) return;
      ready = true; layout(); deliver('hotkeyConfig', { code: prefs.hotkey }); start(); break;
    case 'panel': panelOpen = value.open === true; layout(); if (panelOpen) win.focus(); break;
    case 'focus': win.focus(); break;
    case 'pointer_region':
      if (typeof value.interactive === 'boolean') win.setIgnoreMouseEvents(!value.interactive, { forward: true });
      break;
    case 'drag_begin': dragState={cursor:screen.getCursorScreenPoint(),bounds:win.getBounds(),anchor:{...anchor}};break;
    case 'drag':
      if(dragState){const cursor=screen.getCursorScreenPoint(),dx=cursor.x-dragState.cursor.x,dy=cursor.y-dragState.cursor.y;
        anchor={x:dragState.anchor.x+dx,y:dragState.anchor.y+dy};win.setPosition(Math.round(dragState.bounds.x+dx),Math.round(dragState.bounds.y+dy));
      }break;
    case 'drag_end': endDrag();break;
    case 'context_menu': updateTrayMenu();trayMenu?.popup({window:win});break;
    case 'set_display': if (['full', 'half'].includes(value.mode)) { prefs.mode = value.mode; layout(); savePreferences(); } break;
    case 'set_ssaa': if(Number.isInteger(value.samples)&&value.samples>=0&&value.samples<=64){renderSaving=true;renderWrites=renderWrites.then(async()=>{renderProfile=await saveRender(renderRoot,value.samples);prefs.ssaaSamples=renderProfile.samples;layout();savePreferences();}).catch(()=>{}).finally(()=>{renderSaving=false;});}break;
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
      if(characterSettingsUrl){void shell.openExternal(characterSettingsUrl).then(()=>deliver('managementResult',{ok:true})).catch(()=>deliver('managementResult',{ok:false}));break;}
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
  if(value.type==='render_metrics'&&Number.isFinite(value.width)&&Number.isFinite(value.height)&&Number.isFinite(value.actualSamples)&&value.width>0&&value.height>0){void writeFile(renderMetricsFile(renderRoot),JSON.stringify({at:Date.now(),width:value.width,height:value.height,actualSamples:value.actualSamples,limited:value.limited===true,gpuMs:Number.isFinite(value.gpuMs)?value.gpuMs:null})).catch(()=>{});}

  if(smoke&&['model-error','script-error','promise-error'].includes(value.type))smokeRendererErrors++;
  if(smoke&&value.type==='playback-state')smokeVoiceStates.push(value.event);
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
renderProfile=await readRender(renderRoot);prefs.ssaaSamples=renderProfile.samples;
await mkdir(dirname(renderMetricsFile(renderRoot)),{recursive:true});
setInterval(async()=>{if(renderSaving)return;try{const profile=await readRender(renderRoot);if(!renderSaving&&profile.revision!==renderProfile.revision){renderProfile=profile;prefs.ssaaSamples=profile.samples;layout();}}catch{}},500).unref();
const area = screen.getPrimaryDisplay().workArea;
anchor ??= { x: area.x + area.width - 220, y: area.y + Math.max(0, area.height - 430) };
win = new BrowserWindow({ title: preview ? 'AAAAGENT · Offline preview' : 'AAAAGENT', width: 380, height: 376,
  frame: false, transparent: true, backgroundColor: '#00000000', alwaysOnTop: true, hasShadow: false, resizable: false, show: !smoke,
  webPreferences: { preload: resolve(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true,
    partition: 'aaaagent-desktop', backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
win.setIgnoreMouseEvents(true, { forward: true });
try{
  tray=new Tray(createTrayImage(nativeImage));
  win.setSkipTaskbar(true);
  updateTrayMenu();
  tray.on('click',()=>{win.showInactive();updateTrayMenu();});
  win.on('show',updateTrayMenu);win.on('hide',updateTrayMenu);
}catch{tray?.destroy();tray=undefined;win.setSkipTaskbar(false);process.stderr.write('Tray unavailable; keeping taskbar access.\n');}
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
win.on('blur', () => { endDrag();if (beforeResize !== undefined) { prefs.width = beforeResize; beforeResize = undefined; layout(); } deliver('hotkeyEvent', { type: 'cancel' }); });
const displaysChanged=()=>{endDrag();layout();updateTrayMenu();};
screen.on('display-metrics-changed', displaysChanged);screen.on('display-added',displaysChanged);screen.on('display-removed',displaysChanged);
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
app.on('will-quit',()=>{tray?.destroy();tray=undefined;});
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
    if(option('--model-screenshot')){
      await win.webContents.executeJavaScript("document.getElementById('view-half').click()");
      await new Promise(done=>setTimeout(done,300));
      const rectangle=await win.webContents.executeJavaScript("(() => {const r=document.getElementById('model').getBoundingClientRect();return {x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)};})()");
      await writeFile(resolve(option('--model-screenshot')),(await win.webContents.capturePage(rectangle)).toPNG());
    }
    if(!tray||tray.isDestroyed())throw Error('Native tray was not created');
    if(createTrayImage(nativeImage).isEmpty())throw Error('Tray icon is empty');
    win.showInactive();updateTrayMenu();
    trayMenu.items[0].click();if(win.isVisible())throw Error('Tray hide did not hide the pet');
    tray.emit('click');if(!win.isVisible())throw Error('Tray click did not restore the pet');
    if(trayMenu.items.some(item=>['移动到屏幕','SSAA 设置（0～64×）'].includes(item.label)))throw Error('Obsolete tray entries remain');
    const closedBounds = win.getBounds();
    const closedModelPosition = await win.webContents.executeJavaScript("(() => { const r=document.getElementById('model').getBoundingClientRect();return {x:r.x,y:r.y}; })()");
    const stableCanvas = await win.webContents.executeJavaScript("document.getElementById('model').getContext('webgl').getContextAttributes().preserveDrawingBuffer");
    if (!stableCanvas) throw Error('Transparent model canvas must retain its frame between redraws');
    const originalSamples=renderProfile.samples;
    for(const samples of [0,16,64]){
      await win.webContents.executeJavaScript(`document.getElementById('ssaa-samples').value='${samples}';document.getElementById('ssaa-samples').dispatchEvent(new Event('change',{bubbles:true}));`);
      await new Promise(done=>setTimeout(done,700));await renderWrites;
      const check=await win.webContents.executeJavaScript(`(() => {const c=document.getElementById('model'),g=c.getContext('webgl');return {width:c.width,height:c.height,cssWidth:c.clientWidth,dpr:devicePixelRatio,msaa:g.getContextAttributes().antialias,cost:document.getElementById('ssaa-cost').textContent,error:g.getError()};})()`);
      if(check.msaa||check.error||renderProfile.samples!==samples||check.width<Math.floor(check.cssWidth*check.dpr))throw Error('SSAA setting failed');
      if(samples===0&&Math.abs(check.width-check.cssWidth*check.dpr)>1)throw Error('SSAA 0 must be native resolution');
      if(samples===16&&Math.abs(check.width-check.cssWidth*check.dpr*4)>1)throw Error('SSAA 16x must use four times width');
      console.log('SSAA_CHECK: '+JSON.stringify({samples,...check}));
    }
    renderProfile=await saveRender(renderRoot,originalSamples);prefs.ssaaSamples=originalSamples;layout();
    await win.webContents.executeJavaScript("document.getElementById('open').click();document.getElementById('text').value='语音界面测试';document.getElementById('send').click()");
    const roundTripDeadline=Date.now()+3000;while(Date.now()<roundTripDeadline&&!smokeVoiceScope)await new Promise(done=>setTimeout(done,50));
    if(!smokeVoiceScope||!await win.webContents.executeJavaScript("document.getElementById('reply').textContent.includes('Offline preview received')"))throw Error('Preview backend round trip failed');
    if(option('--speech-smoke-file')){
      if(!smokeVoiceScope)throw Error('No current voice test scope');
      const audio=await readFile(resolve(option('--speech-smoke-file'))),id='voice-smoke';
      connection.onMessage({channel:'play',requestId:id,tts:{scope:smokeVoiceScope,audio:{id,uri:'pet-media:'+id,mimeType:'audio/wav',temporary:true},expression:{emotion:'neutral',intensity:0,delivery:'',gesture:null},durationMs:null,synchronization:'amplitude'},audioBase64:audio.toString('base64')},connection.generation);
      const voiceDeadline=Date.now()+12000;
      while(Date.now()<voiceDeadline&&!smokeVoiceStates.includes('ended')&&!smokeVoiceStates.includes('error'))await new Promise(done=>setTimeout(done,100));
      if(!smokeVoiceStates.includes('started')||!smokeVoiceStates.includes('ended')||smokeVoiceStates.includes('error'))throw Error('Desktop WAV playback failed: '+JSON.stringify(smokeVoiceStates));
      if(process.argv.includes('--bilingual-smoke')){
        const segment=(index,chunkIndex=0)=>({channel:'speech_segment',index,chunkIndex,subtitle:'中文字幕 '+index,requestId:'segment-'+index+'-'+chunkIndex,tts:{scope:smokeVoiceScope,audio:{id:'segment-'+index+'-'+chunkIndex,uri:'pet-media:segment-'+index+'-'+chunkIndex,mimeType:'audio/wav',temporary:true},expression:{emotion:'neutral',intensity:0,delivery:'',gesture:null},durationMs:null,synchronization:'amplitude'},audioBase64:audio.toString('base64')});
        connection.onMessage(segment(0),connection.generation);connection.onMessage(segment(0,1),connection.generation);connection.onMessage(segment(1),connection.generation);connection.onMessage(segment(1),connection.generation);
        const captions=new Set(),segmentDeadline=Date.now()+15000;
        while(Date.now()<segmentDeadline&&smokeVoiceStates.filter(s=>s==='ended').length<4){
          const caption=await win.webContents.executeJavaScript("document.getElementById('live-subtitle').hidden?'':document.getElementById('live-subtitle').textContent");if(caption){captions.add(caption);const text=await win.webContents.executeJavaScript("document.getElementById('reply').textContent");if(!text.includes(caption)||caption==='中文字幕 0'&&text.includes('中文字幕 1'))throw Error('Chinese chat text must follow actual audio start');}
          await new Promise(done=>setTimeout(done,100));
        }
        if(smokeVoiceStates.filter(s=>s==='started').length!==4||smokeVoiceStates.filter(s=>s==='ended').length!==4||!captions.has('中文字幕 0')||!captions.has('中文字幕 1'))throw Error('Sentence playback/caption ordering or deduplication failed');
        if(!await win.webContents.executeJavaScript("document.getElementById('reply').textContent.split('中文字幕 0').length===2"))throw Error('Chunked speech duplicated its Chinese sentence');
        connection.onMessage(segment(2),connection.generation);connection.onMessage(segment(3),connection.generation);
        const cancelDeadline=Date.now()+3000;while(Date.now()<cancelDeadline&&smokeVoiceStates.filter(s=>s==='started').length<5)await new Promise(done=>setTimeout(done,50));
        await win.webContents.executeJavaScript("document.getElementById('stop').click()");await new Promise(done=>setTimeout(done,400));
        if(smokeVoiceStates.filter(s=>s==='started').length!==5||!smokeVoiceStates.includes('stopped')||!await win.webContents.executeJavaScript("document.getElementById('live-subtitle').hidden"))throw Error('Cancel did not discard queued Japanese speech');
        if(await win.webContents.executeJavaScript("document.getElementById('reply').textContent.includes('中文字幕 3')"))throw Error('Cancelled queued sentence was displayed');
        console.log('BILINGUAL_PLAYBACK_OK: chat text follows audio start, ordered captions, sequential audio, deduplication and cancellation.');
      }
      smokeVoiceScope=undefined;console.log('VOICE_PLAYBACK_OK: actual renderer started and completed WAV playback.');
    }
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
    if(smokeRendererErrors)throw Error(`Renderer reported ${smokeRendererErrors} errors`);
    const modelVisible=await win.webContents.executeJavaScript("(() => {const c=document.getElementById('model'),gl=c.getContext('webgl'),pixels=new Uint8Array(c.width*c.height*4);gl.readPixels(0,0,c.width,c.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);for(let i=3;i<pixels.length;i+=4)if(pixels[i]>0)return true;return false;})()");
    if(!modelVisible)throw Error('Model canvas is blank');
    if(process.argv.includes('--settings-smoke')){
      const settings=await startCharacterSettings(option('--settings-root')||renderRoot),settingsWindow=new BrowserWindow({width:880,height:900,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
      try{
        await settingsWindow.loadURL(settings.url);
        const settingsDeadline=Date.now()+3000;while(Date.now()<settingsDeadline&&!await settingsWindow.webContents.executeJavaScript("document.getElementById('voice-engine').options.length===5"))await new Promise(done=>setTimeout(done,50));
        const result=await settingsWindow.webContents.executeJavaScript(`(() => {
          const $=id=>document.getElementById(id),visible=()=>[...document.querySelectorAll('[role=tabpanel]')].filter(p=>!p.hidden).map(p=>p.id);
          $('name').value='保留未保存草稿';$('tab-render').click();const renderOnly=visible().join()==='settings-render';
          $('tab-voice').click();const voiceOnly=visible().join()==='settings-voice';
          $('tab-voice').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}));
          const characterOnly=visible().join()==='settings-character',draftPreserved=$('name').value==='保留未保存草稿',keyboardFocus=document.activeElement.id==='tab-character';
          $('tab-voice').click();const voicesListed=$('voice-engine').options.length===5&&$('voice-options').children.length===5;return {renderOnly,voiceOnly,characterOnly,draftPreserved,keyboardFocus,voicesListed};
        })()`);
        if(Object.values(result).some(v=>!v))throw Error('Settings tab switching failed: '+JSON.stringify(result));
        await new Promise(done=>setTimeout(done,150));
        if(option('--settings-screenshot'))await writeFile(resolve(option('--settings-screenshot')),(await settingsWindow.webContents.capturePage()).toPNG());
        console.log('SETTINGS_TABS_OK: one visible section, keyboard navigation and preserved drafts.');
      }finally{settingsWindow.destroy();await settings.close();}
    }
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
