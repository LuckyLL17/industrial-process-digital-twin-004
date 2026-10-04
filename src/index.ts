import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';

type Telemetry = { time:string; assetId:string; values:Record<string,number>; quality:'good'|'suspect'|'bad' };
type Asset = { id:string; name:string; type:string; parentId?:string; limits:Record<string,{min:number;max:number}>; state:'running'|'degraded'|'stopped'; last:Record<string,number> };
type Anomaly = { id:string; time:string; assetId:string; variable:string; value:number; score:number; severity:'low'|'medium'|'high'; status:'open'|'investigating'|'resolved'; causes:string[] };
const app=Fastify({logger:true});
const now=()=>new Date().toISOString();
const assets:Asset[]=[
 {id:'reactor-01',name:'连续反应器 R-01',type:'reactor',limits:{temperature:{min:68,max:82},pressure:{min:2.2,max:3.2},flow:{min:90,max:120}},state:'running',last:{temperature:75,pressure:2.7,flow:108,vibration:1.2}},
 {id:'pump-01',name:'进料泵 P-01',type:'pump',parentId:'reactor-01',limits:{pressure:{min:1.8,max:3.6},flow:{min:90,max:125},vibration:{min:0,max:3}},state:'running',last:{pressure:2.8,flow:108,vibration:1.2}},
 {id:'heater-01',name:'预热器 H-01',type:'heater',parentId:'reactor-01',limits:{temperature:{min:120,max:180},power:{min:20,max:90}},state:'running',last:{temperature:145,power:54}}
];
const telemetry:Telemetry[]=[]; const anomalies:Anomaly[]=[]; const investigations:any[]=[]; const scenarios:any[]=[]; const workOrders:any[]=[]; const audit:any[]=[];
const causalEdges=[
 {from:'pump-01',to:'reactor-01',relation:'feeds'}, {from:'heater-01',to:'reactor-01',relation:'conditions'},
 {from:'low-flow',to:'temperature-drift',relation:'causes',weight:.71}, {from:'high-vibration',to:'low-flow',relation:'causes',weight:.64},
 {from:'valve-stiction',to:'low-flow',relation:'causes',weight:.52}
];
function log(action:string,entity:string,payload:any){audit.push({id:randomUUID(),time:now(),action,entity,payload});}
function detect(t:Telemetry){ for(const [variable,value] of Object.entries(t.values)){const asset=assets.find(a=>a.id===t.assetId); const lim=asset?.limits[variable]; if(!lim) continue; const span=lim.max-lim.min; const distance=value<lim.min?lim.min-value:value>lim.max?value-lim.max:0; if(distance>0){const score=Math.min(1,.45+distance/(span||1)); const a:Anomaly={id:randomUUID(),time:t.time,assetId:t.assetId,variable,value,score,severity:score>.8?'high':score>.6?'medium':'low',status:'open',causes:variable==='flow'?['high-vibration','valve-stiction']:['low-flow','sensor-bias']}; anomalies.push(a); const target=assets.find(x=>x.id===t.assetId); if(target) target.state=a.severity==='high'?'degraded':target.state; }} }
for(const asset of assets) telemetry.push({time:now(),assetId:asset.id,values:asset.last,quality:'good'});
app.get('/health',async()=>({ok:true,service:'industrial-process-digital-twin',time:now()}));
app.get('/api/twin/state',async()=>({at:now(),assets,openAnomalies:anomalies.filter(a=>a.status!=='resolved'),process:{throughput:108.4,energy:54.2,quality:97.8},causalEdges}));
app.post('/api/telemetry/ingest',async(req:any,res)=>{const body=req.body as Partial<Telemetry>; if(!body.assetId||!body.values) return res.code(400).send({error:'assetId 和 values 必填'}); const item:Telemetry={time:body.time||now(),assetId:body.assetId,values:body.values,quality:body.quality||'good'}; telemetry.push(item); const asset=assets.find(a=>a.id===item.assetId); if(!asset) return res.code(404).send({error:'asset not found'}); asset.last={...asset.last,...item.values}; detect(item); log('telemetry.ingest',item.assetId,item); return {accepted:true,anomalies:anomalies.filter(a=>a.time===item.time&&a.assetId===item.assetId)};});
app.get('/api/telemetry/replay',async(req:any)=>{const q=req.query as any; const from=Number(q.from||0), to=Number(q.to||Date.now()); return {items:telemetry.filter(t=>{const x=Date.parse(t.time);return x>=from&&x<=to}),cursor:{from,to,next:to+1}};});
app.get('/api/anomalies',async(req:any)=>{const q=req.query as any; return anomalies.filter(a=>(!q.status||a.status===q.status)&&(!q.severity||a.severity===q.severity));});
app.post('/api/anomalies/:id/investigate',async(req:any,res)=>{const a=anomalies.find(x=>x.id===(req.params as any).id); if(!a)return res.code(404).send({error:'anomaly not found'}); a.status='investigating'; const inv={id:randomUUID(),anomalyId:a.id,createdAt:now(),hypotheses:a.causes.map((cause,i)=>({id:randomUUID(),cause,prior:.6-i*.12,evidence:[],status:'open'})),tests:[],status:'open'}; investigations.push(inv); log('investigation.create',inv.id,inv); return inv;});
app.post('/api/investigations/:id/evidence',async(req:any,res)=>{const inv=investigations.find(x=>x.id===(req.params as any).id); if(!inv)return res.code(404).send({error:'investigation not found'}); const b=req.body as any; if(!b.hypothesisId||!b.observation)return res.code(400).send({error:'hypothesisId 和 observation 必填'}); const h=inv.hypotheses.find((x:any)=>x.id===b.hypothesisId); if(!h)return res.code(404).send({error:'hypothesis not found'}); h.evidence.push({id:randomUUID(),observation:b.observation,likelihood:Number(b.likelihood??.5),time:now()}); h.posterior=Number((h.prior*Number(b.likelihood??.5)).toFixed(4)); if(b.supports===false) h.posterior=0; inv.hypotheses.sort((x:any,y:any)=>(y.posterior??y.prior)-(x.posterior??x.prior)); log('investigation.evidence',inv.id,b); return inv;});
app.post('/api/scenarios',async(req:any,res)=>{const b=req.body as any; if(!b.name||!b.overrides)return res.code(400).send({error:'name 和 overrides 必填'}); const s={id:randomUUID(),name:b.name,baseAt:now(),overrides:b.overrides,status:'draft',result:null}; scenarios.push(s); return s;});
app.post('/api/scenarios/:id/run',async(req:any,res)=>{const s=scenarios.find(x=>x.id===(req.params as any).id); if(!s)return res.code(404).send({error:'scenario not found'}); const ov=s.overrides as Record<string,number>; const flow=Number(ov.flow??108), temp=Number(ov.temperature??75), pressure=Number(ov.pressure??2.7), vibration=Number(ov.vibration??1.2); const quality=Math.max(0,Math.min(100,99.4-Math.abs(flow-108)*.08-Math.abs(temp-75)*.11-Math.max(0,vibration-1.5)*2)); s.status='simulated'; s.result={throughput:flow*.996,quality:Number(quality.toFixed(2)),energy:Number((54+Math.abs(temp-75)*.5+pressure*1.2).toFixed(2)),risk:{thermal:temp>82?.82:.12,hydraulic:flow<90?.9:.18,mechanical:vibration>3?.88:.1},constraintViolations:[...(temp<68||temp>82?['reactor.temperature']:[]),...(flow<90||flow>120?['reactor.flow']:[])]}; log('scenario.run',s.id,s.result); return s;});
app.get('/api/causal-graph/:id',async(req:any)=>({rootId:(req.params as any).id,nodes:[...new Set(causalEdges.flatMap(e=>[e.from,e.to]))].map(id=>({id,label:id})),edges:causalEdges}));
app.post('/api/work-orders',async(req:any,res)=>{const b=req.body as any; if(!b.assetId||!b.reason)return res.code(400).send({error:'assetId 和 reason 必填'}); const w={id:randomUUID(),assetId:b.assetId,reason:b.reason,priority:b.priority||'medium',status:'planned',createdAt:now(),requiredSkills:b.requiredSkills||[],lockoutRequired:Boolean(b.lockoutRequired)}; workOrders.push(w); log('work-order.create',w.id,w); return w;});
app.post('/api/anomalies/:id/resolve',async(req:any,res)=>{const a=anomalies.find(x=>x.id===(req.params as any).id);if(!a)return res.code(404).send({error:'anomaly not found'}); const b=req.body as any;if(!b.evidence)return res.code(400).send({error:'resolution evidence required'});a.status='resolved';log('anomaly.resolve',a.id,b);return a;});
app.get('/api/audit',async()=>audit.slice(-100));

