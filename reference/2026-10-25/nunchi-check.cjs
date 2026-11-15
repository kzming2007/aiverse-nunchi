const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const base = __dirname;
const html = fs.readFileSync(path.join(base, 'nunchi-personal-review.html'), 'utf8');
const source = html.split('// BEGIN NUNCHI CORE')[1].split('// END NUNCHI CORE')[0];
const box = {};
vm.runInNewContext(source, box);
const C = box.NunchiCore;

assert(C.hit(1, 1.3));
assert(!C.hit(1, 1.301));
assert(!C.hit(1, null));
const p = C.plan([], [], C.rng(5));
assert(Object.isFrozen(p) && Object.isFrozen(p.times));
assert.equal(p.ownModel, null);
assert.equal(p.crowdModel, null);
const before = JSON.stringify(p);
C.resolve(p, 1.2);
assert.equal(JSON.stringify(p), before);
assert.equal(C.resolve(p, null).safe, false);
assert.equal(C.plan([C.resolve(p, null)], [], C.rng(6)).ownN, 0);
assert.throws(() => C.resolve(p, 5));
assert.throws(() => C.resolve(p, -1));
assert.throws(() => C.resolve(p, NaN));
assert.equal(C.crowd(20).length, 200);
const withoutPrior=C.replay('cue',[],77), withPrior=C.replay('cue',C.crowd(20),77);
assert.equal(JSON.stringify(withoutPrior.map(x=>[x.a,x.plan.b,x.t])),JSON.stringify(withPrior.map(x=>[x.a,x.plan.b,x.t])));
const fitRows = Array.from({length: 100}, (_, i) => ({a: .8 + i*.008, t: 1.45 + i*.008}));
assert(Math.abs(C.fit(fitRows, 1.2).time - 1.85) < .01);
assert(Math.abs(C.fit(fitRows, 1.2).slope - 1) < .02);
assert.equal(JSON.stringify(C.replay('cue', [], 123)), JSON.stringify(C.replay('cue', [], 123)));
for (const kind of ['cue','absolute','switch','uniform','edge','late','observeAll']) {
  const h = C.replay(kind, [], 123);
  assert.equal(h.length, 10);
  h.forEach((x,i) => assert.equal(x.plan.ownN, Math.min(i,8)));
}

// Generate each trajectory once, independently of predictor policy.
function trajectory(kind, seed) {
  const sr=C.rng(seed), pr=C.rng(seed ^ 0x9e3779b9);
  return Array.from({length:10}, (_,i)=>{
    const [a,b]=C.signals(sr);
    return {a,b,t:C.strategy(kind,a,i,pr)};
  });
}
const N=1000;
const comparisons=[];
for(const kind of ['cue','absolute','switch','uniform','edge','late']) {
  const count={random:0,fixedCueRule:0,previousTimeRule:0,personalRegression:0};
  const byRound=Array.from({length:10},()=>({random:0,fixedCueRule:0,previousTimeRule:0,personalRegression:0}));
  for(let s=0;s<N;s++) {
    const sequence=trajectory(kind,10000+s), random=C.rng(90000+s), history=[];
    sequence.forEach((x,i)=>{
      const cold=5*random(), model=C.fit(history.slice(-8),x.a);
      const preds={random:cold,fixedCueRule:C.clamp(x.a+.65),previousTimeRule:i?history.at(-1).t:cold,personalRegression:model?model.time:cold};
      for(const [key,value] of Object.entries(preds)) {
        if(C.hit(value,x.t)) {count[key]++;byRound[i][key]++;}
      }
      history.push(x); // Only after all predictions have been scored.
    });
  }
  comparisons.push({strategy:kind,sessions:N,rounds:N*10,hits:count,hitRatePercent:Object.fromEntries(Object.entries(count).map(([k,v])=>[k,+(v/(N*10)*100).toFixed(2)])),byRoundPercent:byRound.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,+(v/N*100).toFixed(1)])))});
}

const population=[];
for(const kind of ['similar','mixed']) for(const people of [0,4,20,100]) {
  let hits=0;
  // Every sample size uses the same 500 held-out trajectories. Prefixes share seeds.
  for(let s=0;s<500;s++) {
    const archive=C.crowd(people,kind,300000+s), r=C.rng(400000+s);
    for(const x of trajectory('cue',500000+s)) {
      const model=C.fit(archive,x.a);
      const prediction=model?model.time:5*r();
      hits+=C.hit(prediction,x.t)?1:0;
    }
  }
  population.push({prior:kind,syntheticPeople:people,trainingRows:people*10,testRounds:5000,hits,hitRatePercent:+(hits/50).toFixed(2)});
}

const fullGame=[];
for(const prior of ['none','similar','mixed']) for(const kind of ['cue','absolute','switch','uniform','edge','observeAll']) {
  let safe=0;
  const archive=prior==='none'?[]:C.crowd(20,prior);
  for(let s=0;s<N;s++) safe+=C.replay(kind,archive,70000+s).filter(x=>x.safe).length;
  fullGame.push({prior,strategy:kind,rounds:N*10,safe,safeRatePercent:+(safe/(N*10)*100).toFixed(2)});
}
const example=C.replay('switch',[],20261026).map((x,i)=>({round:i+1,signalA:+x.a.toFixed(3),player:+x.t.toFixed(3),personalPrediction:+x.plan.times[2].toFixed(3),personalHistory:x.plan.ownN,hits:x.hits,safe:x.safe}));
const report={version:1,assumptions:{seconds:5,roundsPerSession:10,overlapHalfWidthSeconds:.3,syntheticPlayerNoiseStdSeconds:.08,personalWindow:8,currentRoundExcludedFromTraining:true,independentPredictorEvaluation:true,funMeasured:false},checks:'passed',comparisons,population,fullGame,example};
fs.writeFileSync(path.join(base,'nunchi-experiment-results.json'), JSON.stringify(report,null,2)+'\n','utf8');
console.log(JSON.stringify({checks:report.checks,comparisons:comparisons.map(({strategy,hitRatePercent})=>({strategy,...hitRatePercent})),population,fullGame,example},null,2));
