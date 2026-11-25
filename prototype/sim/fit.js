// AI 눈치게임 — 숫자 맞추기 도구
// 수집 모드 기록(유형을 정해 연기한 게임)으로 AI의 유형별 숫자를 다시 맞춥니다.
//
//   node prototype/sim/fit.js              Supabase에서 수집 기록을 읽어 숫자를 맞추고 보고서만 만듦 (게임은 그대로)
//   node prototype/sim/fit.js --apply      맞춘 숫자를 public/ai/params.js에 씀 → 커밋·배포하면 게임에 반영
//   node prototype/sim/fit.js --selftest   정답을 아는 가상 데이터로 이 도구가 숫자를 되찾는지 점검
//   --people 파일   닉네임이 섞인 게임을 한 사람으로 묶는 파일 (기본: prototype/sim/people.json)
//   --file 파일     Supabase 대신 저장해 둔 기록으로 (--save 파일 로 저장. 기록 파일은 커밋하지 않음)
//   --input key|touch|all   키보드(부스) / 터치(휴대폰) 기록만으로 맞추기 (기본 all). 섞여 있으면 보고서에 둘을 비교해 보여 줌
//   --only 유형,…   고른 숫자만 바꾸고 나머지는 지금 숫자 그대로 (예: --only fixed,follow). instant·fixed·follow·hold·lapse(실수 비율)
//
// 맞추는 숫자 (유형별, ms)
//   습관 (prior.mean)  사람마다의 평균: 즉시형은 누른 시각, 눈치형·버티기형은 기준 AI 뒤 반응 시간
//   사람 차이 (prior.sd) 사람마다 습관이 얼마나 다른지 (2명 이상일 때)
//   흔들림 (noise)     같은 사람이 한 게임 안에서 매번 얼마나 다르게 누르는지
//   실수 비율 (lapse)  연기한 유형과 전혀 다르게 누른 판의 비율
//   공격형의 시각은 연기할 때 일부러 정한 값이라 맞추지 않고, 흔들림만 맞춥니다. 랜덤형은 분포만 보고합니다.
//
// 원칙
//   - 연타한 판(extra_presses > 0)은 뺍니다.
//   - people.json의 "제외"에 적은 게임(고른 유형과 전혀 다르게 연기한 게임 등)은 숫자 맞추기에서 빼고, 검증에는 넣습니다.
//   - 시각이 안 남은 판(AI 셋이 먼저 다 누름)은 "그때까지는 안 눌렀다"로 계산합니다 (중도 절단 정규분포, EM).
//     단, 습관보다 한참 늦은 시점까지 안 누른 판은 실수로 셉니다.
//   - 사람마다 같은 무게로 평균을 냅니다 (한 사람이 많이 해도 쏠리지 않게).
//   - 사람이 적으면 기본값 쪽으로 당깁니다: 습관은 기본값을 사람 1명분, 사람 차이는 2명분, 흔들림은 10판분, 실수 비율은 40판분으로 셈.
//   - 검증: 지금 숫자와 새 숫자로 실제 게임을 판마다 다시 돌려 비교. 2명 이상이면 한 사람씩 빼고 맞춘 뒤 그 사람으로 확인.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Model = require('../public/ai/model.js');
const Planner = require('../public/ai/planner.js');

const FIT_TYPES = ['instant', 'fixed', 'follow', 'hold'];
const ALL_TYPES = [...FIT_TYPES, 'random'];
const NAME = { ...Object.fromEntries(Model.TYPES.map((t) => [t.id, t.name])), free: '자유' };
const INPUT_NAME = { key: '키보드', touch: '터치', mouse: '마우스' };
const K_MEAN = 1; // 습관: 기본값을 사람 1명분으로
const NU_SPREAD = 2; // 사람 차이: 기본값을 사람 2명분으로
const NU_NOISE = 10; // 흔들림: 기본값을 10판분으로
const LAPSE_PRIOR = { a: 2, b: 38 }; // 실수 비율: 기본값 5%를 40판분으로
const SD_FLOOR = 40; // 흔들림 하한 (ms). 화면 갱신·키 입력 지연만으로도 이 정도는 흔들림
const OUTLIER_MIN = 250; // 습관에서 이만큼 안쪽은 실수로 보지 않음 (ms)
const RESULTS = path.join(__dirname, 'results');
const PARAMS_FILE = path.join(__dirname, '../public/ai/params.js');

// ───────── 수학 도구 ─────────
const sum = (a) => a.reduce((s, x) => s + x, 0);
const mean = (a) => (a.length ? sum(a) / a.length : NaN);
const variance = (a) => (a.length > 1 ? sum(a.map((x) => (x - mean(a)) ** 2)) / (a.length - 1) : NaN);
const median = (a) => {
  const b = a.slice().sort((x, y) => x - y);
  return b.length % 2 ? b[(b.length - 1) / 2] : (b[b.length / 2 - 1] + b[b.length / 2]) / 2;
};
const mad = (a) => median(a.map((x) => Math.abs(x - median(a))));
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const phi = (z) => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
const round4 = (x) => Math.round(x * 10000) / 10000;
const ms = (x) => (Number.isFinite(x) ? String(Math.round(x)) : '-');
const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : '-');

