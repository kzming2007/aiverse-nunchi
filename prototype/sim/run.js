// AI 눈치게임 — 밸런스 시뮬레이터
// 실제 게임과 같은 public/ai/model.js, planner.js로 가상 플레이어와 수천 판을 돌려 봅니다.
// 실행: node prototype/sim/run.js [유형별 게임 수=150] [시드=1]
// 주의: 가상 플레이어의 결과입니다. 사람의 재미나 실제 유형 분류 정확도를 뜻하지 않습니다.
//
// 숫자 바꿔 보기 (환경변수):
//   SIM_MODEL='{"switchWindow":0}'      플레이어 모델 기본값 덮어쓰기 (예: 전략 변경 감지 끄기)
//   SIM_PLANNER='{"reprobeOnSwitch":false}'  작전 계산기 기본값 덮어쓰기
//   SIM_TAG=이름                         결과를 results/이름.json 으로 저장 (없으면 latest.json)
'use strict';

const fs = require('fs');
const path = require('path');
const Model = require('../public/ai/model.js');
const Planner = require('../public/ai/planner.js');

const GAMES = Number(process.argv[2]) || 150;
const SEED = Number(process.argv[3]) || 1;
if (process.env.SIM_MODEL) Object.assign(Model.DEFAULT_PARAMS, JSON.parse(process.env.SIM_MODEL));
if (process.env.SIM_PLANNER) Object.assign(Planner.DEFAULTS, JSON.parse(process.env.SIM_PLANNER));
const TAG = (process.env.SIM_TAG || 'latest').replace(/[^\w.-]/g, '_');
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
const BASE = {
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
};

// 중간에 전략을 바꾸는 플레이어: at판부터 to 유형으로 플레이
const switchTo = (from, to, at) => (r) => {
  const a = BASE[from](r);
  const b = BASE[to](r);
  return (k, s) => (k < at ? a(k, s) : b(k, s));
};

const KINDS = {
  instant: { make: BASE.instant, label: '즉시형' },
  fixed: { make: BASE.fixed, label: '공격형' },
  follow: { make: BASE.follow, label: '눈치형' },
  hold: { make: BASE.hold, label: '버티기형' },
  random: { make: BASE.random, label: '랜덤형' },
  masher: { make: (r) => () => ({ type: 'instant', t: 40 + 80 * r() }), label: '연타' }, // 스페이스바 연타
  sloppy: {
    // 눈치형인데 판마다 15% 확률로 엉뚱한 시각에 누름 (전략 변경이 아닌 실수 → 감지하면 안 되는 경우)
    make: (r) => {
      const f = BASE.follow(r);
      return (k, a) => (r() < 0.15 ? { type: 'follow', t: 5000 * r() } : f(k, a));
    },
    label: '눈치형+실수15%',
  },
  switcher: { make: switchTo('follow', 'fixed', 6), label: '눈치→공격 (6판)', switchAt: 6 },
  fixedToFollow: { make: switchTo('fixed', 'follow', 6), label: '공격→눈치 (6판)', switchAt: 6 },
  followToInstant: { make: switchTo('follow', 'instant', 5), label: '눈치→즉시 (5판)', switchAt: 5 },
  instantToHold: { make: switchTo('instant', 'hold', 7), label: '즉시→버티기 (7판)', switchAt: 7 },
};

