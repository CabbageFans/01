/** 独立 Electron/webview 的真实原生事件验收；不加载真实账号或平台。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { build } from 'vite';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.resolve(process.argv[2] || path.join(repository, 'artifacts/mac/native-submission', new Date().toISOString().replace(/[:.]/g, '-')));
const verificationId = randomUUID();
await fs.mkdir(output, { recursive: true });
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'doubao-native-submission-'));
const renderer = path.join(temporary, 'renderer.js');
const bundleDirectory = path.join(temporary, 'bundle');
const prompt = 'OFFLINE native submission fixture';
const rendererSource = `
import { submitPromptOnce, preparePageSubmission } from ${JSON.stringify(path.join(repository, 'src/utils/doubaoBridge.ts'))};
import { pageSubmissionProbe } from ${JSON.stringify(path.join(repository, 'src/utils/submissionControls.ts'))};
import { readExactComposerText } from ${JSON.stringify(path.join(repository, 'src/utils/exactComposer.ts'))};
import { beginVideoPageOperation } from ${JSON.stringify(path.join(repository, 'src/automation/videoExecutionContext.ts'))};
const prompt=${JSON.stringify(prompt)};
const webview=document.querySelector('webview');
const assert=(value,message)=>{if(!value)throw new Error(message);};
const read=()=>webview.executeJavaScript('globalThis.fixtureSnapshot()');
const reset=()=>webview.executeJavaScript('globalThis.fixtureReset()');
const guard=(key,changes={})=>({signal:new AbortController().signal,deadlineAt:Date.now()+10000,dispatchKey:key,expectedPrompt:prompt,strictParagraphs:true,isCurrent:()=>true,verifyLease:async()=>true,activation:'native_media',...changes});
const probe=(operation)=>webview.executeJavaScript('('+pageSubmissionProbe.toString()+')('+JSON.stringify(operation)+','+readExactComposerText.toString()+')');
const activate=async(target)=>{const [x,y]=target.position.split(',').map(Number);await webview.sendInputEvent({type:'mouseMove',x,y});await webview.sendInputEvent({type:'mouseDown',x,y,button:'left',clickCount:1});await webview.sendInputEvent({type:'mouseUp',x,y,button:'left',clickCount:1});await read();};
const proxyExecute=(execute)=>new Proxy(webview,{get(target,key){if(key==='executeJavaScript')return execute;const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
globalThis.nativeSubmissionFixture={run:async()=>{
 await globalThis.fixtureGuestReady;
 const cases=[];
 const check=async(name,body)=>{const started=performance.now();try{const evidence=await body();cases.push({name,success:true,elapsedMs:Math.round(performance.now()-started),...evidence});}catch(error){cases.push({name,success:false,elapsedMs:Math.round(performance.now()-started),error:String(error.stack||error),page:await read().catch(()=>undefined)});}};
 await check('electron_native_transport_control',async()=>{
  await reset();const target=await preparePageSubmission(webview);assert(target.ok,'离线控件不可读取');
  await webview.executeJavaScript('globalThis.fixtureTransportAck=new Promise((resolve,reject)=>{const button=document.querySelector("#flow-end-msg-send");const timer=setTimeout(()=>reject(new Error("OFFLINE native transport click ACK missing")),750);button.addEventListener("click",()=>{clearTimeout(timer);resolve(true);},{once:true});});true');
  await activate(target);await webview.executeJavaScript('globalThis.fixtureTransportAck');const page=await read();
  assert(page.activations===1&&page.trustedActivations===1,'未聚焦Electron无法向隔离webview送达可信原生事件');return {page};
 });
 await check('trusted_native_once_unfocused',async()=>{
  await reset();const result=await submitPromptOnce(webview,guard('fixture:trusted:run-1'));const page=await read();
  assert(result.kind==='dispatch_attempted','正式提交未获得原生活化回执: '+JSON.stringify(result));
  assert(page.activations===1&&page.trustedActivations===1,'最终控件必须仅收到一次可信原生click');
  for(const type of ['pointerdown','mousedown','pointerup','mouseup','click'])assert(page.events.filter(event=>event.type===type&&event.isTrusted).length===1,'缺少唯一可信事件 '+type);
  return {result,page};
 });
 await check('ack_loss_never_reactivates',async()=>{
  await reset();let lost=false;const execute=webview.executeJavaScript.bind(webview);
  const wrapped=proxyExecute(async(code)=>{const result=await execute(code);if(code.includes('"readReceiptKey":')&&!lost){lost=true;throw new Error('OFFLINE lost native receipt ACK');}return result;});
  const safety=guard('fixture:ack-loss:run-1');const first=await submitPromptOnce(wrapped,safety);const afterFirst=await read();const second=await submitPromptOnce(wrapped,safety);const page=await read();
  assert(lost,'正式路径未读取原生提交回执');assert(first.kind==='dispatch_unknown','ACK丢失必须保留派发不明');
  assert(afterFirst.activations===1&&page.activations===1&&page.trustedActivations===1,'丢失ACK或再次检查导致重复激活');
  return {first,second,page};
 });
 await check('reserve_only_ack_loss_is_not_dispatched',async()=>{
  await reset();let lost=false;let nativeEvents=0;const execute=webview.executeJavaScript.bind(webview);const send=webview.sendInputEvent.bind(webview);
  const reserved=proxyExecute(async(code)=>{const result=await execute(code);if(code.includes('"reserveNative":true')&&!lost){assert(result.nativeReserved,'夹具未成功预留权限');lost=true;throw new Error('OFFLINE lost reservation ACK before mouseDown');}return result;});
  const wrapped=new Proxy(reserved,{get(target,key){if(key==='sendInputEvent')return(event)=>{nativeEvents++;return send(event);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  const result=await submitPromptOnce(wrapped,guard('fixture:reserve-ack-loss:run-1'));const page=await read();
  assert(lost,'正式路径未预留原生权限');assert(result.kind==='not_dispatched','仅预留权限ACK丢失不能冒充已尝试派发');
  assert(nativeEvents===0&&page.events.length===0&&page.activations===0,'仅预留权限丢ACK仍产生了原生事件或click');return {result,nativeEvents,page};
 });
 await check('cancel_before_activation',async()=>{
  await reset();const cancellation=new AbortController();const result=await submitPromptOnce(webview,guard('fixture:cancel:run-1',{signal:cancellation.signal,beforeDispatch:async()=>cancellation.abort()}));const page=await read();
  assert(result.kind==='not_dispatched'&&page.activations===0,'提交前取消必须零激活');return {result,page};
 });
 await check('cancel_after_mouse_down_releases_without_click',async()=>{
  await reset();const cancellation=new AbortController();const send=webview.sendInputEvent.bind(webview);const wrapped=new Proxy(webview,{get(target,key){if(key==='sendInputEvent')return(event)=>{const result=send(event);if(event.type==='mouseDown')cancellation.abort();return result;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  const safety=guard('fixture:cancel-after-down:run-1',{signal:cancellation.signal});const result=await submitPromptOnce(wrapped,safety);const page=await read();
  assert(result.kind==='dispatch_unknown'&&page.activations===0,'按下后取消必须释放且保留派发不明，不能click');
  assert(page.events.filter(event=>event.type==='mousedown'&&event.isTrusted).length===1,'按下后取消夹具没有送达原生mousedown');return {result,page};
 });
 await check('old_run_cannot_submit_new_run',async()=>{
  await reset();let current=true;const old=await submitPromptOnce(webview,guard('fixture:old:run-1',{isCurrent:()=>current,beforeDispatch:async()=>{current=false;}}));
  assert(old.kind==='not_dispatched'&&(await read()).activations===0,'旧run撤销后仍激活');
  const next=await submitPromptOnce(webview,guard('fixture:new:run-2'));const page=await read();assert(next.kind==='dispatch_attempted'&&page.activations===1&&page.trustedActivations===1,'新run没有独立单次权限');return {old,next,page};
 });
 await check('reserved_cancel_isolates_next_run',async()=>{
  await reset();const cancellation=new AbortController();const key='fixture:reserved-old:run-1';
  const release=await beginVideoPageOperation(webview,{operationId:key,taskId:'fixture-task',runId:'run-1',signal:cancellation.signal,deadlineAt:Date.now()+10000});
  let reserved;try{const expected=await preparePageSubmission(webview);reserved=await probe({expected,dispatchKey:key,deadlineAt:Date.now()+4000,expectedPrompt:prompt,strictParagraphs:true,reserveNative:true});assert(reserved.nativeReserved,'正式探针没有保留原生单次权限');await probe({cancelNativeKey:key});cancellation.abort();}finally{release();}
  await webview.executeJavaScript('true');await activate(reserved);const cancelled=await read();assert(cancelled.activations===0,'已撤销的原生权限仍激活控件');
  const nextKey='fixture:reserved-new:run-2';const nextController=new AbortController();const releaseNext=await beginVideoPageOperation(webview,{operationId:nextKey,taskId:'fixture-task',runId:'run-2',signal:nextController.signal,deadlineAt:Date.now()+10000});
  let result;try{result=await submitPromptOnce(webview,guard(nextKey,{signal:nextController.signal}));}finally{releaseNext();}
  const page=await read();assert(result.kind==='dispatch_attempted'&&page.activations===1&&page.trustedActivations===1,'旧权限污染下一run');return {result,cancelled,page};
 });
 return {success:cases.every(item=>item.success),cases};
}};
`;
await fs.writeFile(renderer, rendererSource);
await build({ configFile: false, root: repository, logLevel: 'error', build: { outDir: bundleDirectory, emptyOutDir: true, minify: false,
  lib: { entry: renderer, formats: ['iife'], name: 'NativeSubmissionFixture', fileName: () => 'runner.js' } } });
const sourceFiles = ['src/utils/doubaoBridge.ts', 'src/utils/submissionControls.ts', 'src/utils/nativeMediaSubmission.ts', 'src/automation/videoExecutionContext.ts'];
const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [file, createHash('sha256').update(await fs.readFile(path.join(repository, file))).digest('hex')])));
const config = { output, temporary, repository, bundleDirectory, prompt, sourceHashes, verificationId };
const harness = path.join(temporary, 'main.cjs');
await fs.writeFile(harness, `
const {app,BrowserWindow}=require('electron');const fs=require('node:fs/promises');const path=require('node:path');const http=require('node:http');
const config=${JSON.stringify(config)};app.setName('Doubao Native Submission Fixture');app.setPath('userData',path.join(config.temporary,'profile'));app.disableHardwareAcceleration();
let server;let host;const startedAt=new Date().toISOString();
const guest='<!doctype html><html><head><meta charset="utf-8"><title>OFFLINE native guest</title><style>body{margin:0;background:#ddd}#composer{position:relative;margin:40px;width:560px;height:180px;background:white}textarea{position:absolute;left:20px;top:20px;width:500px;height:80px}button{position:absolute;right:20px;bottom:20px;width:40px;height:40px}</style></head><body><div id="composer"><textarea></textarea><button id="flow-end-msg-send" aria-label="发送">发</button></div><script>const editor=document.querySelector("textarea");const button=document.querySelector("button");let events=[];let activations=0;let trustedActivations=0;for(const type of ["pointerdown","mousedown","pointerup","mouseup","click"])document.addEventListener(type,event=>{if(button===event.target||button.contains(event.target))events.push({type:event.type,isTrusted:event.isTrusted,button:event.button});},true);button.addEventListener("click",event=>{activations++;if(event.isTrusted)trustedActivations++;});globalThis.fixtureReset=()=>{events=[];activations=0;trustedActivations=0;editor.value='+JSON.stringify(config.prompt)+';return true;};globalThis.fixtureSnapshot=()=>({events:[...events],activations,trustedActivations,inputLength:editor.value.length,documentId:performance.timeOrigin});globalThis.fixtureReset();</script></body></html>';
async function finish(evidence,exitCode){const result={verificationId:config.verificationId,fixture:true,platformVerified:false,startedAt,finishedAt:new Date().toISOString(),build:{version:require(path.join(config.repository,'package.json')).version,electron:process.versions.electron,chrome:process.versions.chrome,node:process.versions.node,sourceHashes:config.sourceHashes},...evidence};await fs.writeFile(path.join(config.output,'evidence.json'),JSON.stringify(result,null,2));host?.destroy();server?.closeAllConnections();server?.close();app.exit(exitCode);}
app.whenReady().then(async()=>{
 const runner=await fs.readFile(path.join(config.bundleDirectory,'runner.js'));
 server=http.createServer((request,response)=>{if(request.url.startsWith('/guest')){response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});response.end(guest);}else if(request.url==='/runner.js'){response.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});response.end(runner);}else{const origin='http://127.0.0.1:'+server.address().port;response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});response.end('<!doctype html><meta charset="utf-8"><title>OFFLINE native host</title><style>html,body{margin:0;width:100%;height:100%}webview{display:flex;width:800px;height:600px}</style><webview partition="native-submission-fixture" src="'+origin+'/guest" webpreferences="contextIsolation=yes,nodeIntegration=no,backgroundThrottling=no"></webview><script>globalThis.fixtureGuestReady=new Promise(resolve=>document.querySelector("webview").addEventListener("dom-ready",resolve,{once:true}));</script><script src="/runner.js"></script>');}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 host=new BrowserWindow({width:820,height:640,show:false,webPreferences:{webviewTag:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 await host.loadURL('http://127.0.0.1:'+server.address().port+'/host');const focusedBefore=host.isFocused();
 const result=await host.webContents.executeJavaScript('globalThis.nativeSubmissionFixture.run()');const focusedAfter=host.isFocused();
 if(focusedBefore||focusedAfter){result.success=false;result.focusError='隔离窗口意外获得系统焦点';}
 await finish({...result,focusedBefore,focusedAfter},result.success?0:1);
}).catch(async(error)=>{await finish({success:false,error:String(error.stack||error)},1);});
`);
try {
  await run(require('electron'), [harness], { cwd: repository, timeout: 35_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }, maxBuffer: 1024 * 1024 });
} catch (error) {
  process.exitCode = 1;
  console.error('独立 Electron 原生提交验收失败，证据已保留。', error.stderr || error.message);
} finally {
  await fs.copyFile(harness, path.join(output, 'harness-main.cjs.txt'));
  await fs.copyFile(renderer, path.join(output, 'harness-renderer.js.txt'));
  await fs.rm(temporary, { recursive: true, force: true });
}
try {
  const evidence = JSON.parse(await fs.readFile(path.join(output, 'evidence.json'), 'utf8'));
  if (evidence.verificationId !== verificationId) throw new Error('输出目录只含旧次运行证据，本次没有完整回执');
  console.log(JSON.stringify({ success: evidence.success, fixture: true, platformVerified: false, focusedBefore: evidence.focusedBefore, focusedAfter: evidence.focusedAfter,
    cases: evidence.cases?.map(({ name, success, error, elapsedMs }) => ({ name, success, error, elapsedMs })), evidence: path.join(output, 'evidence.json') }, null, 2));
} catch (error) {
  process.exitCode = 1; console.error('未取得可读的原生事件证据。', error.message);
}