// ───────── 기록 읽기 ─────────
async function loadFromSupabase() {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/config.js'), 'utf8'), sandbox);
  const { supabaseUrl, supabaseKey } = sandbox.window.NUNCHI_CONFIG;
  const out = [];
  const page = 100;
  for (let from = 0; ; from += page) {
    const q =
      `${supabaseUrl}/rest/v1/nunchi_games?select=id,nickname,station,mode,label,rule_version,started_at,` +
      `nunchi_rounds(round,time_ms,extra_presses,ai)&mode=eq.collect&order=started_at.asc&limit=${page}&offset=${from}`;
    const res = await fetch(q, { headers: { apikey: supabaseKey } });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
    const rows = await res.json();
    out.push(...rows);
    if (rows.length < page) break;
  }
  return out;
}

// 사람 묶기: games(게임 id)가 먼저, 그다음 nicknames. 둘 다 없으면 닉네임 그대로가 한 사람
// 제외: { 게임 id: 이유 } — 숫자 맞추기에서 뺄 게임 (검증에는 넣음)
function loadPeople(file) {
  if (!file || !fs.existsSync(file)) return { byGame: new Map(), byNick: new Map(), skip: new Map() };
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const byGame = new Map();
  const byNick = new Map();
  for (const [person, v] of Object.entries(data.people || {})) {
    for (const id of v.games || []) byGame.set(id, person);
    for (const nick of v.nicknames || []) byNick.set(nick, person);
  }
  return { byGame, byNick, skip: new Map(Object.entries(data['제외'] || {})) };
}

// → [{ id, person, nickname, label, rounds: [{ a: [a1,a2,a3], t, extra }] }]
function normalize(raw, people) {
  const games = [];
  for (const g of raw) {
    if (g.mode !== 'collect' || !g.label || !String(g.rule_version || '').startsWith('r2')) continue; // 지금 규칙(0.15초 판정)으로 모은 기록만
    const rounds = (g.nunchi_rounds || [])
      .slice()
      .sort((x, y) => x.round - y.round)
      .map((r) => {
        const a = Object.values((r.ai && r.ai.schedule) || {})
          .map(Number)
          .sort((x, y) => x - y);
        // 누른 방법: 11/19 휴대폰 화면 이전 기록에는 input이 없음 = 키보드
        const input = r.ai && 'input' in r.ai ? r.ai.input : 'key';
        return { a, t: r.time_ms === null ? null : Number(r.time_ms), extra: r.extra_presses || 0, input };
      })
      .filter((r) => r.a.length === 3);
    if (!rounds.length) continue;
    const person = people.byGame.get(g.id) || people.byNick.get(g.nickname) || g.nickname;
    // 게임의 입력 방법 = 그 게임에서 가장 많이 쓴 방법 (한 게임은 한 기기)
    const counts = {};
    for (const r of rounds) if (r.input) counts[r.input] = (counts[r.input] || 0) + 1;
    const input = Object.keys(counts).sort((x, y) => counts[y] - counts[x])[0] || 'key';
    const skip = (people.skip && people.skip.get(g.id)) || null; // 맞추기에서 뺀 이유 (검증에는 씀)
    games.push({ id: g.id, person, nickname: g.nickname, label: g.label, input, rounds, skip });
  }
  return games;
}

// ───────── 판 → 관측값 ─────────
// 즉시형·공격형: 누른 시각 / 눈치형: 첫 AI 뒤 / 버티기형: 둘째 AI 뒤
const BASE = { instant: () => 0, fixed: () => 0, follow: (a) => a[0], hold: (a) => a[1] };
function observations(game) {
  const base = BASE[game.label];
  return game.rounds
    .filter((r) => r.extra === 0)
    .map((r) => {
      const b = base(r.a);
      if (r.t === null) return { kind: 'censored', c: r.a[2] - b }; // 셋째 AI까지 안 누름 → 기준 뒤 c 넘어서 누를 예정이었음
      if (r.t < b) return { kind: 'slip' }; // 기준 AI보다 먼저 누름 (연기 실수)
      return { kind: 'exact', x: r.t - b };
    });
}

