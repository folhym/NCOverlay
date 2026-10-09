import { expect, test } from 'bun:test'

// Actual CustomEvent transport: cancelling one request must not remove another
// request's response listener or the shared page receiver.
test('scoped Prime page request releases only its own transport listeners', () => {
  const probe = String.raw`
import assert from 'node:assert/strict'
import {mock} from 'bun:test'
mock.module('@/utils/logger',()=>({logger:{log(){},error(){}}}))
globalThis.EXT_BUILD_ID='fixture'
globalThis.window=new EventTarget()
const listeners=new Set(),add=window.addEventListener.bind(window),remove=window.removeEventListener.bind(window)
window.addEventListener=(type,fn,...args)=>{if(type.includes('response'))listeners.add(fn);return add(type,fn,...args)}
window.removeEventListener=(type,fn,...args)=>{listeners.delete(fn);return remove(type,fn,...args)}
const {sendPageMessage,onPageMessage}=await import('./src/messaging/page.ts')
const {defineCustomEventMessaging}=await import('@webext-core/messaging/page')
const server=defineCustomEventMessaging({namespace:'fixture:page'}),replies=[]
server.onMessage('page:primeVideo:getPlaybackInfo',()=>new Promise(resolve=>replies.push(resolve)))
const stopped=new AbortController();stopped.abort()
assert.equal(await sendPageMessage('page:primeVideo:getPlaybackInfo',null,stopped.signal).catch(e=>e.name),'AbortError')
assert.equal(listeners.size,0);assert.equal(replies.length,0)
const first=new AbortController(),second=new AbortController()
const a=sendPageMessage('page:primeVideo:getPlaybackInfo',null,first.signal).catch(error=>error.name)
const b=sendPageMessage('page:primeVideo:getPlaybackInfo',null,second.signal)
for(let i=0;i<15;i++)await Promise.resolve()
assert.equal(listeners.size,2);first.abort();assert.equal(await a,'AbortError');assert.equal(listeners.size,1)
replies[0]({id:'OLD'});replies[1]({id:'NEW'});assert.deepEqual(await b,{id:'NEW'});assert.equal(listeners.size,0)
const c=sendPageMessage('page:primeVideo:getPlaybackInfo',null)
for(let i=0;i<15;i++)await Promise.resolve()
assert.equal(listeners.size,1);replies[2]({id:'SHARED'});assert.deepEqual(await c,{id:'SHARED'});assert.equal(listeners.size,0)
const {PrimeVideoMetadataReader}=await import('./src/timeline-sync/providers/primeVideoMetadata.ts')
let version=0,parsed=0
const session={metadataGeneration:0,get version(){return version},isMetadataOwner(){return true},isCurrent(v){return v===version},async pause(){version++}}
const reader=new PrimeVideoMetadataReader(()=>null,signal=>sendPageMessage('page:primeVideo:getPlaybackInfo',null,signal),async()=>{},5),request={}
await assert.rejects(reader.load(session,request,()=>{parsed++;return {input:'fixture',duration:1425}}))
assert.equal(replies.length,6);assert.equal(listeners.size,0);assert.equal(parsed,0)
for(const reply of replies.slice(3))reply({id:'LATE'})
for(let i=0;i<15;i++)await Promise.resolve()
assert.equal(listeners.size,0);assert.equal(parsed,0)
server.removeAllListeners();console.log('scoped-page-pass')
`
  const result = Bun.spawnSync({
    cmd: [process.execPath, 'run', '-'],
    stdin: new TextEncoder().encode(probe),
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(new TextDecoder().decode(result.stderr)).toBe('')
  expect(result.exitCode).toBe(0)
  expect(new TextDecoder().decode(result.stdout)).toContain('scoped-page-pass')
})