// Advanced operations: recipe governance, closed-loop control, maintenance windows and safety gates.
const recipes:any[]=[{id:'recipe-r1-v3',assetId:'reactor-01',version:3,status:'approved',parameters:{temperature:75,pressure:2.7,flow:108},approvedBy:'process-engineering',approvedAt:now(),supersedes:'recipe-r1-v2'}];
const controlCommands:any[]=[]; const maintenanceWindows:any[]=[]; const changeRequests:any[]=[];
function recipeRisk(parameters:Record<string,number>){const violations:string[]=[];const r=assets.find(x=>x.id==='reactor-01')!;for(const k of ['temperature','pressure','flow']){const lim=r.limits[k];if(parameters[k]!=null&&(parameters[k]<lim.min||parameters[k]>lim.max))violations.push(`${k} outside operating envelope`)}const coupling=Math.abs((parameters.flow??108)-108)*.012+Math.abs((parameters.temperature??75)-75)*.018;return{violations,riskScore:Number(Math.min(1,coupling+(parameters.pressure??2.7)>3.1?.18:0).toFixed(3))};}
app.get('/api/recipes',async()=>recipes);
app.post('/api/recipes',async(req:any,res)=>{const b=req.body as any;if(!b.assetId||!b.parameters)return res.code(400).send({error:'assetId 和 parameters 必填'});const previous=recipes.filter(x=>x.assetId===b.assetId).sort((a,b)=>b.version-a.version)[0];const risk=recipeRisk(b.parameters);const r={id:randomUUID(),assetId:b.assetId,version:(previous?.version||0)+1,status:risk.violations.length?'rejected':'pending-approval',parameters:b.parameters,risk,createdAt:now(),supersedes:previous?.id||null};recipes.push(r);log('recipe.create',r.id,r);return r;});
app.post('/api/recipes/:id/approve',async(req:any,res)=>{const r=recipes.find(x=>x.id===(req.params as any).id);if(!r)return res.code(404).send({error:'recipe not found'});if(r.risk.violations.length)return res.code(409).send({error:'recipe violates operating envelope',violations:r.risk.violations});r.status='approved';r.approvedBy=(req.body as any)?.approvedBy||'shift-supervisor';r.approvedAt=now();log('recipe.approve',r.id,r);return r;});
app.post('/api/recipes/:id/what-if',async(req:any,res)=>{const r=recipes.find(x=>x.id===(req.params as any).id);if(!r)return res.code(404).send({error:'recipe not found'});const params={...r.parameters,...((req.body as any)?.overrides||{})};const risk=recipeRisk(params);return{recipeId:r.id,units:{temperature:'°C',pressure:'bar',flow:'m3/h'},parameters:params,risk,estimated:{throughput:Number((params.flow*.996).toFixed(2)),quality:Number(Math.max(0,99.2-risk.riskScore*28).toFixed(2)),energy:Number((54+Math.abs(params.temperature-75)*.5+params.pressure*1.2).toFixed(2))}};});
app.post('/api/control/commands',async(req:any,res)=>{const b=req.body as any;if(!b.assetId||!b.parameters)return res.code(400).send({error:'assetId 和 parameters 必填'});const idemKey=b.idempotencyKey?String(b.idempotencyKey):null;if(idemKey){const dup=controlCommands.find(x=>x.idempotencyKey===idemKey);if(dup){if(dup.assetId!==b.assetId||JSON.stringify(dup.parameters)!==JSON.stringify(b.parameters))return res.code(409).send({error:'idempotencyKey reused with different payload'});const dupEntry=controlLedger.find(x=>x.commandId===dup.id);return{...dup,execution:dupEntry?executionView(dupEntry):null,idempotentReplay:true};}}const risk=recipeRisk(b.parameters);if(risk.violations.length)return res.code(409).send({error:'command rejected by operating envelope',violations:risk.violations});const activeHigh=anomalies.some(a=>a.status!=='resolved'&&a.severity==='high'&&a.assetId===b.assetId);if(activeHigh&&!b.overrideReason)return res.code(409).send({error:'high severity anomaly requires overrideReason'});const ttl=Number(b.ttlSeconds||60);const c={id:randomUUID(),assetId:b.assetId,parameters:b.parameters,mode:b.mode||'supervised',status:'accepted',risk,issuedAt:now(),expiresAt:new Date(Date.now()+ttl*1000).toISOString(),...(idemKey?{idempotencyKey:idemKey}:{})};controlCommands.push(c);const entry=createLedger(c,ttl,risk,activeHigh,b.overrideReason??null);log('control-command.accept',c.id,c);return{...c,execution:executionView(entry)};});
app.post('/api/maintenance/windows',async(req:any,res)=>{const b=req.body as any;if(!b.assetId||!b.start||!b.end)return res.code(400).send({error:'assetId、start、end 必填'});const window={id:randomUUID(),assetId:b.assetId,start:b.start,end:b.end,requiredLockout:Boolean(b.requiredLockout??true),checks:{downstreamImpact:Boolean(b.downstreamImpact),sparesReady:Boolean(b.sparesReady)},status:'planned'};maintenanceWindows.push(window);return window;});
app.post('/api/maintenance/:id/execute',async(req:any,res)=>{const w=maintenanceWindows.find(x=>x.id===(req.params as any).id);if(!w)return res.code(404).send({error:'maintenance window not found'});if(!w.checks.sparesReady)return res.code(409).send({error:'spares readiness check failed'});if(w.requiredLockout&&!(req.body as any)?.lockoutConfirmed)return res.code(409).send({error:'lockout confirmation required'});const a=assets.find(x=>x.id===w.assetId);if(a)a.state='stopped';w.status='executing';w.executedAt=now();log('maintenance.execute',w.id,w);return w;});
app.get('/api/process/health-score',async()=>{const degraded=assets.filter(a=>a.state!=='running').length;const high=anomalies.filter(a=>a.status!=='resolved'&&a.severity==='high').length;const stale=telemetry.filter(t=>Date.now()-Date.parse(t.time)>15*60*1000).length;return{score:Number(Math.max(0,100-degraded*18-high*25-stale*2).toFixed(1)),components:{assetAvailability:assets.length?1-degraded/assets.length:1,criticalAnomalies:high,dataFreshness:telemetry.length?1-stale/telemetry.length:1},at:now()};});

