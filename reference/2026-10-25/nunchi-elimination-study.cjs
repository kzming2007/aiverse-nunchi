const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const html=fs.readFileSync(path.join(__dirname,'nunchi-personal-review.html'),'utf8'), box={};
vm.runInNewContext(html.split('// BEGIN NUNCHI CORE')[1].split('// END NUNCHI CORE')[0],box);
const C=box.NunchiCore,T=5;
const pct=(x,n)=>+(100*x/n).toFixed(2);

// Every player chooses once. Last includes a player who never presses (Infinity).
function outcome(times,rule='last-both',w=.3){
  const collision=times.map(()=>false),valid=t=>Number.isFinite(t)&&t>=0&&t<T;
  let first=null;
  for(let i=0;i<times.length;i++)for(let j=i+1;j<times.length;j++){
    if(!valid(times[i])||!valid(times[j])||Math.abs(times[i]-times[j])>w+1e-10)continue;
    const later=Math.max(times[i],times[j]);
    if(!first||later<first.at) first={at:later,i,j};
    if(rule==='last-later'){
      if(times[i]>=times[j])collision[i]=true;
      if(times[j]>=times[i])collision[j]=true;
    }else {collision[i]=true;collision[j]=true;}
  }
  if(rule==='first-clash'&&first)return times.map(t=>!(valid(t)&&t<=first.at+1e-10&&first.at-t<=w+1e-10));
  const latest=Math.max(...times);
  return times.map((t,i)=>valid(t)&&!collision[i]&&(rule==='no-last'||t<latest));
}
assert.deepEqual(outcome([.1,1,2]),[true,true,false]);
assert.deepEqual(outcome([.1,.2,2]),[false,false,false]);
assert.deepEqual(outcome([.1,.2,2],'no-last'),[false,false,true]);
assert.deepEqual(outcome([.1,.2,2],'last-later'),[true,false,false]);
assert.deepEqual(outcome([.1,.2,Infinity],'first-clash'),[false,false,true]);
assert.deepEqual(outcome([.1,.1,.1],'first-clash'),[false,false,false]);
assert.deepEqual(outcome([0,.3,2]),[false,false,false]);
assert.deepEqual(outcome([0,.301,2]),[true,true,false]);
// Chronological checking of the later event, with both players marked, equals |a-b| <= w.
for(let s=0;s<100;s++){
  const r=C.rng(s),ts=Array.from({length:5},()=>5*r()),marks=ts.map(()=>false);
  const order=ts.map((t,i)=>({t,i})).sort((a,b)=>a.t-b.t);
  for(let j=0;j<order.length;j++)for(let k=0;k<j;k++)if(order[j].t-order[k].t<=.3){marks[order[j].i]=marks[order[k].i]=true;}
  assert.deepEqual(outcome(ts,'no-last'),marks.map(x=>!x));
}

const oldPaired=[];
for(const kind of ['edge','cue','switch','uniform','observeAll']){
  const count=Object.fromEntries(['no-last','last-both','last-later','first-clash'].map(k=>[k,0]));
  for(let s=0;s<1000;s++)for(const x of C.replay(kind,[],70000+s)){
    for(const rule of Object.keys(count))count[rule]+=+outcome([x.t,...x.plan.times],rule)[0];
  }
  oldPaired.push({strategy:kind,rounds:10000,survivalPercent:Object.fromEntries(Object.entries(count).map(([k,v])=>[k,pct(v,10000)]))});
}