function playGame(kind, seed) {
  const r = rng(seed);
  const plannerRng = rng(seed ^ 0x9e3779b9);
  const player = KINDS[kind].make(r);
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
    const mix = Model.predictive(belief, a, Model.DEFAULT_PARAMS);
    const hitProb = pressed ? Model.massBetween(mix, t - TOL, t + TOL) : null;
    const res = Model.update(belief, a, pressed ? { pressed: true, t } : { pressed: false, censorAt: a[2] });
    belief = res.belief;
    rows.push({
      k,
      survived: !me.out,
      score: me.out ? 0 : Math.round(100 * (1 + plan.pCatch)),
      pCatch: plan.pCatch,
      hitProb,
      correct: Model.ranking(belief)[0].id === intent.type,
      switched: res.switched,
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
  const { label, switchAt } = KINDS[kind];
  const games = [];
  for (let g = 0; g < GAMES; g++) games.push(playGame(kind, SEED * 100000 + g * 7919 + kind.length));
  const rows = games.flat();
  rows.forEach((x) => planTimes.push(x.planMs));
  const accAt = (k) => (k >= 1 && k <= ROUNDS ? avg(games.map((rs) => (rs[k - 1].correct ? 1 : 0))) : NaN);
  const attack = rows.filter((x) => x.k > 3);
  const out = {
    label,
    survivalProbe: avg(rows.filter((x) => x.k <= 3).map((x) => (x.survived ? 1 : 0))),
    survivalAttack: avg(attack.map((x) => (x.survived ? 1 : 0))),
    pCatchAttack: avg(attack.map((x) => x.pCatch)),
    scorePerGame: avg(games.map((rs) => rs.reduce((s, x) => s + x.score, 0))),
    readAttack: avg(attack.filter((x) => x.hitProb !== null).map((x) => x.hitProb)),
    accuracy: { r3: accAt(3), r4: accAt(4), r6: accAt(6), r8: accAt(8), r10: accAt(10) },
  };
  if (switchAt) {
    // 바꾼 판(s)부터: s, s+1, s+2, s+3판을 본 뒤 새 유형을 1순위로 맞힌 비율
    out.switchAt = switchAt;
    out.afterSwitch = [0, 1, 2, 3].map((d) => accAt(switchAt + d));
    const firstDetect = games.map((rs) => rs.find((x) => x.switched && x.k >= switchAt));
    out.detected = avg(firstDetect.map((x) => (x ? 1 : 0))); // 바꾼 뒤 한 번이라도 감지
    out.detectDelay = avg(firstDetect.filter(Boolean).map((x) => x.k - switchAt + 1)); // 바꾼 뒤 몇 판째에 감지 (1 = 바꾼 그 판)
    out.falseBefore = avg(games.map((rs) => (rs.some((x) => x.switched && x.k < switchAt) ? 1 : 0))); // 바꾸기 전 잘못 감지
    out.survivalAfter = avg(rows.filter((x) => x.k >= switchAt).map((x) => (x.survived ? 1 : 0)));
  } else {
    out.falseSwitch = avg(games.map((rs) => (rs.some((x) => x.switched) ? 1 : 0))); // 전략을 안 바꿨는데 감지한 게임 비율
  }
  results[kind] = out;
}

const SWITCH = Model.DEFAULT_PARAMS.switchWindow ? `켜짐 (최근 ${Model.DEFAULT_PARAMS.switchWindow}판, 기준 e^${Model.DEFAULT_PARAMS.switchMargin})` : '꺼짐';
console.log(`\n가상 플레이어 시뮬레이션 — 유형별 ${GAMES}게임 × ${ROUNDS}판, 시드 ${SEED}, 전략 변경 감지 ${SWITCH}`);
console.log('(정답률 = 그 판까지 본 뒤 AI가 1순위로 고른 유형이 실제 유형과 같은 비율. 전략을 바꾼 플레이어는 바꾼 뒤의 유형이 정답)\n');
console.log('유형              | 생존 1~3판 | 생존 4~10판 | AI 포획예상 | 게임 점수 | 읽힌 정도 | 정답률 3·4·6·8·10판 | 잘못 감지');
for (const v of Object.values(results)) {
  if (v.switchAt) continue;
  const a = v.accuracy;
  console.log(
    `${v.label.padEnd(14)} | ${pct(v.survivalProbe).padStart(9)} | ${pct(v.survivalAttack).padStart(10)} | ${pct(v.pCatchAttack).padStart(10)} | ${v.scorePerGame
      .toFixed(0)
      .padStart(8)} | ${pct(v.readAttack).padStart(8)} | ${[a.r3, a.r4, a.r6, a.r8, a.r10].map(pct).join(' · ')} | ${pct(v.falseSwitch)}`
  );
}
console.log('\n전략 변경         | 정답률: 바꾼 판 · +1 · +2 · +3 | 감지율 | 감지까지(판) | 바꾸기 전 잘못 감지 | 바꾼 뒤 생존 | 게임 점수');
for (const v of Object.values(results)) {
  if (!v.switchAt) continue;
  console.log(
    `${v.label.padEnd(14)} | ${v.afterSwitch.map(pct).join(' · ').padStart(28)} | ${pct(v.detected).padStart(5)} | ${(Number.isFinite(v.detectDelay)
      ? v.detectDelay.toFixed(1)
      : '-'
    ).padStart(10)} | ${pct(v.falseBefore).padStart(17)} | ${pct(v.survivalAfter).padStart(10)} | ${v.scorePerGame.toFixed(0).padStart(8)}`
  );
}
planTimes.sort((x, y) => x - y);
console.log(`\n작전 계산 시간: 평균 ${avg(planTimes).toFixed(1)}ms · 상위 1% ${planTimes[Math.floor(planTimes.length * 0.99)].toFixed(1)}ms`);
console.log(`작전 후보 수(공정 규칙 통과): ${Planner.candidates({ ...Planner.DEFAULTS, ...OPTS }).length}개`);
console.log(`무작위로 찍었을 때의 '읽힌 정도' 기준: ${pct((2 * TOL) / 5000)}\n`);

const outDir = path.join(__dirname, 'results');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, `${TAG}.json`),
  JSON.stringify({ games: GAMES, rounds: ROUNDS, seed: SEED, planner: { ...Planner.DEFAULTS, ...OPTS }, model: Model.DEFAULT_PARAMS, synthetic: true, results }, null, 2) + '\n'
);
