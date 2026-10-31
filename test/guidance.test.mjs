import { test } from 'node:test';
import assert from 'node:assert/strict';
import { derive, deriveAccount, forecastSummary } from '../public/guidance.js';
import { stateOf, toSlopAccount } from '../src/snapshot.mjs';
import { recentRate, completedWindows, weeklyOutlook } from '../src/history.mjs';
const now = Date.parse('2026-10-31T12:00:00Z'), H=3600000;
const w=(kind,used,h,extra={})=>({kind,label:kind,scope:'all',usedPct:used,active:true,resetsAt:new Date(now+h*H).toISOString(),observedAt:now,...extra});
const a=(windows,extra={})=>({id:'a',provider:'claude',label:'personal',observedAt:now,windows,...extra});
const vm=(accounts,options={})=>derive({now:new Date(now).toISOString(),accounts},options);
const recent={confidence:'observed',samples:20,spanMinutes:60,low:20,high:40};

const scenarios=[
 ['plenty left after a burst',a([w('session',20,4,{rate:recent}),w('weekly',15,120,{rate:recent})]),'available',true],
 ['fresh week with a burst',a([w('weekly',5,160,{rate:recent})]),'available',true],
 ['capacity expires soon',a([w('session',20,.5),w('weekly',40,100)]),'expiring',true],
 ['weekly expires soon',a([w('session',20,3),w('weekly',40,6)]),'expiring',true],
 ['almost used up before reset',a([w('session',98,.1),w('weekly',20,100)]),'limited',true],
 ['near cap with hours to reset',a([w('session',95,4),w('weekly',20,100)]),'limited',true],
 ['weekly used up',a([w('session',10,4),w('weekly',100,100)]),'blocked',false],
 ['short window used up',a([w('session',100,1),w('weekly',20,100)]),'blocked',false],
 ['both used up',a([w('session',100,1),w('weekly',100,72)]),'blocked',false],
 ['weekly opportunity blocked by short cap',a([w('session',100,4),w('weekly',30,1)]),'blocked',false],
 ['idle window',a([w('session',0,0,{active:false,resetsAt:null}),w('weekly',40,100)]),'ready',true],
 ['idle but weekly nearly full',a([w('session',0,0,{active:false,resetsAt:null}),w('weekly',98,100)]),'limited',true],
 ['weekly-only plan',a([w('weekly',40,100)]),'available',true],
 ['session-only plan',a([w('session',40,3)]),'available',true],
 ['missing usage',a([w('weekly',null,100)]),'unknown',false],
 ['missing reset but known capacity',a([w('weekly',30,100,{resetsAt:null})]),'available',true],
 ['missing reset and capped',a([w('weekly',100,100,{resetsAt:null})]),'blocked',false],
 ['reset passed',a([w('session',100,-.1),w('weekly',20,100)]),'checking',false],
 ['stale readings',a([w('weekly',20,100)],{stale:true}),'stale',false],
 ['old successful readings',a([w('weekly',20,100,{observedAt:now-6*60000})]),'stale',false],
 ['future timestamp',a([w('weekly',20,100,{observedAt:now+H})]),'stale',false],
 ['expired login',a([w('weekly',20,100)],{error:'Token expired'}),'unknown',false],
 ['model cap with general capacity',a([w('weekly',20,100),w('weekly_opus',100,2,{scope:'opus'})]),'restricted',false],
 ['provider reports limit despite percentages',a([w('weekly',20,100)],{limitReached:true}),'blocked',false],
 ['missing all windows',a([]),'unknown',false],
];
for(const [name,acct,status,recommended] of scenarios) test(name,()=>{
 const result=vm([acct]);
 assert.equal(result.accounts[0].status,status);
 assert.equal(!!result.next,recommended);
 if (result.verdict.word === 'Speed up.') assert.ok(['expiring', 'underused'].includes(result.next.status));
 if (result.verdict.word === 'Slow down.') assert.equal(result.next.status, 'limited');
 assert.ok(!JSON.stringify(result).includes('NaN'));
});
test('all capped accounts never get a work recommendation',()=>{
 const result=vm([a([w('session',100,2),w('weekly',10,100)]),a([w('session',100,1),w('weekly',10,100)],{id:'b'})]);
 assert.equal(result.next,null); assert.equal(result.verdict.word,'Cooldown.');
});
test('recovery waits for every blocking limit, then selects earliest recoverable account',()=>{
 const both=a([w('session',100,1),w('weekly',100,72)]);
 assert.equal(vm([both]).accounts[0].recoveryAt,new Date(now+72*H).toISOString());
 const other=a([w('session',100,2),w('weekly',10,100)],{id:'b'});
 assert.match(vm([both,other]).verdict.why,/2026-10-31T14:00/);
});
test('unknown recovery is never invented and no NaN is scored',()=>{
 const result=vm([a([w('weekly',100,2,{resetsAt:null})])]);
 assert.equal(result.accounts[0].recoveryAt,null);
 assert.match(result.verdict.why,/unknown/); assert.equal('score' in result,false);
});
test('model restrictions apply only to the selected model; provider filters are respected',()=>{
 const acct=a([w('weekly',20,100),w('weekly_opus',100,2,{scope:'opus'})]);
 assert.equal(vm([acct],{model:'opus'}).next,null);
 assert.equal(vm([acct],{model:'sonnet'}).next.id,'a');
 assert.equal(vm([acct],{provider:'codex'}).next,null);
 const codex=a([w('weekly',20,100)],{provider:'codex'});
 assert.equal(vm([codex],{model:'opus'}).next,null);
});
test('meaningful expiring capacity beats a later reset; tiny headroom does not',()=>{
 const later=a([w('weekly',20,100)]);
 const soon=a([w('weekly',40,2)],{id:'b'});
 const tiny=a([w('weekly',99,.1)],{id:'c'});
 assert.equal(vm([later,soon,tiny]).next.id,'b');
});
test('routing is deterministic and modest score changes retain the prior account',()=>{
 const first=a([w('weekly',40,100)]),second=a([w('weekly',35,100)],{id:'b'});
 assert.equal(vm([first,second],{previousId:'a'}).next.id,'a');
 assert.equal(vm([second,first]).next.id,vm([first,second]).next.id);
 assert.equal(vm([a([w('weekly',100,100)]),second],{previousId:'a'}).next.id,'b');
});
test('forecast is conditional and never disqualifies ample capacity',()=>{
 const result=vm([a([w('session',50,4,{rate:recent})])]).accounts[0];
 assert.equal(result.status,'available');
 assert.deepEqual(result.windows[0].capRange,[75,150].every(x=>x<=120)?[75,150]:null);
 const fast=deriveAccount(a([w('session',50,4,{rate:{...recent,low:40,high:60}})]),now);
 assert.ok(fast.windows[0].capRange); assert.match(forecastSummary(fast.windows[0]),/if your recent pace continues/);
});
test('reset transition requires fresh confirmation before recommendation',()=>{
 const acct=a([w('session',100,.01)]);
 assert.equal(deriveAccount(acct,now+60000).status,'checking');
 const refreshed=a([w('session',0,5,{observedAt:now+60000})],{observedAt:now+60000});
 assert.equal(deriveAccount(refreshed,now+60000).status,'available');
});
test('all combinations of basic account states obey routing and headline invariants',()=>{
 for(const [,left] of scenarios) for(const [,right] of scenarios){
   const result=vm([left,{...right,id:'b'}]);
   if(result.next){assert.ok(result.next.usable);assert.ok(result.next.fresh);assert.ok(result.next.headroom>0);assert.notEqual(result.next.status,'restricted');assert.ok(['Speed up.', 'Slow down.', 'Keep cooking.'].includes(result.verdict.word));}
   else assert.ok(!['Speed up.', 'Slow down.', 'Keep cooking.'].includes(result.verdict.word));
   assert.equal('bankedPts' in result,false);
 }
});
const samples=(usedPerMinute=0.1)=>Array.from({length:31},(_,i)=>({id:'a',kind:'weekly',resetsAt:now+H,t:now-H+i*2*60000,used:i*2*usedPerMinute}));
test('recent rate includes the current reading and needs real coverage',()=>{
 const rows=samples(); const raw={kind:'weekly',resetsAt:now+H};
 const rate=recentRate(rows,'a',raw,now);
 assert.equal(rate.confidence,'observed'); assert.ok(Math.abs(rate.perHour-6)<.001);
 assert.equal(recentRate(rows.slice(-4),'a',raw,now).confidence,'learning');
 assert.equal(recentRate(rows.slice(0,10).concat(rows.slice(-3)),'a',raw,now).confidence,'learning');
 assert.equal(recentRate(rows,'a',{...raw,resetsAt:now+2*H},now).confidence,'learning');
});
test('counter drops invalidate rates and quiet observations do not sustain past bursts forever',()=>{
 const raw={kind:'weekly',resetsAt:now+H},rows=samples();
 rows[20].used=0;
 assert.equal(recentRate(rows,'a',raw,now).confidence,'learning');
 const quiet=samples(0);
 assert.equal(recentRate(quiet,'a',raw,now).perHour,0);
});
test('completed windows report lower bounds and gaps, never invented exact usage',()=>{
 const rows=[{id:'a',kind:'weekly',t:now-H,resetsAt:now,used:94},{id:'a',kind:'weekly',t:now+60000,resetsAt:now+168*H,used:2}];
 const done=completedWindows(rows,'a',now+60000);
 assert.equal(done[0].usedAtLeast,94);assert.equal(done[0].unusedAtMost,6);assert.equal(done[0].nearReset,false);
 assert.equal(completedWindows(rows.slice(0,1),'a',now+60000).length,0);
});
test('weekly forecast never treats offline time as zero usage',()=>{
 assert.equal(weeklyOutlook(samples(),'a',{kind:'weekly',usedPercent:20,resetsAt:now+168*H},now).confidence,'learning');
});
test('availability intervals exclude gaps and reset crossings',()=>{
 const accounts=[a([w('weekly',100,10)]),a([w('weekly',20,10)],{id:'b'})];
 const first=vm(accounts), prev=stateOf(first,new Date(now).toISOString());
 const next=stateOf(first,new Date(now+2*60000).toISOString(),prev);
 assert.equal(next.opportunityMinutes,2);
 assert.equal(stateOf(first,new Date(now+H).toISOString(),prev).opportunityMinutes,0);
});
test('adapter preserves durations, model windows, observation age and missing usage',()=>{
 const raw={id:'a',provider:'claude',observedAt:now-10*60000,windows:[{kind:'session',windowSeconds:7200,usedPercent:null,resetsAt:now+H},{kind:'weekly_opus',usedPercent:100,resetsAt:now+H}]};
 const normalized=toSlopAccount(raw,now);
 assert.equal(normalized.windows[0].durationMin,120);assert.equal(normalized.windows[0].usedPct,null);
 assert.equal(normalized.windows[1].scope,'opus');assert.equal(normalized.observedAt,new Date(now-10*60000).toISOString());
});