// 게임 하나(같은 사람·같은 유형 10판)의 습관과 흔들림. 정확히 남은 시각이 3판 미만이면 null
function fitUnit(obs) {
  const xs = obs.filter((o) => o.kind === 'exact').map((o) => o.x);
  const slips = obs.filter((o) => o.kind === 'slip').length;
  if (xs.length < 3) return null;
  const m0 = median(xs);
  const s0 = Math.max(1.4826 * mad(xs), SD_FLOOR);
  const lim = Math.max(4 * s0, OUTLIER_MIN);
  const inl = xs.filter((x) => Math.abs(x - m0) <= lim);
  let outliers = xs.length - inl.length;
  // 습관보다 한참 늦은 시점까지도 안 누른 판은 실수(깜빡함), 그 밖의 판은 "c까지는 안 눌렀다"는 정보로 씀
  const cs = [];
  for (const o of obs) {
    if (o.kind !== 'censored') continue;
    if (o.c > m0 + lim) outliers++;
    else cs.push(o.c);
  }
  let mu = mean(inl);
  let sd = Math.max(Math.sqrt(variance(inl)) || s0, SD_FLOOR);
  for (let it = 0; it < 100 && cs.length; it++) {
    let s1 = sum(inl);
    let s2 = sum(inl.map((x) => x * x));
    for (const c of cs) {
      const z = (c - mu) / sd;
      const lam = phi(z) / Math.max(1 - Model.normCdf(z), 1e-12); // 중도 절단 정규분포의 기댓값 보정
      s1 += mu + sd * lam;
      s2 += mu * mu + sd * sd + sd * (c + mu) * lam;
    }
    const n = inl.length + cs.length;
    const nmu = s1 / n;
    const nsd = Math.sqrt(Math.max(s2 / n - nmu * nmu, SD_FLOOR * SD_FLOOR));
    const done = Math.abs(nmu - mu) < 0.01 && Math.abs(nsd - sd) < 0.01;
    mu = nmu;
    sd = nsd;
    if (done) break;
  }
  const n = inl.length + cs.length;
  if (cs.length) sd *= Math.sqrt(n / Math.max(1, n - 1)); // EM은 n으로 나눔 → 표본 표준편차로
  return { mu, sd: Math.max(sd, SD_FLOOR), n, exact: inl.length, censored: cs.length, outliers, slips };
}

// ───────── 유형별 숫자 맞추기 ─────────
function fitTypes(allGames, { shrink = true } = {}) {
  const games = allGames.filter((g) => !g.skip); // people.json "제외" 게임은 맞추기에서 뺌
  const def = Model.BUILTIN_PARAMS;
  const params = { types: {} };
  const stats = {};
  let lapseK = 0;
  let lapseN = 0;
  for (const label of FIT_TYPES) {
    const d = def.types[label];
    const st = { people: 0, games: 0, rounds: 0, mashed: 0, used: 0, censored: 0, slips: 0, outliers: 0 };
    const persons = new Map();
    for (const g of games.filter((x) => x.label === label)) {
      const obs = observations(g);
      st.rounds += g.rounds.length;
      st.mashed += g.rounds.length - obs.length;
      const f = fitUnit(obs);
      if (!f) continue;
      st.games++;
      st.used += f.n;
      st.censored += f.censored;
      st.slips += f.slips;
      st.outliers += f.outliers;
      lapseK += f.slips + f.outliers;
      lapseN += f.n + f.slips + f.outliers;
      if (!persons.has(g.person)) persons.set(g.person, []);
      persons.get(g.person).push(f);
    }
    // 사람마다: 흔들림은 그 사람 게임들의 안쪽 흩어짐을 합치고, 습관은 게임 평균의 평균
    const per = [...persons.values()].map((fs) => {
      const df = sum(fs.map((f) => f.n - 1));
      return { mu: mean(fs.map((f) => f.mu)), v: sum(fs.map((f) => (f.n - 1) * f.sd ** 2)) / Math.max(1, df), n: sum(fs.map((f) => f.n)), df };
    });
    const P = per.length;
    st.people = P;
    if (P) {
      const t = {};
      const noiseData = Math.sqrt(mean(per.map((p) => p.v))); // 사람마다 같은 무게
      const df = sum(per.map((p) => p.df));
      const noise = shrink ? Math.sqrt((df * noiseData ** 2 + NU_NOISE * d.noise ** 2) / (df + NU_NOISE)) : noiseData;
      t.noise = Math.round(Math.max(SD_FLOOR, noise));
      st.noiseData = noiseData;
      if (label !== 'fixed') {
        const mData = mean(per.map((p) => p.mu));
        let m = shrink ? (P * mData + K_MEAN * d.prior.mean) / (P + K_MEAN) : mData;
        if (d.meanRange) m = clamp(m, d.meanRange[0], d.meanRange[1]);
        let sd = d.prior.sd;
        if (P >= 2) {
          // 사람 차이 = 사람 평균들의 흩어짐 − 판 수가 적어서 생기는 흩어짐
          const between = variance(per.map((p) => p.mu)) - mean(per.map((p) => noiseData ** 2 / p.n));
          st.sdData = Math.sqrt(Math.max(between, 0));
          sd = shrink ? Math.sqrt(((P - 1) * st.sdData ** 2 + NU_SPREAD * d.prior.sd ** 2) / (P - 1 + NU_SPREAD)) : st.sdData;
        }
        t.prior = { mean: Math.round(m), sd: Math.round(Math.max(sd, 50)) };
        st.meanData = mData;
      }
      params.types[label] = t;
    }
    stats[label] = st;
  }
  stats.lapse = { k: lapseK, n: lapseN, data: lapseN ? lapseK / lapseN : null };
  params.lapse = round4(shrink ? (lapseK + LAPSE_PRIOR.a) / (lapseN + LAPSE_PRIOR.a + LAPSE_PRIOR.b) : lapseN ? lapseK / lapseN : def.lapse);
  return { params, stats };
}

