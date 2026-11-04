/** 隔离 Electron 取证驱动：只读打开项目、普通控件、定尺和截图；不提供生成/提交命令。 */
const { _electron } = require('/Users/zarkding/Documents/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright');
const fs=require('node:fs/promises'); const path=require('node:path'); const readline=require('node:readline');
const evidence=path.resolve('design/ui-refresh/handoff/evidence');
const copy=path.join(evidence,'sample-project');
(async()=>{
 const env={...process.env,VITE_DEV_SERVER_URL:'http://127.0.0.1:5173'}; delete env.ELECTRON_RUN_AS_NODE;
 const electron=await _electron.launch({executablePath:path.resolve('node_modules/.pnpm/electron@43.8.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[process.cwd(),'--profile=mac-test','--dev-viewport-size=1440x900','--local-control'],env,timeout:20000});
 const page=await electron.firstWindow();
 await electron.context().route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/,route=>route.abort());
 const tempProfile=await electron.evaluate(({app})=>app.getPath('userData'));
 const sample=JSON.parse(await fs.readFile(path.join(copy,'project.json'),'utf8'));
 // 独立 profile 仅补全项目索引以供只读打开；账号、任务和 Session 均未复制。
 await fs.writeFile(path.join(tempProfile,'DoubaoStudioData','projects.json'),JSON.stringify([{id:sample.studioProjectId,name:'样板项目（隔离取证）',description:'',color:'#6d5dfc',archived:false,createdAt:sample.updatedAt,updatedAt:sample.updatedAt}]));
 await page.reload(); await page.getByRole('button',{name:'短剧创作',exact:true}).waitFor();
 const auditStart={capturedAt:new Date().toISOString(),profile:'isolated mac-test',originalProfileUntouched:true,accountCount:0,taskCount:0,network:'external HTTP aborted; no platform requests',directoryPicker:'one-shot native dialog selection automation; project loaded via normal Open button, original IPC and validation',source:'working tree React served by existing local Vite; compiled main from current clean worktree',sampleRevision:sample.revision};
 await fs.writeFile(path.join(evidence,'capture-environment.json'),JSON.stringify(auditStart,null,2));
 const rl=readline.createInterface({input:process.stdin});
 async function stable(){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
 async function state(){await stable();return {metrics:await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,canvasTransform:document.querySelector('.canvas-content')?.style.transform||null,canvasBounds:document.querySelector('.canvas-viewport')?.getBoundingClientRect().toJSON()||null})),headings:await page.getByRole('heading').allTextContents(),dialogs:await page.getByRole('dialog').count()};}
 console.log(JSON.stringify({ready:true,...await state()}));
 for await(const line of rl){
  try{
   const cmd=JSON.parse(line); let result;
   if(cmd.op==='state')result=await state();
   else if(cmd.op==='open'){
    await electron.evaluate(({dialog},directory)=>{const original=dialog.showOpenDialog;dialog.showOpenDialog=async(...args)=>{dialog.showOpenDialog=original;return {canceled:false,filePaths:[directory]};};},copy);
    await page.getByText('打开项目',{exact:true}).first().click(); await page.locator('.canvas-viewport').waitFor({state:'visible'}); result=await state();
   }else if(cmd.op==='scroll'){await page.getByText(cmd.name,{exact:true}).nth(cmd.index||0).scrollIntoViewIfNeeded(); result=await state();}
   else if(cmd.op==='click'){
    if(/^(?:生成|开始|采用|确认使用|保存|重发|重试|删除|继续制作|收取|满意，采用|提交)/.test(cmd.name))throw Error('本轮驱动禁止业务写入按钮');
    await (cmd.selector ? page.locator(cmd.selector) : cmd.role ? page.getByRole(cmd.role,{name:cmd.name,exact:true}) : page.getByText(cmd.name,{exact:true})).nth(cmd.index||0).click({timeout:5000}); result=await state();
   }else if(cmd.op==='snapshot'){
    await fs.writeFile(path.join(evidence,cmd.file),await page.locator('body').ariaSnapshot()); result={saved:cmd.file,...await state()};
   }else if(cmd.op==='screenshot'){
    await stable(); await page.screenshot({path:path.join(evidence,cmd.file),animations:'disabled'}); const metrics=await state(); await fs.writeFile(path.join(evidence,cmd.file+'.json'),JSON.stringify({file:cmd.file,capturedAt:new Date().toISOString(),...metrics},null,2)); result={saved:cmd.file,...metrics};
   }else if(cmd.op==='resize'){
    await electron.evaluate(({BrowserWindow},size)=>{BrowserWindow.getAllWindows().find(w=>w.getTitle()==='短剧工作室').setContentSize(size.width,size.height);},cmd); result=await state();
   }else if(cmd.op==='pan'){
    const bounds=await page.locator('.canvas-viewport').boundingBox(); const x=bounds.x+bounds.width-20;const y=bounds.y+bounds.height/2;await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+cmd.dx,y+cmd.dy,{steps:10});await page.mouse.up();result=await state();
   }else if(cmd.op==='focus'){
    await electron.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>w.getTitle()==='短剧工作室');w.show();w.focus();}); result=await state();
   }else if(cmd.op==='close'){
    await electron.close();console.log(JSON.stringify({closed:true}));break;
   }else throw Error('unknown op');
   console.log(JSON.stringify({ok:true,...result}));
  }catch(e){console.log(JSON.stringify({ok:false,error:String(e).slice(0,600)}));}
 }
})().catch(e=>{console.error(String(e));process.exitCode=1;});
