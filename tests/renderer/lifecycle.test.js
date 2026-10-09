import { describe, expect, test } from 'bun:test'

// Real Renderer, NCOverlay, Patcher, State and Timeline Core. Browser IO and
// NiconiComments' drawing backend are fixtures; this does not reproduce GPU
// compositing or DRM playback. Each process isolates browser/module globals.
const probe = String.raw`
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
const mode = process.argv.at(-1)
const raf = new Map(), engines = [], destroyed = [], logs = [], stored = new Map(), listeners = new Map()
let nextFrame = 0, clock = 0, fallback = false
const flush = async () => { for (let i=0;i<150;i++) await Promise.resolve() }
const deferred = () => { let resolve,reject; const promise = new Promise((r,j) => { resolve=r;reject=j }); return { promise, resolve, reject } }
class Classes {
  values = new Set()
  add(...names) { names.forEach(n => this.values.add(n)) }
  remove(...names) { names.forEach(n => this.values.delete(n)) }
  contains(n) { return this.values.has(n) }
}
class Style {
  opacity = ''; display = ''; backgroundColor = 'rgba(0, 0, 0, 0)'
  get cssText() { return JSON.stringify([this.opacity,this.display,this.backgroundColor]) }
  set cssText(text) { if (text) [this.opacity,this.display,this.backgroundColor]=JSON.parse(text) }
}
class Element extends EventTarget {
  constructor(tag) { super(); this.tagName=tag; this.classList=new Classes(); this.style=new Style(); this.children=[]; this.parentNode=null }
  get className() { return [...this.classList.values].join(' ') }
  set className(s) { this.classList.values=new Set(s.split(' ').filter(Boolean)) }
  get isConnected() { return this===document.body || !!this.parentNode?.isConnected }
  append(child) { child.remove(); this.children.push(child); child.parentNode=this }
  remove() { if (this.parentNode) this.parentNode.children=this.parentNode.children.filter(c=>c!==this); this.parentNode=null }
  replaceWith(child) { const parent=this.parentNode; if (!parent) return; const index=parent.children.indexOf(this); child.remove(); parent.children[index]=child; child.parentNode=parent; this.parentNode=null }
  getBoundingClientRect() { return { x:0,y:0,width:1920,height:1080 } }
  querySelectorAll(selector) { const result=[]; for(const c of this.children) { if(selector==='canvas.NCOverlay-Canvas'&&c.tagName==='canvas'&&c.classList.contains('NCOverlay-Canvas')) result.push(c); result.push(...c.querySelectorAll(selector)) } return result }
}
class Canvas extends Element {
  constructor() { super('canvas'); this.width=0; this.height=0; this.white=false }
  getContext() { throw new Error('Diagnostic must not create a graphics context') }
}
class Video extends Element {
  constructor() { super('video'); this.duration=1425; this.currentTime=120; this.readyState=0; this.videoWidth=1920; this.videoHeight=1080; this.playbackRate=1; this.paused=true; this.src='PRIVATE-URL' }
}
class Doc extends EventTarget {
  constructor() { super(); this.body=new Element('body') }
  createElement(tag) { assert.equal(tag,'canvas'); return new Canvas() }
  querySelectorAll(selector) { return this.body.querySelectorAll(selector) }
}
globalThis.document = new Doc()
globalThis.window = { devicePixelRatio:1 }
globalThis.HTMLCanvasElement=Canvas
globalThis.HTMLMediaElement={ HAVE_METADATA:1 }
globalThis.EXT_USER_AGENT='fixture'
globalThis.performance={ now() { return clock } }
globalThis.requestAnimationFrame=callback=>{const id=++nextFrame;raf.set(id,callback);return id}
globalThis.cancelAnimationFrame=id=>raf.delete(id)
globalThis.getComputedStyle=canvas=>({display:canvas.style.display||'block',visibility:'visible',position:'absolute',opacity:canvas.style.opacity||'1',backgroundColor:canvas.style.backgroundColor,zIndex:'auto',transform:'none'})
function makeSurface(canvas) {
  if(fallback) { fallback=false; const fresh=new Canvas();fresh.width=canvas.width;fresh.height=canvas.height;fresh.className=canvas.className;fresh.style.cssText=canvas.style.cssText;canvas.replaceWith(fresh);canvas=fresh }
  let lost=false
  const gl={ FRAMEBUFFER_BINDING:1,RGBA:2,UNSIGNED_BYTE:3,NO_ERROR:0,
    isContextLost:()=>lost,getContextAttributes:()=>({alpha:true,preserveDrawingBuffer:false}),getParameter:()=>null,
    readPixels(_x,_y,_w,_h,_f,_t,pixel) { pixel.fill(canvas.white?255:0) },getError:()=>0 }
  return { canvas,rendererName:'WebGL2Renderer',gl,destroy() { assert.equal(canvas.isConnected,false,'GPU context must be released off DOM'); lost=true;destroyed.push(canvas) } }
}
class Nico {
  static internal={ renderer:{ createRenderer:makeSurface } }
  constructor(surface,threads,options) { this.surface=surface;this.threads=structuredClone(threads);this.options=options;this.draws=[];this.dead=false;engines.push(this) }
  clear() { this.surface.canvas.white=false }
  destroy() { assert.equal(this.dead,false);this.dead=true;this.surface.destroy() }
  drawCanvas(vpos) { assert.equal(this.dead,false);this.draws.push(vpos);return true }
}
mock.module('@xpadev-net/niconicomments',()=>({default:Nico}))
mock.module('@/utils/logger',()=>({logger:{log(...a){logs.push(a)},error(){}}}))
mock.module('@/utils/webext',()=>({webext:{runtime:{connect(){return {onMessage:{addListener(){}},disconnect(){}}}}}}))
mock.module('@/messaging/extension',()=>({async sendExtensionMessage(name){return name==='bg:getCurrentTab'?{id:1}:null},onExtensionMessage(){return()=>{}}}))
mock.module('@/ncoverlay/keyboard',()=>({NCOKeyboard:class {dispose(){}}}))
if(!mode.startsWith('load-')) mock.module('@/ncoverlay/searcher',()=>({NCOSearcher:class {async cancel(){} async autoSearch(){}}}))
else {
 mock.module('@/proxy/nco-utils/search/extension',()=>({ncoSearchProxy:{}}))
 mock.module('@/proxy/nco-utils/api/extension',()=>({ncoApiProxy:{}}))
}
const settingsValues={
  'comment:speed':1,'comment:customize':{},'comment:hideAssistedComments':false,'comment:adjustJikkyoOffset':false,
  'autoSearch:jikkyoOnlyAdjustable':false,'ng:sharingLevel':'none','autoSearch:manual':true,
  'autoSearch:targets':[],'autoSearch:jikkyoChannelIds':[],'autoSearch:jikkyoIgnoreRerun':false,
  'comment:useNiconicoCredentials':false,'comment:amount':1,
}
const initialWatches=[]
mock.module('@/utils/settings/extension',()=>({settings:{async get(...keys){const v=keys.map(k=>{assert.ok(k in settingsValues,k);return settingsValues[k]});return keys.length===1?v[0]:v},onChange(){return()=>{}},watch(key,callback){initialWatches.push([key,callback]);return()=>{}}}}))
mock.module('@/utils/api/niconico/getNgSettings',()=>({async getNgSettings(){return {words:[],commands:[],ids:[]}}}))
function notify(key,value,old) { for (const fn of listeners.get(key)??[]) fn(value,old) }
mock.module('@/utils/storage/extension',()=>({storage:{async get(key){return structuredClone(stored.get(key)??null)},async set(key,value){const old=stored.get(key)??null;stored.set(key,structuredClone(value));notify(key,value,old)},async remove(key){const old=stored.get(key)??null;stored.delete(key);notify(key,null,old)},onChange(key,fn){if(!listeners.has(key))listeners.set(key,new Set());listeners.get(key).add(fn);return()=>listeners.get(key).delete(fn)}}}))
const { NCORenderer }=await import('./src/ncoverlay/renderer.ts')
const { NCOverlay }=await import('./src/ncoverlay/index.ts')
const { NCOPatcher }=await import('./src/ncoverlay/patcher.ts')
const threads=[{id:'thread',fork:'main',commentCount:1,comments:[{id:'1',body:'PRIVATE-COMMENT',vposMs:100000,commands:[],userId:'PRIVATE-USER',score:0,isPremium:false}]}]
const video=new Video();document.body.append(video)
const canvases=()=>document.querySelectorAll('canvas.NCOverlay-Canvas')
function renderer() { const r=new NCORenderer(video,{canvasDiagnostics:true});document.body.append(r.canvas);r.setThreads(threads);r.reload();return r }
async function seed(state) {
 await state.set('slots',[{id:'manual',threads,isAutoLoaded:false}])
 await state.set('slotDetails',[{id:'manual',type:'official',status:'ready',offsetMs:5000,isAutoLoaded:false}])
 await state.set('offset',2);await flush()
}
const timeline=adjustment=>({alignments:[{sourceTimeMs:0,targetTimeMs:0,reason:'start'},{sourceTimeMs:100000,targetTimeMs:100000+adjustment,reason:'break'}],durationMs:1425000+adjustment})
async function update(nco,adjustment,duration) { const old=await nco.state.get('info');await nco.state.set('info',{...old,providerTimeline:{...timeline(adjustment),durationMs:duration??1425000+adjustment}});await flush() }
if(mode.startsWith('load-')) {
 if(mode==='load-iterator')Object.defineProperty(Object.getPrototypeOf(new Map().values()),'map',{value:undefined})
 let episode=1;const requests=[],metadata=deferred(),writeGate=deferred()
 settingsValues['autoSearch:manual']=false;settingsValues['autoSearch:targets']=['official','danime']
 const candidate=(id)=>({contentId:id,title:'PRIVATE-TITLE',lengthSeconds:1425,startTime:'2026-10-09',channelId:1,categoryTags:'アニメ',tags:'',thumbnailUrl:undefined,viewCounter:1,commentCounter:1})
 mock.module('@/proxy/nco-utils/search/extension',()=>({ncoSearchProxy:{async niconico(){return {official:[candidate('so'+episode+'1'),...(mode==='load-loaded-id'?[candidate('so13')]:[])],danime:[candidate('so'+episode+'2')],chapter:[],szbh:[]}}}}))
 const watch=id=>({type:'v4',data:{video:{id,count:{view:1,comment:1},thumbnail:{large:'fixture-thumb'},duration:1425},comment:{threads:[],ng:{}}},rawData:{comment:{nvComment:{params:{targets:[]}}}}})
 mock.module('@/proxy/nco-utils/api/extension',()=>({ncoApiProxy:{niconico:{
  watch(id){const gate=deferred();requests.push({id,...gate});return gate.promise},
  async threads(response){return {threads:[{...threads[0],id:response.data.video.id}]}}
 }}}))
 const {storage}=await import('./src/utils/storage/extension.ts')
 const patcher=new NCOPatcher('primeVideo',{
  async getInfo(owner){const selected=episode;if(mode==='load-info-stale'&&selected===1)await metadata.promise;
   if(mode==='load-loaded-id') {
    await owner.state.set('slots',[{id:'so11',threads,isAutoLoaded:false}])
    await owner.state.set('slotDetails',[{id:'so11',type:'official',status:'ready',isAutoLoaded:false}])
   }
   return {input:'Fixture #'+selected,duration:1425,providerTimeline:timeline(0)}},
  appendCanvas(_video,canvas){document.body.append(canvas)},
 },{canvasDiagnostics:true,pipelineDiagnostics:true})
 await patcher.setVideo(video)
 const nco=patcher.nco
 if(mode==='load-write-drain') {
  const set=storage.set;let block=true
  storage.set=async(key,value)=>{if(block&&key.endsWith(':slotDetails')&&value?.some(v=>v.status==='loading')){block=false;await writeGate.promise}return set(key,value)}
 }
 video.dispatchEvent(new Event('loadedmetadata'));await flush()
 if(mode==='load-info-stale') {
  episode=2;clock+=2000;video.dispatchEvent(new Event('loadedmetadata'));await flush();metadata.resolve();await flush()
 } else if(mode==='load-stale'||mode==='load-write-drain') {
  episode=2;clock+=2000;video.dispatchEvent(new Event('loadedmetadata'));await flush()
  if(mode==='load-write-drain'){writeGate.resolve();await flush()}
 } else if(mode==='load-episode') {
  assert.equal((await nco.state.get('slotDetails')).every(v=>v.status==='loading'),true)
  for(const request of requests)request.resolve(watch(request.id));await flush()
  assert.equal((await nco.state.get('slotDetails')).every(v=>v.status==='ready'),true)
  const old=nco.canvas;episode=2;clock+=2000;video.dispatchEvent(new Event('loadedmetadata'));await flush();assert.equal(old.isConnected,false)
 } else if(mode==='load-dispose') {
  await patcher.dispose();for(const request of requests)request.resolve(watch(request.id));await flush()
  assert.equal(await nco.state.get('slots'),null);assert.equal(await nco.state.get('slotDetails'),null);assert.equal(canvases().length,0)
 } else if(mode==='load-video') {
  episode=2;const next=new Video();document.body.append(next);await patcher.setVideo(next);next.dispatchEvent(new Event('loadedmetadata'));await flush()
 }
 if(mode!=='load-dispose') {
  const current=patcher.nco
  const details=await current.state.get('slotDetails')
  assert.equal(details.filter(v=>v.status==='loading').length,2)
  if(episode===2)assert.equal(details.every(v=>v.id.startsWith('so2')),true)
  for(const request of requests) {
   if(mode==='load-error'&&request.id.endsWith('1'))request.reject(new Error('PRIVATE-API-ERROR'))
   else request.resolve(watch(request.id))
  }
  await flush()
  const loaded=await current.state.get('slotDetails'),slots=await current.state.get('slots')
  assert.equal(loaded.filter(v=>v.status==='loading').length,0)
  const expected=mode==='load-error'?1:mode==='load-loaded-id'?3:2
  assert.equal(loaded.filter(v=>v.status==='ready').length,expected)
  assert.equal(slots.length,expected)
  assert.equal(loaded.filter(v=>v.status==='error').length,mode==='load-error'?1:0)
  if(episode===2)assert.equal(slots.every(v=>v.id.startsWith('so2')),true)
  assert.equal(await current.state.get('status'),'ready');assert.equal(canvases().length,1)
  assert.equal(engines.at(-1).threads.length,slots.length)
  assert.equal(loaded.filter(v=>v.status==='ready'&&v.isAutoLoaded).every(v=>v.info.thumbnail==='fixture-thumb'),true)
  if(mode==='load-loaded-id')assert.ok(slots.find(v=>v.id==='so13').threads.every(t=>t.id==='so13'))
  if(mode==='load-info-stale')assert.ok((await current.state.get('info')).input.input.endsWith('#2'))
  assert.ok(logs.some(([event,payload])=>event==='nco.commentLoad'&&payload.event==='slots.accepted'))
  await patcher.dispose()
 }
} else if(['replace','fallback','raf','terminal','alpha','capture-cleanup'].includes(mode)) {
 const r=renderer(),old=r.canvas
 if(mode==='replace'||mode==='fallback') {
  r.setOpacity(0.6);if(mode==='fallback')fallback=true;r.reload()
  assert.notEqual(r.canvas,old);assert.equal(old.isConnected,false);assert.equal(r.canvas.isConnected,true)
  assert.equal(r.canvas,engines.at(-1).surface.canvas);assert.equal(canvases().length,1);assert.equal(r.canvas.style.opacity,'0.6')
  const active=r.canvas;r.clear();assert.equal(active.isConnected,false);assert.notEqual(r.canvas,active);assert.equal(r.canvas.isConnected,true)
  r.setThreads(threads);r.reload();assert.equal(canvases().length,1)
 } else if(mode==='raf') {
  video.paused=false;r.start();const stale=[...raf.values()][0];r.reload();const count=engines.at(-1).draws.length
  stale(50000);assert.equal(engines.at(-1).draws.length,count);assert.equal(raf.size,1)
  const current=[...raf.values()][0];r.stop();r.start();const count2=engines.at(-1).draws.length;current(60000)
  assert.equal(engines.at(-1).draws.length,count2);assert.equal(raf.size,1)
 } else if(mode==='terminal') {
  r.dispose();const count=engines.length;r.setThreads(threads);r.setOptions({scale:2});r.reload();r.start();r.rerender();r.setOffset(3)
  assert.deepEqual(await r.capture('png'),{format:'png'});assert.equal(document.body.classList.contains('NCOverlay-Capture'),false)
  assert.equal(engines.length,count);assert.equal(raf.size,0);assert.equal(canvases().length,0)
 } else if(mode==='alpha') {
  r.canvas.white=true;r.canvas.style.backgroundColor='rgb(255, 255, 255)'
  document.dispatchEvent(new Event('nco:canvas-diagnostic'))
  const evidence=logs.filter(([name])=>name==='nco.canvasLifecycle').at(-1)[1]
  assert.equal(evidence.opaqueWhiteSamples,25);assert.equal(evidence.cssBackgroundAlpha,1)
  assert.equal(evidence.preserveDrawingBuffer,false);assert.equal(evidence.surfaceMatchesCanvas,true)
  r.canvas.white=false;r.canvas.style.backgroundColor='rgba(0, 0, 0, 0)'
  document.dispatchEvent(new Event('nco:canvas-diagnostic'))
  const transparent=logs.at(-1)[1];assert.equal(transparent.transparentSamples,25);assert.equal(transparent.cssBackgroundAlpha,0)
 } else {
  document.body.classList.add('NCOverlay-Capture');r.clear();assert.equal(document.body.classList.contains('NCOverlay-Capture'),false)
 }
 r.dispose();r.dispose();assert.equal(canvases().length,0);assert.equal(raf.size,0)
 const count=logs.length;document.dispatchEvent(new Event('nco:canvas-diagnostic'));assert.equal(logs.length,count)
} else {
 let episode=1
 const patcher=new NCOPatcher(mode==='netflix'?'netflix':'primeVideo',{
  async getInfo(nco,request) { const bound=nco.video;request.isCurrent=()=>patcher.nco===nco&&nco.video===bound;return {input:'Fixture #'+episode,duration:1425,providerTimeline:timeline(0)} },
  appendCanvas(_video,canvas){document.body.append(canvas)},
 },{canvasDiagnostics:true})
 await patcher.setVideo(video)
 video.dispatchEvent(new Event('loadedmetadata'));await flush();let nco=patcher.nco;await seed(nco.state)
 assert.equal(canvases().length,1)
 if(mode==='episode'||mode==='netflix') {
  const old=nco.canvas;episode=2;clock+=2000;video.currentTime=1;video.dispatchEvent(new Event('loadedmetadata'));await flush()
  assert.equal(old.isConnected,false);await seed(nco.state);assert.equal(nco.canvas.isConnected,true);assert.equal(canvases().length,1)
 } else if(mode==='timeline'||mode==='timeline-race') {
  if(mode==='timeline') {
   const canvas=nco.canvas,count=engines.length
   await update(nco,0,1455000);assert.equal(nco.canvas,canvas);assert.equal(engines.length,count,'Duration-only plan must not recreate canvas')
   await update(nco,32032);assert.notEqual(nco.canvas,canvas);assert.equal(canvas.isConnected,false)
   assert.equal(engines.at(-1).threads[0].comments[0].vposMs,137032)
   assert.equal(engines.at(-1).draws.at(-1),11800,'Global2 seconds composes after Slot/Timeline')
   const mapped=nco.canvas,count2=engines.length;await update(nco,32032,1500000);assert.equal(nco.canvas,mapped);assert.equal(engines.length,count2)
  } else {
   const original=nco.state.getThreads.bind(nco.state),gate=deferred();let delayed=true
   nco.state.getThreads=async()=>{const result=await original();if(delayed){delayed=false;await gate.promise}return result}
   await update(nco,10000);await update(nco,32032);const accepted=nco.canvas
   gate.resolve();await flush();assert.equal(nco.canvas,accepted);assert.equal(engines.at(-1).threads[0].comments[0].vposMs,137032)
  }
 } else if(mode==='clear-race'||mode==='dispose-race') {
  const query=deferred(),cleanup=deferred(),original=nco.state.getThreads.bind(nco.state)
  nco.state.getThreads=async()=>{const result=await original();await query.promise;return result}
  await update(nco,10000)
  const old=nco.canvas,count=engines.length
  if(mode==='clear-race') {
   const clear=nco.state.clear.bind(nco.state);nco.state.clear=async()=>{await cleanup.promise;await clear()}
   const clearing=nco.clear();assert.equal(old.isConnected,false)
   await update(nco,32032);query.resolve();await flush();assert.equal(engines.length,count)
   cleanup.resolve();await clearing;await flush();assert.equal(engines.length,count);assert.equal(nco.canvas.isConnected,true)
  } else {
   const dispose=nco.state.dispose.bind(nco.state);nco.state.dispose=async()=>{await cleanup.promise;await dispose()}
   const disposing=patcher.dispose();assert.equal(old.isConnected,false);query.resolve();await flush();assert.equal(engines.length,count)
   for(const [key,callback] of initialWatches) if(key==='comment:scale')callback(200)
   assert.equal(engines.length,count);cleanup.resolve();await disposing;await flush();assert.equal(canvases().length,0)
  }
 } else if(mode==='video-owner') {
  const old=nco,oldCanvas=nco.canvas,replacement=new Video();document.body.append(replacement)
  await patcher.setVideo(replacement);nco=patcher.nco;replacement.dispatchEvent(new Event('loadedmetadata'));await flush();await seed(nco.state)
  const canvas=nco.canvas,count=engines.length;old.renderer.reload();old.renderer.start();old.renderer.clear()
  assert.equal(nco.video,replacement);assert.equal(nco.canvas,canvas);assert.equal(engines.length,count)
  assert.equal(oldCanvas.isConnected,false);assert.equal(canvases().length,1)
 } else throw new Error(mode)
 await patcher.dispose();await flush();assert.equal(canvases().length,0);assert.equal(raf.size,0)
}
for(const [name,evidence] of logs) if(['nco.canvasLifecycle','nco.commentPipeline','nco.commentLoad','nco.rendererThreads'].includes(name)) {
 assert.ok(!JSON.stringify(evidence).includes('PRIVATE-'))
 for(const [key,value] of Object.entries(evidence)) if(key!=='event')assert.ok(value===null||typeof value==='boolean'||(typeof value==='number'&&Number.isFinite(value)),key)
}
console.log('renderer-pass:'+mode)
`

describe('renderer canvas lifecycle with browser boundary fixtures', () => {
  for (const mode of [
    'replace',
    'fallback',
    'raf',
    'terminal',
    'alpha',
    'capture-cleanup',
    'episode',
    'netflix',
    'timeline',
    'timeline-race',
    'clear-race',
    'dispose-race',
    'video-owner',
    'load-episode',
    'load-stale',
    'load-info-stale',
    'load-write-drain',
    'load-dispose',
    'load-video',
    'load-error',
    'load-loaded-id',
    'load-iterator',
  ]) {
    test(mode, () => {
      const result = Bun.spawnSync({
        cmd: [process.execPath, 'run', '-', mode],
        stdin: new TextEncoder().encode(probe),
        cwd: process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(new TextDecoder().decode(result.stderr)).toBe('')
      expect(result.exitCode).toBe(0)
      expect(new TextDecoder().decode(result.stdout)).toContain(
        `renderer-pass:${mode}`
      )
    })
  }
})