// --only: 고른 숫자만 남김. 빠진 유형과 실수 비율은 게임에서 지금 숫자(기본값) 그대로
const ONLY_KEYS = [...FIT_TYPES, 'lapse'];
function restrict(params, only) {
  if (!only) return params;
  const out = { types: {} };
  for (const k of only) {
    if (k === 'lapse') out.lapse = params.lapse;
    else if (params.types[k]) out.types[k] = params.types[k];
  }
  return out;
}

// 랜덤형은 맞추지 않고, 실제로 어느 시각에 눌렀는지만 봄 (모델은 0~5초 고르게 가정)
function randomSummary(games) {
  const bins = [0, 0, 0, 0, 0];
  let censored = 0;
  let n = 0;
  for (const g of games.filter((x) => x.label === 'random' && !x.skip)) {
    for (const r of g.rounds.filter((x) => x.extra === 0)) {
      n++;
      if (r.t === null) censored++;
      else bins[Math.min(4, Math.floor(r.t / 1000))]++;
    }
  }
  return { n, censored, bins };
}

// ───────── 검증: 실제 게임을 판마다 다시 돌려 보기 ─────────
// 게임에서처럼 모든 판(연타한 판 포함)을 순서대로 넣고, 판마다 "보기 전에" 얼마나 잘 예상했는지 잼
// 이 판에서 참여자가 탈락했나 (AI와 0.15초 안 · 마지막). 판이 일찍 끝났어도 계획된 AI 시각으로 판정
function caught(rd) {
  const entries = [{ id: 'player', time: rd.t }, ...rd.a.map((x, i) => ({ id: `ai${i}`, time: x }))];
  return Planner.judge(entries, Planner.DEFAULTS.windowMs)[0].out;
}

function evaluate(games, params) {
  const r = { games: 0, rounds: 0, ll: 0, hit: 0, hitN: 0, acc3: 0, accEnd: 0, labeled: 0, falseSwitch: 0, pSum: 0, ySum: 0, brier: 0 };
  for (const g of games) {
    const labeled = ALL_TYPES.includes(g.label);
    let b = Model.createBelief(params);
    let switched = false;
    g.rounds.forEach((rd, i) => {
      const obs = rd.t !== null ? { pressed: true, t: rd.t } : { pressed: false, censorAt: rd.a[2] };
      r.ll += Model.obsLogLik(b, rd.a, obs, params);
      r.rounds++;
      // 점수 공정성: 판 시작 전 "AI 포획 예상"과 실제로 잡혔는지
      const p = Planner.evaluate(b, rd.a, {}, params).pCatch;
      const y = caught(rd) ? 1 : 0;
      r.pSum += p;
      r.ySum += y;
      r.brier += (p - y) ** 2;
      const res = Model.update(b, rd.a, obs, params);
      if (i >= 3 && obs.pressed) {
        r.hit += res.lastHit;
        r.hitN++;
      }
      if (res.switched) switched = true;
      b = res.belief;
      if (labeled) {
        const top = Model.ranking(b)[0].id;
        if (i === 2 && top === g.label) r.acc3++;
        if (i === g.rounds.length - 1 && top === g.label) r.accEnd++;
      }
    });
    r.games++;
    if (labeled) {
      r.labeled++;
      if (switched) r.falseSwitch++;
    }
  }
  return {
    games: r.games,
    rounds: r.rounds,
    llPerRound: r.ll / Math.max(1, r.rounds),
    read: r.hitN ? r.hit / r.hitN : NaN,
    acc3: r.labeled ? r.acc3 / r.labeled : NaN,
    accEnd: r.labeled ? r.accEnd / r.labeled : NaN,
    falseSwitch: r.falseSwitch,
    labeled: r.labeled,
    pCatch: r.pSum / Math.max(1, r.rounds), // AI 포획 예상 평균
    caught: r.ySum / Math.max(1, r.rounds), // 실제로 잡힌 비율
    brier: r.brier / Math.max(1, r.rounds), // 예상과 결과의 차이 (작을수록 정확)
  };
}

