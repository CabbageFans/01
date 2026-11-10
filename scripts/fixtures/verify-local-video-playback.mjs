/** 真实 Electron/Chromium 离线媒体验收。平台生成不在此夹具证明范围内。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const require = createRequire(import.meta.url);
const repository = process.cwd();
const mediaModule = require(path.join(repository, 'dist/main/utils/petstoryMedia.js'));
const output = path.resolve(process.argv[2] || path.join(repository, 'artifacts/mac/video-workflow-local', new Date().toISOString().replace(/[:.]/g, '-')));
await fs.mkdir(output, { recursive: true });
const fixture = path.join(output, 'fixture-source.mp4');
await run(mediaModule.resolveMediaExecutable('ffmpeg'), ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x240:r=12:d=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', fixture]);
await fs.writeFile(path.join(output, 'player.html'), `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; media-src 'self' data: doubao-media:"><title>本地视频链路隔离验收</title><style>body{margin:0;background:#151525;color:white;font:16px sans-serif}video{display:block;height:480px;margin:24px auto}p{text-align:center}</style><p>离线夹具：真实五秒 MP4，真实 Chromium 解码播放</p><video id="video" controls muted playsinline></video><script>
globalThis.playbackEvidence = new Promise((resolve,reject)=>{
 const video=document.querySelector('video'); let phase='initial'; let startedAt=performance.now(); let metadata;
 const timer=setTimeout(()=>reject(new Error('真实播放未在预算内完成，phase='+phase)),12000);
 video.onerror=()=>{clearTimeout(timer);reject(new Error('真实播放器错误 '+video.error?.code));};
 video.onloadedmetadata=()=>{metadata={duration:video.duration,width:video.videoWidth,height:video.videoHeight};video.play().catch(reject);};
 video.ontimeupdate=()=>{
  if(phase==='initial'&&video.currentTime>=0.25){phase='seeking';video.pause();video.currentTime=3.5;}
  else if(phase==='resumed'&&video.currentTime>=3.8){video.pause();clearTimeout(timer);resolve({...metadata,currentTime:video.currentTime,readyState:video.readyState,paused:video.paused,seekCompleted:true,elapsedMs:Math.round(performance.now()-startedAt)});}
 };
 video.onseeked=()=>{if(phase==='seeking'){phase='resumed';video.play().catch(reject);}};
 video.src=new URLSearchParams(location.search).get('source');
});
</script>`);
const config = { repository, output, fixture };
await fs.writeFile(path.join(output, 'config.json'), JSON.stringify(config));
const harnessDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'doubao-video-playback-harness-'));
const harnessPath = path.join(harnessDirectory, 'main.cjs');
await fs.writeFile(harnessPath, `
const {app,BrowserWindow,protocol}=require('electron');
const fs=require('node:fs'); const promises=require('node:fs/promises'); const path=require('node:path'); const http=require('node:http');
const config=${JSON.stringify(config)};
const root=config.repository; const load=(file)=>require(path.join(root,'dist/main',file));
const {localMediaStreams,registerLocalMediaScheme}=load('utils/LocalMediaProtocol.js');
registerLocalMediaScheme(protocol); app.setPath('userData',path.join(config.output,'electron-profile'));app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
const {DownloadService}=load('utils/DownloadService.js');const {DownloadRepository}=load('utils/DownloadRepository.js');
const {PetStoryProjects}=load('utils/petstoryProject.js');const {PetStoryProductionService}=load('utils/petstoryProduction.js');const {validatePetStoryMedia}=load('utils/petstoryMedia.js');
const {localMediaSource}=load('utils/localMediaSource.js');const {TaskService}=load('core/TaskService.js');const {TaskRepository}=load('core/TaskRepository.js');const {TaskEventStream}=load('core/TaskEventStream.js');const {normalizeTasks}=load('utils/persistenceNormalization.js');
let server; let window; const phaseTimes=[]; const mark=(stage)=>phaseTimes.push({stage,at:new Date().toISOString()});
const protocolReads=[];
const failure=async(error)=>{await promises.writeFile(path.join(config.output,'evidence.json'),JSON.stringify({fixture:true,platformVerified:false,success:false,error:String(error.stack||error),phaseTimes},null,2));server?.closeAllConnections();server?.close();app.exit(1);};
app.whenReady().then(async()=>{
 protocol.handle('doubao-media',async(request)=>{const response=await localMediaStreams.respond(request);protocolReads.push({method:request.method,range:request.headers.get('range'),status:response.status,contentRange:response.headers.get('content-range')});return response;});
 mark('fixture-start');
 const sourceStat=await promises.stat(config.fixture); server=http.createServer((_request,response)=>{response.writeHead(200,{'Content-Type':'video/mp4','Content-Length':sourceStat.size});fs.createReadStream(config.fixture).pipe(response);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); const sourceUrl='http://127.0.0.1:'+server.address().port+'/fixture.mp4';
 const taskFile=path.join(config.output,'tasks.json');await promises.writeFile(taskFile,'[]');
 const repository=new TaskRepository({read:()=>JSON.parse(fs.readFileSync(taskFile,'utf8')),write:(_filename,tasks)=>{fs.writeFileSync(taskFile,JSON.stringify(tasks,null,2));return true;},normalize:normalizeTasks,events:new TaskEventStream(),defaultProjectId:()=> 'fixture-studio'});
 const core=new TaskService({store:repository,defaultProjectId:()=> 'fixture-studio',id:()=> 'fixture-task'});
 const ensure=(result)=>{if(!result.success)throw new Error(result.error);return result.data;};
 const task=ensure(core.create({prompts:['TEST offline HTTP media fixture'],mode:'video',videoConfig:{model:'seedance-2.0',duration:'5s',aspectRatio:'9:16'},executionIntent:'hold'}))[0];ensure(core.assign({taskId:task.id,accountId:'fixture-account'}));
 const now=new Date().toISOString();const runId='fixture-run';
 ensure(core.updateRuntime({taskId:task.id,status:'executing',runtime:{runId,attempt:1,stage:'injecting_prompt',message:'离线夹具，非平台提交',startedAt:now,stageStartedAt:now,lastHeartbeatAt:now,input:{prompt:task.prompt,mode:'video',attachments:[],videoConfig:task.videoConfig}}}));
 ensure(core.updateRuntime({taskId:task.id,expectedRunId:runId,runtime:{submittedAt:now}}));
 ensure(core.updateStatus({taskId:task.id,expectedRunId:runId,status:'done',outputs:[sourceUrl]}));
 const original=ensure(core.getTasks())[0]; const artifact=original.artifacts[0];
 const mediaFact=(phase,state,more={})=>ensure(core.updateLocalMedia(task.id,runId,{operationId:'media:'+runId+':'+artifact.id,artifactId:artifact.id,phase,state,expectedRevision:ensure(core.getTasks())[0].revision,...more}));
 mediaFact('downloading','working');
 let jobs=[]; const ledger=path.join(config.output,'downloads.json');
 const download=new DownloadService(new DownloadRepository({read:()=>structuredClone(jobs),write:(next)=>{jobs=structuredClone(next);fs.writeFileSync(ledger,JSON.stringify(jobs,null,2));return true;}}));
 const job=await download.download({taskId:task.id,runId,artifactId:artifact.id,accountId:'fixture-account',mode:'video',url:sourceUrl,saveDir:path.join(config.output,'downloads'),fetch});mediaFact('downloaded','working',{downloadJobId:job.id});mark('downloaded');
 mediaFact('validating','working');
 const validation=await validatePetStoryMedia(job.filePath,'video');mark('validated');
 const directory=path.join(config.output,'project');await promises.mkdir(directory,{recursive:true});const projects=new PetStoryProjects();let project=await projects.create(directory,'fixture-studio','fixture-account');
 mediaFact('library','working',{assetId:'fixture-asset',mediaInfo:validation,sha256:validation.sha256});
 const relativePath='shots/fixture-shot/fixture-asset.mp4';await promises.mkdir(path.dirname(path.join(directory,relativePath)),{recursive:true});await promises.copyFile(job.filePath,path.join(directory,relativePath));
 const asset={id:'fixture-asset',kind:'video',shotId:'fixture-shot',relativePath,taskId:task.id,runId,artifactId:artifact.id,downloadJobId:job.id,generationPrompt:task.prompt,validation};asset.sourceSnapshot=localMediaSource(project,asset,undefined,original);project.assets.push(asset);project=await projects.write(project);mediaFact('ready','ready',{assetId:asset.id,downloadJobId:job.id,mediaInfo:validation,sha256:validation.sha256});const localMedia=ensure(core.getTasks())[0].runtime.localMedia;mark('library-saved');
 // 完成媒体已独立保存；正式 Core 清理队列，旧远端 URL 不再参与本地读取。
 ensure(core.delete(task.id));await new Promise(resolve=>server.close(resolve));server=undefined;mark('task-cleaned-and-remote-stopped');
 const production=new PetStoryProductionService(projects,{list:()=>ensure(core.getTasks()),downloads:()=>jobs,updateLocalMedia:(taskId,originalRunId,patch)=>ensure(core.updateLocalMedia(taskId,originalRunId,patch)),create:()=>{throw new Error('不允许重生成');},adopt:()=>{throw new Error('不允许重生成');},retryUnsubmitted:()=>{throw new Error('不允许重生成');},download:()=>{throw new Error('不允许重下载');}});
 const file=await production.assetFile(await projects.read(project.id),asset.id,'video');const url=await localMediaStreams.issue(file,validation.bytes);
 window=new BrowserWindow({width:640,height:600,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,autoplayPolicy:'no-user-gesture-required'}});
 await window.loadFile(path.join(config.output,'player.html'),{query:{source:url}});
 const playback=await window.webContents.executeJavaScript('globalThis.playbackEvidence');mark('played-and-seeked');
 if(!(playback.currentTime>=3.8&&playback.width===160&&playback.height===240&&playback.seekCompleted))throw new Error('真实播放证据不完整');
 await promises.writeFile(path.join(config.output,'playback.png'),(await window.webContents.capturePage()).toPNG());
 const evidence={fixture:true,platformVerified:false,success:true,build:{version:require(path.join(root,'package.json')).version,electron:process.versions.electron,chrome:process.versions.chrome,node:process.versions.node},identity:{projectId:project.id,shotId:asset.shotId,taskId:task.id,runId,artifactId:artifact.id,downloadJobId:job.id,assetId:asset.id},file:{relativePath:path.relative(config.output,file),sha256:validation.sha256,bytes:validation.bytes,durationSeconds:validation.durationSeconds},taskCountAfterCleanup:ensure(core.getTasks()).length,localMedia,playback,protocolReads,phaseTimes};
 await promises.writeFile(path.join(config.output,'evidence.json'),JSON.stringify(evidence,null,2));window.destroy();app.exit(0);
}).catch(failure);
`);
const electron = require('electron');
try {
  await run(electron, [harnessPath], { cwd: repository, timeout: 30_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }, maxBuffer: 1024 * 1024 });
} catch (error) {
  console.error('Electron 媒体验收失败；保留夹具和阶段证据。', error.stderr || error.message);
  console.error(path.join(output, 'evidence.json'));
  process.exitCode = 1;
} finally {
  await fs.copyFile(harnessPath, path.join(output, 'main.cjs.txt'));
  await fs.rm(harnessDirectory, { recursive: true, force: true });
}
if (!process.exitCode) {
  const evidence = JSON.parse(await fs.readFile(path.join(output, 'evidence.json'), 'utf8'));
  console.log(JSON.stringify({ success: evidence.success, platformVerified: false, evidence: path.join(output, 'evidence.json'), playback: evidence.playback, sha256: evidence.file.sha256, bytes: evidence.file.bytes, protocolReads: evidence.protocolReads }, null, 2));
}
