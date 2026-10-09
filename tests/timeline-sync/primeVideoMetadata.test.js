import { describe, expect, test } from 'bun:test'

// Isolated process: actual Prime metadata reader + Session, fake IO/timer only.
const probe = String.raw`
import assert from 'node:assert/strict'
import {mock} from 'bun:test'
const mode=process.argv.at(-1),logs=[]
mock.module('@/utils/logger',()=>({logger:{log(...args){logs.push(args)},error(){}}}))
const {PrimeVideoMetadataReader,PRIME_METADATA_ATTEMPTS}=await import('./src/timeline-sync/providers/primeVideoMetadata.ts')
const {PrimeVideoTimelineSession}=await import('./src/timeline-sync/providers/primeVideoSession.ts')
let context='PRIVATE-CONTEXT-A',owner=true,reads=0,waits=0,parsed=0,metadataOwner=true
const callbacks=new Map(),state={async get(){return null},async set(){},onChange(){return()=>{}}}
const nco={state,video:{duration:1425,currentTime:0,addEventListener(type,fn){callbacks.set(type,fn)},removeEventListener(type){callbacks.delete(type)}},async clear(){},async dispose(){}}
const session=new PrimeVideoTimelineSession(nco,()=>owner,()=>context)
const request={isOwnerCurrent:()=>metadataOwner}
const packet=(id='A')=>({id:'PRIVATE-ID-'+id,playbackUrls:{fullTitleDurationMs:1425000},catalog:{type:'EPISODE',seriesTitle:'PRIVATE-SERIES',title:'PRIVATE-TITLE',seasonNumber:1,episodeNumber:id==='A'?1:2}})
const parse=info=>{parsed++;if(mode==='parse'&&parsed===1)throw new Error('PRIVATE-PARSE-ERROR');return {input:'Fixture '+info.catalog.episodeNumber,duration:1425}}
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}}
let late,reader
const read=async()=>{
 reads++
 if(mode==='movie')return {...packet(),catalog:{type:'MOVIE',title:'PRIVATE-MOVIE',seasonNumber:-1,episodeNumber:-1}}
 if(mode==='missing'&&reads===1)return null
 if(mode==='transport'&&reads===1)throw new Error('PRIVATE-URL-AND-ERROR')
 if(mode==='incomplete'&&reads===1)return {id:'PRIVATE-ID',catalog:{seriesTitle:'PRIVATE-TITLE'}}
 if(mode==='invalid'&&reads===1)return {...packet(),playbackUrls:{fullTitleDurationMs:NaN}}
 if(mode==='exhausted')return {...packet(),catalog:{...packet().catalog,episodeNumber:'PRIVATE-BAD-NUMBER'}}
 if(mode==='timeout'&&reads===1){late=deferred();return late.promise}
 if(mode==='source-stale'&&context==='PRIVATE-CONTEXT-B'&&reads===2)return packet('A')
 if(mode==='cancel-message'){metadataOwner=false;return packet()}
 if(mode==='clear-message'){await nco.clear();return packet()}
 if(mode==='dispose-message'){await nco.dispose();return packet()}
 return packet(context==='PRIVATE-CONTEXT-A'?'A':'B')
}
const wait=async()=>{
 waits++
 if(mode==='cancel-wait')metadataOwner=false
 if(mode==='context-race'&&waits===1){context='PRIVATE-CONTEXT-B';session.checkContext()}
 if(mode==='context-no-observer'&&waits===1)context='PRIVATE-CONTEXT-B'
 if(mode==='settle'&&waits===1)throw new Error('PRIVATE-SETTLE-ERROR')
}
reader=new PrimeVideoMetadataReader(()=>context,read,wait,5)
if(mode==='pause'){const pause=session.pause.bind(session);let fail=true;session.pause=(...args)=>{if(fail){fail=false;throw new Error('PRIVATE-PAUSE-ERROR')}return pause(...args)}}
if(mode==='source-stale'){await reader.load(session,request,parse);context='PRIVATE-CONTEXT-B';session.checkContext()}
if(mode==='owner'){owner=false}
const fails=['exhausted','cancel-wait','cancel-message','clear-message','dispose-message','owner'].includes(mode)
let result,error
try{result=await reader.load(session,request,parse)}catch(e){error=e}
if(fails){assert.ok(error);assert.equal(request.failureLogged,true);assert.equal(request.isCurrent(),false)}
else{assert.ok(!error,error?.message);assert.equal(request.isCurrent(),true);assert.ok(result.input.startsWith('Fixture'))}
const diagnostics=logs.filter(([event])=>event==='primeVideo.getInfo').map(([,data])=>data)
const last=diagnostics.at(-1)
if(mode==='exhausted'){assert.equal(reads,PRIME_METADATA_ATTEMPTS);assert.equal(parsed,0);assert.equal(last.stage,'exhausted');assert.equal(last.failure,'metadata-invalid')}
else if(fails){assert.equal(last.stage,'cancelled');assert.equal(last.failure,'owner-changed');assert.ok(reads<=1)}
else{assert.equal(last.stage,'accepted');assert.equal(parsed,mode==='source-stale'||mode==='parse'?2:1)}
if(['context-race','context-no-observer'].includes(mode)){assert.equal(result.input,'Fixture 2');assert.equal(parsed,1);assert.ok(diagnostics.some(d=>d.stage==='retry'&&d.failure==='context-changed'))}
if(mode==='source-stale'){assert.equal(result.input,'Fixture 2');assert.equal(reads,3);assert.ok(diagnostics.some(d=>d.failure==='source-not-advanced'))}
if(mode==='timeout'){assert.equal(reads,2);late.resolve(packet());await Promise.resolve();assert.equal(parsed,1);assert.ok(diagnostics.some(d=>d.failure==='message-timeout'))}
for(const data of diagnostics){assert.ok(!JSON.stringify(data).includes('PRIVATE-'));for(const [key,value] of Object.entries(data))if(!['stage','failure'].includes(key))assert.ok(typeof value==='boolean'||Number.isFinite(value),key)}
console.log('metadata-pass:'+mode)
`

describe('Prime metadata classifications and bounded recovery', () => {
  for (const mode of [
    'valid',
    'movie',
    'context-race',
    'context-no-observer',
    'missing',
    'incomplete',
    'invalid',
    'transport',
    'timeout',
    'parse',
    'pause',
    'settle',
    'source-stale',
    'exhausted',
    'cancel-wait',
    'cancel-message',
    'clear-message',
    'dispose-message',
    'owner',
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
        'metadata-pass:' + mode
      )
    })
  }
})