// 한 사람씩 빼고 맞춘 뒤, 뺀 사람의 게임으로 확인 (사람 2명 이상일 때)
function leaveOnePersonOut(games, current, only) {
  const persons = [...new Set(games.filter((g) => FIT_TYPES.includes(g.label)).map((g) => g.person))];
  if (persons.length < 2) return null;
  const now = [];
  const fit = [];
  for (const p of persons) {
    const test = games.filter((g) => g.person === p);
    const cand = Model.withParams(restrict(fitTypes(games.filter((g) => g.person !== p)).params, only));
    now.push({ w: test.length, e: evaluate(test, current) });
    fit.push({ w: test.length, e: evaluate(test, cand) });
  }
  const pool = (xs) => {
    const w = sum(xs.map((x) => x.e.rounds));
    const wl = sum(xs.map((x) => x.e.labeled));
    return {
      llPerRound: sum(xs.map((x) => x.e.llPerRound * x.e.rounds)) / w,
      read: mean(xs.map((x) => x.e.read).filter(Number.isFinite)),
      acc3: sum(xs.map((x) => x.e.acc3 * x.e.labeled)) / wl,
      accEnd: sum(xs.map((x) => x.e.accEnd * x.e.labeled)) / wl,
      falseSwitch: sum(xs.map((x) => x.e.falseSwitch)),
      labeled: wl,
      pCatch: sum(xs.map((x) => x.e.pCatch * x.e.rounds)) / w,
      caught: sum(xs.map((x) => x.e.caught * x.e.rounds)) / w,
      brier: sum(xs.map((x) => x.e.brier * x.e.rounds)) / w,
    };
  };
  return { persons: persons.length, now: pool(now), fit: pool(fit) };
}

// ───────── 보고서 ─────────
function typeLine(label, st, cur, cand, fitted, applied = true) {
  const txt = (t) => (label === 'fixed' ? `흔들림 ${t.noise}` : `${t.prior.mean}±${t.prior.sd}, 흔들림 ${t.noise}`);
  const curTxt = txt(cur.types[label]);
  const newTxt = applied ? txt(cand.types[label]) : `${txt(cand.types[label])} (--only에 없어 기본값 · 맞춘 값 ${txt(fitted.types[label])})`;
  const dataTxt = label === 'fixed' ? `흔들림 ${ms(st.noiseData)}` : `${ms(st.meanData)} / ${ms(st.sdData)} / ${ms(st.noiseData)}`;
  return `${NAME[label].padEnd(5)} | ${String(st.people).padStart(2)}명 ${String(st.games).padStart(2)}게임 ${String(st.used).padStart(3)}판 | 연타 ${st.mashed} · 시각 안 남음 ${st.censored} · 실수 ${
    st.slips + st.outliers
  } | ${dataTxt.padEnd(16)} | ${curTxt.padEnd(20)} → ${newTxt}`;
}

function evalLines(title, now, fit) {
  const x = Math.exp(fit.llPerRound - now.llPerRound);
  return [
    `  ${title}`,
    `    실제 입력을 판마다 미리 예상한 정도: 새 숫자가 ${x >= 1 ? `${x.toFixed(2)}배 높게` : `${(1 / x).toFixed(2)}배 낮게`} 예상 (평균 log ${now.llPerRound.toFixed(2)} → ${fit.llPerRound.toFixed(2)})`,
    `    읽힌 정도(4판부터, 실제 시각 ±0.25초에 건 확률): ${pct(now.read)} → ${pct(fit.read)}`,
    `    연기한 유형 정답률 3판 · 마지막 판: ${pct(now.acc3)} · ${pct(now.accEnd)} → ${pct(fit.acc3)} · ${pct(fit.accEnd)}`,
    `    전략을 안 바꿨는데 "바꿨네?"가 뜬 게임: ${now.falseSwitch} → ${fit.falseSwitch} (유형을 정한 ${fit.labeled ?? now.labeled}게임 중)`,
    `    AI 포획 예상 평균 vs 실제로 잡힌 비율 (점수 공정성): ${pct(now.pCatch)} vs ${pct(now.caught)} → ${pct(fit.pCatch)} vs ${pct(fit.caught)} · 차이 점수 ${now.brier.toFixed(3)} → ${fit.brier.toFixed(3)} (작을수록 정확)`,
  ];
}

