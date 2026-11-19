// AI 눈치게임 — 밸런스 시뮬레이터
// 실제 게임과 같은 public/ai/model.js, planner.js로 가상 플레이어와 수천 판을 돌려 봅니다.
// 실행: node prototype/sim/run.js [유형별 게임 수=150] [시드=1]
// 주의: 가상 플레이어의 결과입니다. 사람의 재미나 실제 유형 분류 정확도를 뜻하지 않습니다.
'use strict';

const fs = require('fs');
const path = require('path');
const Model = require('../public/ai/model.js');
const Planner = require('../public/ai/planner.js');

const GAMES = Number(process.argv[2]) || 150;
const SEED = Number(process.argv[3]) || 1;
// 숫자 바꿔 보기: SIM_MODEL='{"decay":0.7,"drift":150}' 처럼 환경변수로 모델 기본값을 덮어씀
if (process.env.SIM_MODEL) Object.assign(Model.DEFAULT_PARAMS, JSON.parse(process.env.SIM_MODEL));
const ROUNDS = 10;
const OPTS = { totalRounds: ROUNDS }; // 나머지는 planner.js의 DEFAULTS (게임과 같은 값)
const TOL = Model.DEFAULT_PARAMS.hitToleranceMs;

// ───────── 재현 가능한 난수 ─────────
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r) => Math.sqrt(-2 * Math.log(Math.max(1e-12, r()))) * Math.cos(2 * Math.PI * r());

// ───────── 가상 플레이어 ─────────
// 각 함수는 (판 번호, AI 작전 a) → { type: 실제 유형, t: 누르려는 시각 } 을 돌려주는 플레이어를 만듭니다.
const KINDS = {
  instant: (r) => {
    const mu = 150 + 150 * r();
    return () => ({ type: 'instant', t: mu + 70 * gauss(r) });
  },
  fixed: (r) => {
    const mu = 600 + 3000 * r();
    return () => ({ type: 'fixed', t: mu + 220 * gauss(r) });
  },
  follow: (r) => {
    const d = 250 + 400 * r();
    return (k, a) => ({ type: 'follow', t: a[0] + Math.max(150, d + 110 * gauss(r)) });
  },
  hold: (r) => {
    const d = 250 + 400 * r();
    return (k, a) => ({ type: 'hold', t: a[1] + Math.max(150, d + 130 * gauss(r)) });
  },
  random: (r) => () => ({ type: 'random', t: 5000 * r() }),
  masher: (r) => () => ({ type: 'instant', t: 40 + 80 * r() }), // 스페이스바 연타
  switcher: (r) => {
    // 5판까지 눈치형, 6판부터 공격형으로 전략을 바꿈
    const follow = KINDS.follow(r);
    const fixed = KINDS.fixed(r);
    return (k, a) => (k <= 5 ? follow(k, a) : fixed(k, a));
  },
};
const LABEL = { instant: '즉시형', fixed: '공격형', follow: '눈치형', hold: '버티기형', random: '랜덤형', masher: '연타', switcher: '전략 변경' };

function playGame(kind, seed) {
  const r = rng(seed);
  const plannerRng = rng(seed ^ 0x9e3779b9);
  const player = KINDS[kind](r);
  let belief = Model.createBelief();
  const rows = [];
  for (let k = 1; k <= ROUNDS; k++) {
    const t0 = process.hrtime.bigint();
    const plan = Planner.plan(belief, k, OPTS, plannerRng);
    const planMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const a = plan.times;
    const intent = player(k, a);
    const t = Math.max(30, intent.t);
    const pressed = t < a[2]; // 마지막 AI가 누르면 판이 끝나므로, 그 뒤에 누르려 했다면 '마지막'
    const entries = [{ id: 'player', time: pressed ? t : null }, ...a.map((x, i) => ({ id: `ai${i}`, time: x }))];
    const me = Planner.judge(entries, Planner.DEFAULTS.windowMs)[0];
    const mix = Model.predictive(belief, a);
    const hitProb = pressed ? Model.massBetween(mix, t - TOL, t + TOL) : null;
    belief = Model.update(belief, a, pressed ? { pressed: true, t } : { pressed: false, censorAt: a[2] }).belief;
    rows.push({
      k,
      survived: !me.out,
      score: me.out ? 0 : Math.round(100 * (1 + plan.pCatch)),
      pCatch: plan.pCatch,
      hitProb,
      correct: Model.ranking(belief)[0].id === intent.type,
      planMs,
    });
  }
  return rows;
}

// ───────── 실행과 집계 ─────────
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : '-');
const results = {};
const planTimes = [];

for (const kind of Object.keys(KINDS)) {
  const games = [];
  for (let g = 0; g < GAMES; g++) games.push(playGame(kind, SEED * 100000 + g * 7919 + kind.length));
  const rows = games.flat();
  rows.forEach((x) => planTimes.push(x.planMs));
  const at = (k) => avg(games.map((rs) => (rs[k - 1].correct ? 1 : 0)));
  const attack = rows.filter((x) => x.k > 3);
  results[kind] = {
    label: LABEL[kind],
    survivalProbe: avg(rows.filter((x) => x.k <= 3).map((x) => (x.survived ? 1 : 0))),
    survivalAttack: avg(attack.map((x) => (x.survived ? 1 : 0))),
    pCatchAttack: avg(attack.map((x) => x.pCatch)),
    scorePerGame: avg(games.map((rs) => rs.reduce((s, x) => s + x.score, 0))),
    readAttack: avg(attack.filter((x) => x.hitProb !== null).map((x) => x.hitProb)),
    accuracy: { r3: at(3), r4: at(4), r6: at(6), r8: at(8), r10: at(10) },
  };
}

console.log(`\n가상 플레이어 시뮬레이션 — 유형별 ${GAMES}게임 × ${ROUNDS}판, 시드 ${SEED}`);
console.log('(정답률 = 그 판까지 본 뒤 AI가 1순위로 고른 유형이 실제 유형과 같은 비율. 전략 변경은 6판부터 공격형이 정답)\n');
console.log('유형        | 생존 1~3판 | 생존 4~10판 | AI 포획예상 | 게임 점수 | 읽힌 정도 | 정답률 3판·4판·6판·8판·10판');
for (const [, v] of Object.entries(results)) {
  const a = v.accuracy;
  console.log(
    `${v.label.padEnd(9)} | ${pct(v.survivalProbe).padStart(9)} | ${pct(v.survivalAttack).padStart(10)} | ${pct(v.pCatchAttack).padStart(10)} | ${v.scorePerGame.toFixed(0).padStart(8)} | ${pct(v.readAttack).padStart(8)} | ${[a.r3, a.r4, a.r6, a.r8, a.r10].map(pct).join(' · ')}`
  );
}
planTimes.sort((x, y) => x - y);
console.log(`\n작전 계산 시간: 평균 ${avg(planTimes).toFixed(1)}ms · 상위 1% ${planTimes[Math.floor(planTimes.length * 0.99)].toFixed(1)}ms`);
console.log(`작전 후보 수(공정 규칙 통과): ${Planner.candidates({ ...Planner.DEFAULTS, ...OPTS }).length}개`);
console.log(`무작위로 찍었을 때의 '읽힌 정도' 기준: ${pct((2 * TOL) / 5000)}\n`);

const outDir = path.join(__dirname, 'results');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, 'latest.json'),
  JSON.stringify({ games: GAMES, rounds: ROUNDS, seed: SEED, planner: { ...Planner.DEFAULTS, ...OPTS }, model: Model.DEFAULT_PARAMS, synthetic: true, results }, null, 2) + '\n'
);