function population(kind,n,r){
  return Array.from({length:n},(_,i)=>{
    if(kind==='early')return .8*r();
    if(kind==='late')return 3.5+1.5*r();
    if(kind==='mixed')return [()=>.8*r(),()=>1.6+r(),()=>3.5+1.5*r(),()=>5*r()][i%4]();
    return 5*r();
  });
}
function action(kind,others,r){
  const sorted=[...others].sort((a,b)=>a-b);
  if(kind==='early')return .1;
  if(kind==='middle')return 2.5;
  if(kind==='first+.35')return Math.min(4.99,sorted[0]+.35);
  if(kind==='penultimate+.35')return Math.min(4.99,sorted[Math.max(0,sorted.length-2)]+.35);
  if(kind==='all+.35')return Math.min(4.99,sorted.at(-1)+.35);
  if(kind==='never')return Infinity;
  return 5*r();
}
const staticPolicies=[];
for(const pop of ['uniform','early','late','mixed'])for(const strategy of ['early','middle','uniform','first+.35','penultimate+.35','all+.35','never']){
  const counts={'no-last':0,'last-both':0,'last-later':0,'first-clash':0},n=20000;
  for(let k=0;k<n;k++){
    const r=C.rng(k+50000),others=population(pop,4,r),t=action(strategy,others,r);
    for(const rule of Object.keys(counts))counts[rule]+=+outcome([t,...others],rule)[0];
  }
  staticPolicies.push({population:pop,player:strategy,rounds:n,survivalPercent:Object.fromEntries(Object.entries(counts).map(([k,v])=>[k,pct(v,n)]))});
}
const density=[];
for(const players of [3,4,5,7])for(const w of [.15,.3,.45]){
  let total=0,firstClashWait=0;const n=20000;
  for(let k=0;k<n;k++){
    const r=C.rng(100000+k),times=population('uniform',players,r);
    total+=+outcome(times,'last-both',w)[0];
    firstClashWait+=+outcome([Infinity,...times.slice(1)],'first-clash',w)[0];
  }
  density.push({players,margin:w,survivalPercent:pct(total,n),neverPressFirstClashSurvival:pct(firstClashWait,n)});
}
function analytic(t,n,w=.3){
  const excluded=Math.min(T,t+w)-Math.max(0,t-w);
  return Math.pow(1-excluded/T,n)-Math.pow(Math.max(0,t-w)/T,n);
}
const theory=[0,.1,1,2.5,4,4.9].map(t=>({t,survivalPercent:+(100*analytic(t,4)).toFixed(2)}));

// Independent bandits: reward is own survival, with no feature/state representation.
const bins=Array.from({length:25},(_,i)=>.1+.2*i);
function pick(q,r,epsilon=.1){
  if(r()<epsilon)return Math.floor(r()*q.length);
  const max=Math.max(...q),ids=q.flatMap((v,i)=>Math.abs(v-max)<1e-9?[i]:[]);
  return ids[Math.floor(r()*ids.length)];
}
function train(seed){
  const r=C.rng(seed),qs=Array.from({length:5},()=>bins.map(()=>.5)),early=[],late=[];
  for(let round=0;round<20000;round++){
    const ids=qs.map(q=>pick(q,r)),times=ids.map(i=>bins[i]+.02*C.gaussian(r)),wins=outcome(times);
    qs.forEach((q,i)=>q[ids[i]]+=.05*(+wins[i]-q[ids[i]]));
    if(round<1000)early.push(wins.reduce((a,b)=>a+ +b,0)/5);
    if(round>=19000)late.push(wins.reduce((a,b)=>a+ +b,0)/5);
  }
  const average=xs=>pct(xs.reduce((a,b)=>a+b,0),xs.length);
  return {seed,qs,earlySurvival:average(early),lateSurvival:average(late)};
}
const trained=[1,2,3,4,5].map(train);
function evaluate(qs,seed){
  const r=C.rng(seed),wins=qs.map(()=>0),hist=qs.map(()=>bins.map(()=>0));
  for(let k=0;k<5000;k++){
    const ids=qs.map(q=>pick(q,r,.1)),ts=ids.map(i=>bins[i]+.02*C.gaussian(r)),result=outcome(ts);
    result.forEach((v,i)=>{wins[i]+=+v;hist[i][ids[i]]++;});
  }
  return {perPlayerSurvival:wins.map(x=>pct(x,5000)),histogram:hist};
}
const rewardLearning=trained.map((t,i)=>{
  const own=evaluate(t.qs,900+i),cross=evaluate(trained.map((other,j)=>trained[(i+j)%5].qs[j]),1900+i);
  return {seed:t.seed,trainingRounds:20000,earlySurvival:t.earlySurvival,lateSurvival:t.lateSurvival,selfPlaySurvival:own.perPlayerSurvival,crossPlaySurvival:cross.perPlayerSurvival,dominantTime:own.histogram.map(h=>bins[h.indexOf(Math.max(...h))]),histogram:own.histogram};
});
const report={status:'passed',synthetic:true,assumptions:{duration:5,margin:.3,roundRulesIndependentOfTraining:true,lastIsLatestOfAllParticipants:true,firstClashStopsAtFirstPair:true,banditReward:'own survival',banditRounds:20000,banditEpsilon:.1,banditAlpha:.05,banditActions:bins},oldPaired,staticPolicies,density,theory,rewardLearning};
fs.writeFileSync(path.join(__dirname,'nunchi-elimination-results.json'),JSON.stringify(report,null,2)+'\n','utf8');
console.log(JSON.stringify({...report,rewardLearning:rewardLearning.map(({histogram,...x})=>x)},null,2));