function report(games, fitResult, current, candidate, only) {
  const lines = [];
  const people = [...new Set(games.map((g) => g.person))];
  const rounds = sum(games.map((g) => g.rounds.length));
  const mashed = sum(games.map((g) => g.rounds.filter((r) => r.extra > 0).length));
  lines.push(`\n■ 수집 기록: 사람 ${people.length}명 · 게임 ${games.length} · 판 ${rounds} (연타 ${mashed}판은 숫자 맞추기에서 뺌)`);
  for (const p of people) {
    const gs = games.filter((g) => g.person === p);
    const by = [...ALL_TYPES, 'free'].map((l) => [l, gs.filter((g) => g.label === l).length]).filter(([, n]) => n);
    lines.push(`  ${p}: ${gs.length}게임 (${by.map(([l, n]) => `${NAME[l]} ${n}`).join(' · ')})`);
  }
  const skipped = games.filter((g) => g.skip);
  if (skipped.length) {
    lines.push(`  숫자 맞추기에서 뺀 게임 ${skipped.length}개 (people.json "제외", 검증에는 넣음):`);
    for (const g of skipped) lines.push(`    ${g.id} · ${g.person} · ${NAME[g.label] || g.label} — ${g.skip}`);
  }
  // 입력 방법별: 터치(휴대폰)는 화면 반응이 늦어 시각이 키보드보다 늦게 찍힐 수 있음
  const inputs = [...new Set(games.map((g) => g.input))];
  lines.push(`  입력: ${inputs.map((k) => `${INPUT_NAME[k] || k} ${games.filter((g) => g.input === k).length}게임`).join(' · ')}`);
  if (inputs.includes('key') && inputs.includes('touch')) {
    const part = (k) => fitTypes(games.filter((g) => g.input === k), { shrink: false }).stats;
    const ks = part('key');
    const ts = part('touch');
    const cmp = FIT_TYPES.filter((l) => ks[l].people && ts[l].people).map((l) =>
      l === 'fixed' ? `${NAME[l]} 흔들림 ${ms(ks[l].noiseData)} vs ${ms(ts[l].noiseData)}` : `${NAME[l]} ${ms(ks[l].meanData)} vs ${ms(ts[l].meanData)}`
    );
    if (cmp.length) {
      lines.push(`  키보드 vs 터치 (습관, ms): ${cmp.join(' · ')}`);
      lines.push('  차이가 크면 --input key (부스) 또는 --input touch (휴대폰)로 나눠 맞춰 보세요.');
    }
  }
  lines.push('\n■ 유형별 숫자 (ms) — 데이터: 습관 / 사람 차이 / 흔들림 · 지금 숫자 → 새 숫자(사람이 적으면 기본값 쪽으로 당김)');
  if (only) lines.push(`  --only ${only.join(',')}: 고른 숫자만 바꾸고 나머지는 model.js 기본값`);
  for (const label of FIT_TYPES) {
    const st = fitResult.stats[label];
    if (!st.people) lines.push(`${NAME[label].padEnd(5)} | 쓸 수 있는 기록 없음 → 지금 숫자 그대로`);
    else lines.push(typeLine(label, st, current, candidate, fitResult.params, !only || only.includes(label)));
  }
  const ls = fitResult.stats.lapse;
  const lapseTxt = !only || only.includes('lapse') ? `새 숫자 ${pct(candidate.lapse)}` : `${pct(candidate.lapse)} (--only에 없어 기본값 · 맞춘 값 ${pct(fitResult.params.lapse)})`;
  lines.push(`실수 비율: 데이터 ${ls.k}/${ls.n}판 = ${pct(ls.data)} · 지금 ${pct(current.lapse)} → ${lapseTxt}`);
  const rs = randomSummary(games);
  if (rs.n) {
    lines.push(
      `랜덤형 누른 시각 (${rs.n}판): ${rs.bins.map((b, i) => `${i}~${i + 1}초 ${b}`).join(' · ')} · 시각 안 남음 ${rs.censored} (모델은 0~5초 고르게 가정, 셋째 AI가 누르면 판이 끝나 4초 넘는 시각은 잘 안 남음)`
    );
  }
  lines.push('\n■ 검증: 실제 게임을 판마다 다시 돌려 보기 (지금 숫자 → 새 숫자)');
  lines.push(...evalLines('같은 기록으로 맞추고 같은 기록으로 확인 (실제보다 좋게 나옴)', evaluate(games, current), evaluate(games, candidate)));
  const loo = leaveOnePersonOut(games, current, only);
  if (loo) lines.push(...evalLines(`한 사람씩 빼고 맞춘 뒤 그 사람으로 확인 (${loo.persons}명, 실제 성능에 가까움)`, loo.now, loo.fit));
  else lines.push('  한 사람씩 빼고 확인하려면 2명 이상의 기록이 필요해요.');
  const usedTypes = FIT_TYPES.filter((l) => !only || only.includes(l));
  const minPeople = Math.min(...(usedTypes.length ? usedTypes : FIT_TYPES).map((l) => fitResult.stats[l].people));
  lines.push('\n■ 적용 판단');
  if (minPeople >= 3) lines.push(`  ${only ? '고른' : '모든'} 유형에 3명 이상 모였어요. 검증 결과가 좋아졌다면 --apply로 적용해도 좋아요.`);
  else lines.push(`  유형에 따라 ${minPeople}명뿐이라, 새 숫자는 기본값 쪽으로 많이 당겨진 값이에요. 3명 이상 모이면 다시 맞추는 걸 권장해요.`);
  lines.push('  적용 전에 밸런스 확인: SIM_PARAMS=prototype/sim/results/params-candidate.json SIM_PLAYERS=params node prototype/sim/run.js 150 1');
  return lines.join('\n');
}