test('model restrictions still require selection when general headroom is low',()=>{
 const acct=a([w('weekly',95,100),w('weekly_opus',100,2,{scope:'opus'})]);
 assert.equal(vm([acct]).next,null);
 assert.equal(vm([acct]).accounts[0].status,'restricted');
 assert.equal(vm([acct],{model:'sonnet'}).next.status,'limited');
});
test('early changes of reset identity are not reported as completed windows',()=>{
 const rows=[{id:'a',kind:'weekly',t:now-H,resetsAt:now,used:94},
 {id:'a',kind:'weekly',t:now-60000,resetsAt:now+168*H,used:2},
 {id:'a',kind:'weekly',t:now+60000,resetsAt:now+168*H,used:3}];
 assert.deepEqual(completedWindows(rows,'a',now+60000),[]);
});
test('weekly outlook requires five well-covered days and remains contextual',()=>{
 const midnight=Math.floor(now/(24*H))*24*H, rows=[];
 for(let day=1;day<=5;day++) for(let minute=0;minute<=23*60;minute+=10)
   rows.push({id:'a',kind:'weekly',t:midnight-day*24*H+minute*60000,resetsAt:now+168*H,used:(5-day)*10+minute/138});
 const raw={kind:'weekly',usedPercent:60,resetsAt:now+48*H};
 const outlook=weeklyOutlook(rows,'a',raw,now);
 assert.equal(outlook.confidence,'limited'); assert.equal(outlook.days,5);
 assert.equal(outlook.low,80); assert.equal(outlook.high,80);
 assert.equal(weeklyOutlook(rows.filter(s=>s.t>=midnight-4*24*H),'a',raw,now).confidence,'learning');
 assert.equal(vm([a([w('weekly',60,48,{outlook})])]).next.status,'available');
});