// Control execution ledger: lease -> dispatch -> confirm/fail, plus expiry and revoke.
// Gate results and an append-only timeline are kept as evidence; terminal states are final.
type LedgerStatus='leased'|'dispatched'|'confirmed'|'failed'|'expired'|'revoked';
type LedgerEntry={id:string;commandId:string;idempotencyKey:string|null;assetId:string;status:LedgerStatus;version:number;
 gate:{envelopeViolations:string[];riskScore:number;highAnomalyActive:boolean;overrideReason:string|null;checkedAt:string};
 lease:{createdAt:string;expiresAt:string;ttlSeconds:number};
 dispatch:null|{key:string;executorId:string;at:string;notified:boolean};
 confirmation:null|{key:string;executorId:string;at:string;result:any};
 failure:null|{key:string;reason:string;executorId:string|null;at:string};
 revocation:null|{reason:string;revokedBy:string;at:string};
 timeline:{seq:number;at:string;event:string;detail:any}[]};
const controlLedger:LedgerEntry[]=[];
const TERMINAL:LedgerStatus[]=['confirmed','failed','expired','revoked'];
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
function pushTimeline(entry:LedgerEntry,event:string,detail:any){entry.timeline.push({seq:entry.timeline.length+1,at:now(),event,detail});}
function refreshLease(entry:LedgerEntry){if((entry.status==='leased'||entry.status==='dispatched')&&Date.now()>Date.parse(entry.lease.expiresAt)){entry.status='expired';entry.version++;pushTimeline(entry,'lease.expired',{expiresAt:entry.lease.expiresAt});log('control-ledger.expire',entry.commandId,{ledgerId:entry.id});}}
function createLedger(command:any,ttlSeconds:number,risk:any,highAnomalyActive:boolean,overrideReason:string|null):LedgerEntry{const entry:LedgerEntry={id:randomUUID(),commandId:command.id,idempotencyKey:command.idempotencyKey??null,assetId:command.assetId,status:'leased',version:1,gate:{envelopeViolations:risk.violations,riskScore:risk.riskScore,highAnomalyActive,overrideReason,checkedAt:now()},lease:{createdAt:now(),expiresAt:command.expiresAt,ttlSeconds},dispatch:null,confirmation:null,failure:null,revocation:null,timeline:[]};pushTimeline(entry,'gate.evaluated',entry.gate);pushTimeline(entry,'lease.created',{expiresAt:entry.lease.expiresAt,ttlSeconds});controlLedger.push(entry);log('control-ledger.lease',entry.commandId,{ledgerId:entry.id,expiresAt:entry.lease.expiresAt});return entry;}
function executionView(entry:LedgerEntry){refreshLease(entry);return{ledgerId:entry.id,status:entry.status,final:TERMINAL.includes(entry.status),version:entry.version,lease:entry.lease,dispatch:entry.dispatch,confirmation:entry.confirmation,failure:entry.failure,revocation:entry.revocation};}
function findLedger(id:string){return controlLedger.find(x=>x.commandId===id||x.id===id);}
app.get('/api/control/commands',async(req:any)=>{const q=req.query as any;const items=controlCommands.filter(c=>!q.assetId||c.assetId===q.assetId).map(c=>{const entry=controlLedger.find(x=>x.commandId===c.id);return{...c,execution:entry?executionView(entry):null};});return items.filter(c=>!q.status||c.execution?.status===q.status);});
app.get('/api/control/commands/:id',async(req:any,res)=>{const c=controlCommands.find(x=>x.id===(req.params as any).id);if(!c)return res.code(404).send({error:'command not found'});const entry=controlLedger.find(x=>x.commandId===c.id);return{...c,execution:entry?executionView(entry):null};});
app.get('/api/control/ledger',async(req:any)=>{const q=req.query as any;return controlLedger.filter(e=>{refreshLease(e);return(!q.status||e.status===q.status)&&(!q.assetId||e.assetId===q.assetId)}).map(e=>({commandId:e.commandId,assetId:e.assetId,idempotencyKey:e.idempotencyKey,...executionView(e)}));});
app.get('/api/control/ledger/:commandId',async(req:any,res)=>{const entry=findLedger((req.params as any).commandId);if(!entry)return res.code(404).send({error:'ledger entry not found'});refreshLease(entry);return entry;});
app.post('/api/control/ledger/sweep',async()=>{let expired=0;for(const e of controlLedger){const before=e.status;refreshLease(e);if(e.status!==before)expired++;}return{expired,at:now()};});
app.post('/api/control/ledger/:commandId/dispatch',async(req:any,res)=>{
 const entry=findLedger((req.params as any).commandId);if(!entry)return res.code(404).send({error:'ledger entry not found'});
 refreshLease(entry);
 const b=req.body as any;const key=b?.dispatchKey?String(b.dispatchKey):null;
 if(!key)return res.code(400).send({error:'dispatchKey 必填（幂等标识）'});
 const executorId=b.executorId||'executor-local';
 if(entry.dispatch&&entry.dispatch.key===key){pushTimeline(entry,'dispatch.duplicate',{key});return{ledgerId:entry.id,commandId:entry.commandId,status:entry.status,idempotentReplay:true,dispatch:entry.dispatch};}
 if(TERMINAL.includes(entry.status)){pushTimeline(entry,'dispatch.rejected',{key,status:entry.status});return res.code(409).send({error:`command is ${entry.status}; dispatch rejected`,status:entry.status});}
 if(entry.dispatch){
  pushTimeline(entry,'dispatch.conflict',{key,existing:entry.dispatch.key});
  return res.code(409).send({error:'already dispatched with a different dispatchKey',status:entry.status,dispatch:entry.dispatch});
 }
 const disp={key,executorId,at:now(),notified:false};
 entry.dispatch=disp;entry.status='dispatched';entry.version++;
 pushTimeline(entry,'dispatch.sent',{key,executorId});
 log('control-ledger.dispatch',entry.commandId,{ledgerId:entry.id,key,executorId});
 if(b.executorUrl){
  const cmd=controlCommands.find(c=>c.id===entry.commandId);
  try{
   const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),1500);
   const r=await fetch(String(b.executorUrl),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'dispatch',commandId:entry.commandId,dispatchKey:key,assetId:entry.assetId,parameters:cmd?.parameters,leaseExpiresAt:entry.lease.expiresAt}),signal:ctrl.signal});
   clearTimeout(timer);disp.notified=r.ok;
   pushTimeline(entry,r.ok?'dispatch.notified':'dispatch.notify-failed',{executorUrl:b.executorUrl,httpStatus:r.status});
  }catch(err:any){disp.notified=false;pushTimeline(entry,'dispatch.notify-failed',{executorUrl:b.executorUrl,error:String(err?.message||err)});}
 }
 return{ledgerId:entry.id,commandId:entry.commandId,status:entry.status,dispatch:entry.dispatch};
});
app.post('/api/control/ledger/:commandId/confirm',async(req:any,res)=>{
 const entry=findLedger((req.params as any).commandId);if(!entry)return res.code(404).send({error:'ledger entry not found'});
 refreshLease(entry);
 const b=req.body as any;const key=b?.confirmKey?String(b.confirmKey):null;
 if(!key)return res.code(400).send({error:'confirmKey 必填（幂等标识）'});
 if(entry.confirmation){
  if(entry.confirmation.key===key){pushTimeline(entry,'confirm.duplicate',{key});return{ledgerId:entry.id,commandId:entry.commandId,status:entry.status,idempotentReplay:true,confirmation:entry.confirmation};}
  pushTimeline(entry,'confirm.conflict',{key,existing:entry.confirmation.key});
  return res.code(409).send({error:'already confirmed with a different confirmKey',status:entry.status});
 }
 if(entry.status==='expired'||entry.status==='revoked'||entry.status==='failed'){
  pushTimeline(entry,'confirm.late',{key,status:entry.status,executorId:b?.executorId??null});
  log('control-ledger.confirm-late',entry.commandId,{ledgerId:entry.id,key,status:entry.status});
  return res.code(409).send({error:`late confirmation ignored; command is ${entry.status}`,status:entry.status});
 }
 if(entry.status!=='dispatched'){pushTimeline(entry,'confirm.rejected',{key,reason:'not-dispatched'});return res.code(409).send({error:'command has not been dispatched',status:entry.status});}
 entry.confirmation={key,executorId:b.executorId||entry.dispatch?.executorId||'executor-local',at:now(),result:b.result??{applied:true}};
 entry.status='confirmed';entry.version++;
 pushTimeline(entry,'confirm.received',entry.confirmation);
 log('control-ledger.confirm',entry.commandId,{ledgerId:entry.id,key});
 return{ledgerId:entry.id,commandId:entry.commandId,status:entry.status,confirmation:entry.confirmation};
});
app.post('/api/control/ledger/:commandId/fail',async(req:any,res)=>{
 const entry=findLedger((req.params as any).commandId);if(!entry)return res.code(404).send({error:'ledger entry not found'});
 refreshLease(entry);
 const b=req.body as any;const key=b?.failureKey?String(b.failureKey):null;
 if(!key)return res.code(400).send({error:'failureKey 必填（幂等标识）'});
 const reason=b.reason||'executor reported failure';
 if(entry.failure){
  if(entry.failure.key===key){pushTimeline(entry,'failure.duplicate',{key});return{ledgerId:entry.id,commandId:entry.commandId,status:entry.status,idempotentReplay:true,failure:entry.failure};}
  pushTimeline(entry,'failure.conflict',{key,existing:entry.failure.key});
  return res.code(409).send({error:'already failed with a different failureKey',status:entry.status});
 }
 if(entry.status==='confirmed'){pushTimeline(entry,'failure.conflict',{key,reason});return res.code(409).send({error:'command already confirmed; failure kept as conflicting evidence only',status:entry.status});}
 if(entry.status==='expired'||entry.status==='revoked'){pushTimeline(entry,'failure.late',{key,reason,status:entry.status});return res.code(409).send({error:`late failure ignored; command is ${entry.status}`,status:entry.status});}
 entry.failure={key,reason,executorId:b.executorId??entry.dispatch?.executorId??null,at:now()};
 entry.status='failed';entry.version++;
 pushTimeline(entry,'failure.received',entry.failure);
 log('control-ledger.fail',entry.commandId,{ledgerId:entry.id,key,reason});
 return{ledgerId:entry.id,commandId:entry.commandId,status:entry.status,failure:entry.failure};
});
app.post('/api/control/ledger/:commandId/revoke',async(req:any,res)=>{
 const entry=findLedger((req.params as any).commandId);if(!entry)return res.code(404).send({error:'ledger entry not found'});
 refreshLease(entry);
 const b=req.body as any;const reason=b?.reason||'operator revoke';const revokedBy=b?.revokedBy||'operator';
 if(entry.status==='revoked'){pushTimeline(entry,'revoke.duplicate',{reason,revokedBy});return{ledgerId:entry.id,commandId:entry.commandId,status:entry.status,idempotentReplay:true,revocation:entry.revocation};}
 if(TERMINAL.includes(entry.status)){pushTimeline(entry,'revoke.rejected',{reason,status:entry.status});return res.code(409).send({error:`cannot revoke a ${entry.status} command`,status:entry.status});}
 entry.revocation={reason,revokedBy,at:now()};
 entry.status='revoked';entry.version++;
 pushTimeline(entry,'revoke.recorded',entry.revocation);
 log('control-ledger.revoke',entry.commandId,{ledgerId:entry.id,reason,revokedBy});
 return{ledgerId:entry.id,commandId:entry.commandId,status:entry.status,revocation:entry.revocation};
});
// Simulated field executor: calls the ledger back over plain HTTP (no message middleware).
app.post('/api/executor/simulate',async(req:any,res)=>{
 const b=req.body as any;
 if(!b.commandId)return res.code(400).send({error:'commandId 必填'});
 const behavior=b.behavior||'confirm';const executorId=b.executorId||'executor-sim';
 const base=`http://127.0.0.1:${PORT}`;
 const post=async(path:string,payload:any)=>{const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});return{httpStatus:r.status,body:await r.json()};};
 const dispatchKey=b.dispatchKey||`dsp-${b.commandId}`;const confirmKey=b.confirmKey||`cfm-${b.commandId}`;const failureKey=b.failureKey||`fail-${b.commandId}`;
 const trace:any[]=[];
 const dispatch=()=>post(`/api/control/ledger/${b.commandId}/dispatch`,{dispatchKey,executorId});
 const confirm=()=>post(`/api/control/ledger/${b.commandId}/confirm`,{confirmKey,executorId,result:b.result??{applied:true}});
 const fail=()=>post(`/api/control/ledger/${b.commandId}/fail`,{failureKey,executorId,reason:b.reason||'simulated executor failure'});
 if(behavior==='confirm'){trace.push(await dispatch());trace.push(await confirm());}
 else if(behavior==='duplicate-dispatch'){trace.push(await dispatch());trace.push(await dispatch());}
 else if(behavior==='duplicate-confirm'){trace.push(await dispatch());trace.push(await confirm());trace.push(await confirm());}
 else if(behavior==='fail'){trace.push(await dispatch());trace.push(await fail());}
 else if(behavior==='late-confirm'){
  trace.push(await dispatch());
  const r=await fetch(`${base}/api/control/ledger/${b.commandId}`);const entry=await r.json();
  const waitMs=Date.parse(entry.lease.expiresAt)-Date.now()+150;
  if(waitMs>0)await sleep(Math.min(waitMs,15000));
  trace.push(await confirm());
 }
 else return res.code(400).send({error:`unknown behavior: ${behavior}`,known:['confirm','duplicate-dispatch','duplicate-confirm','fail','late-confirm']});
 return{commandId:b.commandId,behavior,executorId,trace};
});

const PORT=Number(process.env.PORT||6301);
app.listen({port:PORT,host:'127.0.0.1'}).catch(err=>{app.log.error(err);process.exit(1)});