// ───────── 정답을 아는 가상 데이터로 점검 ─────────
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

function selftest(people = 12, seed = 7) {
  const TRUE = {
    instant: { mean: 150, sd: 40, noise: 45 },
    fixed: { noise: 80 },
    follow: { mean: 280, sd: 50, noise: 45 },
    hold: { mean: 440, sd: 80, noise: 140 },
    lapse: 0.06,
    mash: 0.1,
  };
  const r = rng(seed);
  const games = [];
  const habits = { instant: [], follow: [], hold: [] }; // 실제로 뽑힌 사람별 습관 (도구는 이 평균을 되찾아야 함)
  for (let p = 0; p < people; p++) {
    const habit = {
      instant: Math.max(60, TRUE.instant.mean + TRUE.instant.sd * gauss(r)),
      follow: Math.max(120, TRUE.follow.mean + TRUE.follow.sd * gauss(r)),
      hold: Math.max(150, TRUE.hold.mean + TRUE.hold.sd * gauss(r)),
    };
    for (const k of Object.keys(habits)) habits[k].push(habit[k]);
    for (const label of ALL_TYPES) {
      for (let k = 0; k < 2; k++) {
        const target = 800 + 2700 * r(); // 공격형: 게임마다 정한 시각
        const rounds = [];
        for (let i = 0; i < 10; i++) {
          const a = Planner.randomSchedule({ totalRounds: 10 }, r);
          let t;
          if (label === 'instant') t = habit.instant + TRUE.instant.noise * gauss(r);
          else if (label === 'fixed') t = target + TRUE.fixed.noise * gauss(r);
          else if (label === 'follow') t = a[0] + habit.follow + TRUE.follow.noise * gauss(r);
          else if (label === 'hold') t = a[1] + habit.hold + TRUE.hold.noise * gauss(r);
          else t = 5000 * r();
          if (label !== 'random' && r() < TRUE.lapse) t = 5000 * r();
          t = Math.max(20, t);
          const extra = r() < TRUE.mash ? 1 + Math.floor(5 * r()) : 0;
          rounds.push({ a, t: t >= a[2] ? null : t, extra }); // 셋째 AI 뒤에 누르려 했으면 판이 끝나 시각이 안 남음
        }
        games.push({ id: `s${p}-${label}-${k}`, person: `가상${p + 1}`, nickname: `가상${p + 1}`, label, rounds });
      }
    }
  }
  const raw = fitTypes(games, { shrink: false });
  console.log(`\n■ 도구 점검: 정답을 아는 가상 사람 ${people}명 × 유형별 2게임 (실수 ${pct(TRUE.lapse)}, 연타 ${pct(TRUE.mash)} 섞음)`);
  console.log('정답 = 실제로 뽑힌 가상 사람들의 습관 평균·차이 (설정값은 괄호)');
  console.log('유형     | 정답: 습관 / 사람 차이 / 흔들림 | 도구가 찾은 값 (기본값으로 당기기 전) | 시각만 평균 낸 값');
  let ok = true;
  for (const label of FIT_TYPES) {
    const tr =
      label === 'fixed'
        ? TRUE.fixed
        : { mean: mean(habits[label]), sd: Math.sqrt(variance(habits[label])), noise: TRUE[label].noise, setMean: TRUE[label].mean, setSd: TRUE[label].sd };
    const st = raw.stats[label];
    const naive = mean(
      games
        .filter((g) => g.label === label)
        .flatMap((g) => observations(g))
        .filter((o) => o.kind === 'exact' && (label === 'fixed' || o.x < 1500))
        .map((o) => o.x)
    );
    const found = label === 'fixed' ? `흔들림 ${ms(st.noiseData)}` : `${ms(st.meanData)} / ${ms(st.sdData)} / ${ms(st.noiseData)}`;
    const truth = label === 'fixed' ? `흔들림 ${tr.noise}` : `${ms(tr.mean)}(${tr.setMean}) / ${ms(tr.sd)}(${tr.setSd}) / ${tr.noise}`;
    console.log(`${NAME[label].padEnd(5)} | ${truth.padEnd(26)} | ${found.padEnd(30)} | ${label === 'fixed' ? '-' : ms(naive)}`);
    if (label !== 'fixed' && Math.abs(st.meanData - tr.mean) > Math.max(25, 0.08 * tr.mean)) ok = false;
    if (Math.abs(st.noiseData - tr.noise) > 0.25 * tr.noise) ok = false;
  }
  console.log(`실수 비율: 정답 ${pct(TRUE.lapse)} · 도구 ${pct(raw.stats.lapse.data)}`);
  console.log(ok ? '\n✔ 도구가 정답 숫자를 허용 범위 안에서 되찾았어요.' : '\n✘ 정답과 차이가 커요. 도구를 점검해야 해요.');
  return ok;
}

