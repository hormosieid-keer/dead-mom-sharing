import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createBrowserAlerts } from '../extension/browser-alerts.js';

function fixture({active=true,fail=false,existing=false,prepare}={}) {
  const state={paused:active,incident:active?{id:'incident-1'}:null};
  const calls={create:[],play:[],badge:[],title:[]};
  let hasPlayer=existing;
  const api={
    runtime:{getURL:path=>'chrome-extension://test/'+path,
      getContexts:async()=>hasPlayer?[{}]:[],
      sendMessage:async message=>{calls.play.push(message);return {ok:!fail};}},
    offscreen:{createDocument:async options=>{calls.create.push(options);hasPlayer=true;if(prepare)await prepare(state);}},
    action:{setBadgeBackgroundColor:async()=>{},setBadgeText:async value=>calls.badge.push(value.text),setTitle:async value=>calls.title.push(value.title)}
  };
  const callbacks={read:async()=>structuredClone(state),claim:async id=>{
    if(!state.paused||state.incident?.id!==id||state.browserAlert?.incidentId===id)return false;
    state.browserAlert={incidentId:id,status:'pending'};return true;
  },record:async(id,error)=>{if(state.browserAlert?.incidentId===id)Object.assign(state.browserAlert,{status:error?'blocked':'played',error});}};
  return {state,calls,api,callbacks,alerts:createBrowserAlerts(api,callbacks)};
}

test('a manual pause without an incident never plays audio or sets a warning badge',async()=>{
  const f=fixture({active:false});f.state.paused=true;
  await f.alerts.sync();assert.deepEqual(f.calls.play,[]);assert.deepEqual(f.calls.badge,['']);
});

test('a real incident plays the local sound once and sets the persistent toolbar warning',async()=>{
  const f=fixture();await f.alerts.sync();
  assert.equal(f.state.browserAlert.status,'played');assert.deepEqual(f.calls.badge,['!']);
  assert.equal(f.calls.play.length,1);assert.equal(f.calls.play[0].target,'alert-player');
  assert.deepEqual(f.calls.create[0].reasons,['AUDIO_PLAYBACK']);
});

test('polls, concurrent notifications and a worker restart do not replay one incident',async()=>{
  const f=fixture();await Promise.all([f.alerts.sync(),f.alerts.sync(),f.alerts.sync()]);
  await createBrowserAlerts(f.api,f.callbacks).sync();
  assert.equal(f.calls.play.length,1);assert.equal(f.calls.create.length,1);
});

test('a later distinct incident plays again, and a cleared incident removes the badge',async()=>{
  const f=fixture();await f.alerts.sync();
  f.state.paused=false;f.state.incident=null;await f.alerts.sync();assert.equal(f.calls.badge.at(-1),'');
  f.state.paused=true;f.state.incident={id:'incident-2'};await f.alerts.sync();assert.equal(f.calls.play.length,2);
});

test('an existing offscreen player is reused without a duplicate document',async()=>{
  const f=fixture({existing:true});await f.alerts.sync();assert.equal(f.calls.create.length,0);assert.equal(f.calls.play.length,1);
});

test('audio failure keeps the safety pause and warning but does not cause an endless retry',async()=>{
  const f=fixture({fail:true});await f.alerts.sync();await f.alerts.sync();
  assert.equal(f.state.paused,true);assert.equal(f.state.browserAlert.status,'blocked');
  assert.match(f.state.browserAlert.error,/试听提示音/u);assert.equal(f.calls.play.length,1);assert.equal(f.calls.badge.at(-1),'!');
});

test('a missing audio API still preserves a visible error and a real incident',async()=>{
  const f=fixture();delete f.api.offscreen;await f.alerts.sync();
  assert.equal(f.state.browserAlert.status,'blocked');assert.equal(f.state.incident.id,'incident-1');
});

test('an incident cleared while preparing audio is not played late',async()=>{
  const f=fixture({prepare:state=>{state.paused=false;state.incident=null;}});
  await f.alerts.sync();assert.equal(f.calls.play.length,0);
});

test('preview plays on explicit request without creating a pause, badge or email',async()=>{
  const f=fixture({active:false});assert.deepEqual(await f.alerts.preview(),{played:true});
  assert.equal(f.state.incident,null);assert.equal(f.state.browserAlert,undefined);assert.deepEqual(f.calls.badge,[]);
});

test('offscreen player accepts only own targeted messages and deduplicates successful playback',async()=>{
  const source=await readFile(new URL('../extension/alert-player.js',import.meta.url),'utf8');
  let listener,plays=0;
  class Audio {pause(){}async play(){plays++;}}
  const context=vm.createContext({Audio,chrome:{runtime:{id:'extension',getURL:path=>path,onMessage:{addListener:fn=>{listener=fn;}}}}});
  vm.runInContext(source,context);
  assert.equal(listener({target:'alert-player',type:'PLAY_ALERT',id:'i'},{id:'other'},()=>{}),false);
  assert.equal(listener({type:'START'},{id:'extension'},()=>{}),false);
  const send=id=>new Promise(resolve=>listener({target:'alert-player',type:'PLAY_ALERT',id},{id:'extension'},resolve));
  await Promise.all([send('incident'),send('incident')]);assert.equal(plays,1);
  await send('preview');assert.equal(plays,2);
});