test('direction reflects the recommended account, never an average across accounts',()=>{
 const healthy=a([w('weekly',40,100)]);
 const low=a([w('weekly',95,100)],{id:'b'});
 assert.equal(vm([healthy,low]).verdict.word,'Keep cooking.');
 assert.equal(vm([low]).verdict.arrow,'▼');
 assert.equal(vm([a([w('weekly',30,2)])]).verdict.arrow,'▲▲');
 assert.notEqual(vm([a([w('weekly',20,100)],{stale:true})]).verdict.arrow,'▲');
});


test('real allowance examples speed up before the final reset countdown',()=>{
 const claude=a([w('session',9,1.1),w('weekly',27,39.5)]);
 const codex=a([w('weekly',8,84.5)],{id:'b',provider:'codex'});
 for(const acct of [claude,codex]) { const result=vm([acct]); assert.equal(result.next.status,'underused'); assert.equal(result.verdict.arrow,'▲'); assert.match(result.verdict.why,/only .*% of its window is left/); }
 assert.equal(vm([claude,codex]).next.id,'a');
 assert.equal(vm([{...claude,stale:true},codex]).next.id,'b');
 assert.equal(vm([a([w('session',9,.99)])]).verdict.arrow,'▲▲');
});
test('calendar nudges require a meaningful gap and honor actual window duration',()=>{
 assert.equal(vm([a([w('session',30,2.5)])]).next.status,'underused'); // 70% allowance vs 50% time
 assert.equal(vm([a([w('session',30.1,2.5)])]).next.status,'available');
 assert.equal(vm([a([w('session',0,5)])]).next.status,'available');
 assert.equal(vm([a([w('session',20,2,{durationMin:120})])]).next.status,'available');
 assert.equal(vm([a([w('session',20,2)])]).next.status,'underused');
 assert.equal(vm([a([w('session',0,0,{active:false,resetsAt:null})])]).next.status,'ready');
 assert.equal(vm([a([w('weekly',20,100,{resetsAt:null})])]).next.status,'available');
 assert.equal(vm([a([w('session',9,1.1),w('weekly',95,100)])]).next.status,'limited');
 assert.equal(vm([a([w('session',9,1.1),w('weekly',100,100)])]).next,null);
});