// ───────── 실행 ─────────
function parseArgs(argv) {
  const a = { people: path.join(__dirname, 'people.json') };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--apply') a.apply = true;
    else if (k === '--selftest') a.selftest = true;
    else if (k === '--people') a.people = argv[++i];
    else if (k === '--file') a.file = argv[++i];
    else if (k === '--save') a.save = argv[++i];
    else if (k === '--input') a.input = argv[++i];
    else if (k === '--only') a.only = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
  }
  return a;
}

function writeParamsFile(params, meta) {
  const data = { version: params.version, meta, lapse: params.lapse, types: params.types };
  const changed = meta.only ? `${meta.only.map((k) => (k === 'lapse' ? '실수 비율' : NAME[k])).join('·')}만 (나머지는 model.js 기본값)` : '모든 유형 + 실수 비율';
  const skipped = meta.skipped.length ? ` · 맞추기에서 뺀 게임 ${meta.skipped.length}개 (people.json "제외")` : '';
  const body = `// AI가 쓰는 숫자 — 숫자 맞추기 도구가 만드는 파일입니다. 손으로 고치지 마세요.
//   만든 때: ${meta.fittedAt} · 수집 기록: 사람 ${meta.people}명, 게임 ${meta.games}, 판 ${meta.rounds}${skipped}
//   바꾼 숫자: ${changed}
//   만들기: node prototype/sim/fit.js --apply${meta.only ? ` --only ${meta.only.join(',')}` : ''}   ·   되돌리기: 아래 값을 null로 두거나 git에서 이전 버전으로
// null이면 model.js의 기본값(BUILTIN_PARAMS)을 그대로 씁니다.
(function (root, data) {
  if (typeof module === 'object' && module.exports) module.exports = data;
  else root.NunchiParams = data;
})(typeof globalThis !== 'undefined' ? globalThis : this, ${JSON.stringify(data, null, 2)});
`;
  fs.writeFileSync(PARAMS_FILE, body);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selftest) {
    process.exitCode = selftest() ? 0 : 1;
    return;
  }
  const raw = args.file ? JSON.parse(fs.readFileSync(args.file, 'utf8')) : await loadFromSupabase();
  if (args.save) fs.writeFileSync(args.save, JSON.stringify(raw));
  let games = normalize(raw, loadPeople(args.people));
  if (args.input && args.input !== 'all') games = games.filter((g) => g.input === args.input);
  if (!games.length) {
    console.log(`수집 모드 기록이 아직 없어요${args.input && args.input !== 'all' ? ` (입력: ${INPUT_NAME[args.input] || args.input})` : ''}.`);
    return;
  }
  if (args.only) {
    const bad = args.only.filter((k) => !ONLY_KEYS.includes(k));
    if (bad.length || !args.only.length) {
      console.error(`--only 에 쓸 수 있는 값: ${ONLY_KEYS.join(', ')} (받은 값: ${bad.join(', ') || '없음'})`);
      process.exitCode = 1;
      return;
    }
  }
  const fitResult = fitTypes(games);
  const people = new Set(games.map((g) => g.person)).size;
  const date = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }); // 한국 날짜 YYYY-MM-DD
  const candidateParams = {
    ...restrict(fitResult.params, args.only),
    version: `fit-${date.replace(/-/g, '')}-p${people}${args.only ? `-${args.only.join('+')}` : ''}`,
  };
  const current = Model.DEFAULT_PARAMS;
  const candidate = Model.withParams(candidateParams);
  console.log(report(games, fitResult, current, candidate, args.only));

  const meta = {
    fittedAt: date,
    people,
    games: games.length,
    rounds: sum(games.map((g) => g.rounds.length)),
    input: args.input || 'all',
    only: args.only || null,
    skipped: games.filter((g) => g.skip).map((g) => g.id),
  };
  fs.mkdirSync(RESULTS, { recursive: true });
  fs.writeFileSync(path.join(RESULTS, 'params-candidate.json'), JSON.stringify({ ...candidateParams, meta }, null, 2) + '\n');
  fs.writeFileSync(
    path.join(RESULTS, 'fit-latest.json'),
    JSON.stringify(
      { meta, current: current.version, candidate: candidateParams, fitted: fitResult.params, stats: fitResult.stats, random: randomSummary(games) },
      null,
      2
    ) + '\n'
  );
  console.log('\n후보 숫자: prototype/sim/results/params-candidate.json');
  if (args.apply) {
    writeParamsFile(candidateParams, meta);
    console.log(`적용: public/ai/params.js 를 ${candidateParams.version} 로 바꿨어요. 커밋·배포하면 게임에 반영돼요.`);
  } else {
    console.log('게임에 반영하려면 --apply 를 붙여 다시 실행하세요.');
  }
}

// 다른 도구에서 계산만 가져다 쓸 수 있게 (node -e "require('./prototype/sim/fit.js')")
module.exports = { normalize, loadPeople, observations, fitUnit, fitTypes, restrict, evaluate, randomSummary };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
