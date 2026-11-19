// AI 눈치게임 — 플레이어 모델
// 참여자가 "어떤 유형인지(확률)"와 "그 유형 안에서 어떤 숫자를 가졌는지(개인 숫자)"를 판마다 갱신합니다.
// 브라우저에서는 window.NunchiModel, Node(시뮬레이터)에서는 require('./model.js')로 똑같이 씁니다.
//
// 유형별 "누르는 방식" (t = 누른 시각, ms)
//   즉시형   t ≈ μ              시작 신호만 보고 누름 (μ는 0.2초 근처)
//   공격형   t ≈ μ              자기가 정해 둔 시각에 누름 (μ는 사람마다 다름)
//   눈치형   t ≈ 첫째 AI + d     첫 AI가 누른 걸 보고 따라 누름
//   버티기형 t ≈ 둘째 AI + d     둘째 AI가 누른 걸 보고 누름 (꼴찌 바로 앞 자리)
//   랜덤형   0~5초 아무 때나
// μ, d가 개인 숫자입니다. 아래 숫자들은 아직 기본값이며, 수집 모드 데이터로 다시 맞춥니다 (version).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NunchiModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TYPES = [
    { id: 'instant', name: '즉시형', base: 'start' },
    { id: 'fixed', name: '공격형', base: 'start' },
    { id: 'follow', name: '눈치형', base: 'ai1' },
    { id: 'hold', name: '버티기형', base: 'ai2' },
    { id: 'random', name: '랜덤형', base: null },
  ];

  const DEFAULT_PARAMS = {
    version: 'default-2026-11-19-switch',
    roundMs: 5000,
    lapse: 0.05, // 어떤 유형이든 가끔 엉뚱하게 누를 확률 (0~5초 균등분포로 섞음)
    decay: 0.7, // 최근 판 가중치: 매 판 이전 판단에 곱하는 값 (작을수록 빨리 잊음). 시뮬레이터로 0.6~0.8 비교 후 선택
    floor: 0.03, // 매 판 판단에 '고른 분포'를 3%만큼 섞음 → 어떤 유형도 0.6%(= 3% ÷ 5유형) 밑으로는 내려가지 않음
    drift: 100, // 판마다 개인 숫자가 바뀔 수 있는 정도 (ms)
    // 전략 변경 감지: 최근 switchWindow판을 '처음부터 새로 읽은 판단'이 지금 판단보다 e^switchMargin배 넘게 잘 맞혔으면
    // 전략을 바꿨다고 보고 새 판단으로 갈아탐. switchWindow: 0이면 끔
    switchWindow: 2,
    switchMargin: 2,
    switchMinRounds: 4, // 이 판 수 이상 본 뒤부터 확인 (그 전에는 비교할 '습관'이 아직 없음)
    hitToleranceMs: 250, // "예측 적중" 기준: AI 예상과 실제 차이가 이 안이면 적중
    types: {
      instant: { prior: { mean: 220, sd: 80 }, noise: 80, meanRange: [50, 600] }, // 즉시형은 정의상 0.6초 안
      fixed: { prior: { mean: 1600, sd: 900 }, noise: 220 },
      follow: { prior: { mean: 450, sd: 150 }, noise: 110 },
      hold: { prior: { mean: 450, sd: 150 }, noise: 130 },
    },
  };

  // ───────── 수학 도구 ─────────
  function erf(x) {
    // Abramowitz & Stegun 7.1.26 (오차 1.5e-7)
    const sign = x < 0 ? -1 : 1;
    const ax = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * ax);
    const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
    return sign * y;
  }
  const normCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
  const normPdf = (z) => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);

  function softmax(logs) {
    const max = Math.max(...logs);
    const ex = logs.map((v) => Math.exp(v - max));
    const sum = ex.reduce((a, b) => a + b, 0);
    return ex.map((v) => v / sum);
  }

  // schedule: AI 3명이 누를 시각 [a1, a2, a3] (오름차순)
  function baseTime(type, schedule) {
    if (type.base === 'ai1') return schedule[0];
    if (type.base === 'ai2') return schedule[1];
    return 0;
  }

  // ───────── 판단 상태 ─────────
  function createBelief(params = DEFAULT_PARAMS) {
    const n = TYPES.length;
    const personal = {};
    for (const type of TYPES) {
      if (type.id === 'random') continue;
      const prior = params.types[type.id].prior;
      personal[type.id] = { mean: prior.mean, sd: prior.sd };
    }
    return {
      probs: TYPES.map(() => 1 / n),
      logw: TYPES.map(() => Math.log(1 / n)),
      personal,
      rounds: 0,
      lastHit: null,
      history: [], // 최근 판 기록 (전략 변경 감지용): { schedule, obs, ll }
      switchedAt: null, // 마지막으로 전략 변경을 감지한 판
    };
  }

  // 유형 k라면 이번 작전에서 누를 시각의 분포 (정규분포의 평균, 표준편차)
  function typeGaussian(belief, k, schedule, params) {
    const type = TYPES[k];
    const p = belief.personal[type.id];
    const noise = params.types[type.id].noise;
    return { mean: baseTime(type, schedule) + p.mean, sd: Math.sqrt(p.sd * p.sd + params.drift * params.drift + noise * noise) };
  }

  // 이번 작전에서 "언제 누를지" 예측 = 유형 확률 × 유형별 분포의 합 (+ 엉뚱하게 누를 확률)
  function predictive(belief, schedule, params = DEFAULT_PARAMS) {
    const comps = [];
    let uniform = params.lapse;
    TYPES.forEach((type, k) => {
      const w = belief.probs[k] * (1 - params.lapse);
      if (type.id === 'random') {
        uniform += w;
        return;
      }
      const g = typeGaussian(belief, k, schedule, params);
      comps.push({ weight: w, mean: g.mean, sd: g.sd, type: type.id });
    });
    return { comps, uniform, roundMs: params.roundMs };
  }

  // 예측에서 lo~hi 사이에 누를 확률. 0초 이전 꼬리는 0초에, 5초 이후 꼬리는 hi=Infinity일 때만 포함
  function massBetween(mix, lo, hi) {
    let m = 0;
    for (const c of mix.comps) {
      const upper = hi === Infinity ? 1 : normCdf((hi - c.mean) / c.sd);
      const lower = lo <= 0 ? 0 : normCdf((lo - c.mean) / c.sd);
      if (upper > lower) m += c.weight * (upper - lower);
    }
    const uLo = Math.max(0, lo);
    const uHi = Math.min(mix.roundMs, hi);
    if (uHi > uLo) m += (mix.uniform * (uHi - uLo)) / mix.roundMs;
    return m;
  }

  // 가장 누를 것 같은 시각 (10ms 간격으로 찾기). 읽을 만한 근거가 없으면 null
  function mode(mix) {
    let best = null;
    let bestD = 0;
    for (let t = 0; t < mix.roundMs; t += 10) {
      let d = 0;
      for (const c of mix.comps) d += (c.weight * normPdf((t - c.mean) / c.sd)) / c.sd;
      if (d > bestD) {
        bestD = d;
        best = t;
      }
    }
    return bestD > 0 ? best : null;
  }

  // obs: { pressed: true, t } 또는 { pressed: false, censorAt } (censorAt까지 안 누름 = 마지막)
  function typeLikelihood(belief, k, schedule, obs, params) {
    const type = TYPES[k];
    const R = params.roundMs;
    if (type.id === 'random') return obs.pressed ? 1 / R : Math.max(1e-6, 1 - obs.censorAt / R);
    const g = typeGaussian(belief, k, schedule, params);
    if (obs.pressed) return ((1 - params.lapse) * normPdf((obs.t - g.mean) / g.sd)) / g.sd + params.lapse / R;
    return (1 - params.lapse) * (1 - normCdf((obs.censorAt - g.mean) / g.sd)) + params.lapse * Math.max(0, 1 - obs.censorAt / R);
  }

  // 판 시작 전 판단으로 봤을 때 이번 입력이 나올 가능성 (log). 눌렀으면 1ms당 확률밀도, 안 눌렀으면 확률
  function obsLogLik(belief, schedule, obs, params = DEFAULT_PARAMS) {
    let p = 0;
    TYPES.forEach((_, k) => (p += belief.probs[k] * typeLikelihood(belief, k, schedule, obs, params)));
    return Math.log(Math.max(p, 1e-300));
  }

  // 한 판이 끝난 뒤 판단 갱신 (+ 전략 변경 감지)
  function update(belief, schedule, obs, params = DEFAULT_PARAMS) {
    const ll = obsLogLik(belief, schedule, obs, params); // 판 시작 전 판단이 이번 입력을 얼마나 예상했나
    const res = step(belief, schedule, obs, params);
    const keep = Math.max(params.switchWindow || 0, 1);
    const history = [...(belief.history || []), { schedule, obs, ll }].slice(-keep);
    let next = { ...res.belief, history, switchedAt: belief.switchedAt ?? null };

    const sw = checkSwitch(next, params);
    if (sw.switched) next = { ...sw.belief, rounds: next.rounds, history, switchedAt: next.rounds };
    return { belief: next, likelihoods: res.likelihoods, lastHit: res.lastHit, switched: sw.switched, switchScore: sw.score };
  }

  // 전략 변경 감지: 최근 K판을 두 판단이 각각 '보기 전에' 얼마나 잘 예상했는지 비교
  //   지금 판단: 처음부터 쌓아 온 판단 (판마다 기록해 둔 ll)
  //   새 판단:   K판 전부터 아무것도 모르는 상태로 다시 읽기 시작한 판단
  // 새 판단이 e^margin배 넘게 잘 맞혔으면 → 예전 습관을 버리고 새 판단으로 갈아탐
  function checkSwitch(belief, params) {
    const K = params.switchWindow || 0;
    const n = belief.rounds;
    const sinceLast = belief.switchedAt === null ? Infinity : n - belief.switchedAt;
    if (!K || n < Math.max(params.switchMinRounds, K + 1) || sinceLast < K || belief.history.length < K) {
      return { switched: false, score: null };
    }
    const recent = belief.history.slice(-K);
    let fresh = createBelief(params);
    let llFresh = 0;
    for (const h of recent) {
      llFresh += obsLogLik(fresh, h.schedule, h.obs, params);
      fresh = step(fresh, h.schedule, h.obs, params).belief; // lastHit도 새 판단 기준으로 남음 (예전 판단의 큰 실수로 다시 떠보지 않게)
    }
    const llNow = recent.reduce((s, h) => s + h.ll, 0);
    const score = llFresh - llNow;
    return { switched: score > params.switchMargin, score, belief: fresh };
  }

  // 판단 갱신 한 번 (베이즈 + 최근 판 가중치 + 개인 숫자 갱신)
  function step(belief, schedule, obs, params) {
    const L = TYPES.map((_, k) => typeLikelihood(belief, k, schedule, obs, params));

    // 이번 판 예측이 얼마나 맞았나: 실제 시각 ±hitTolerance 안에 걸었던 확률 (안 눌렀으면 '그때까지 안 누를' 확률)
    const mix = predictive(belief, schedule, params);
    const tol = params.hitToleranceMs;
    const lastHit = obs.pressed ? massBetween(mix, obs.t - tol, obs.t + tol) : massBetween(mix, obs.censorAt, Infinity);

    // 1) 유형 확률: 점수 ← decay(0.7) × 이전 점수 + log(이번 입력이 그 유형에서 나올 가능성)
    const posterior = softmax(belief.logw.map((lw, k) => params.decay * lw + Math.log(Math.max(L[k], 1e-300))));
    const probs = posterior.map((p) => (1 - params.floor) * p + params.floor / TYPES.length);

    // 2) 개인 숫자: 유형마다 "이 유형이라면" 기준으로 갱신하되, 그 유형일 가능성만큼만 반영
    //    (가능성이 낮은 유형의 숫자를 엉뚱한 곳에 굳히지 않아야, 전략을 바꿨을 때 다시 따라갈 수 있음)
    const personal = {};
    TYPES.forEach((type, k) => {
      if (type.id === 'random') return;
      const prior = belief.personal[type.id];
      const priorVar = prior.sd * prior.sd + params.drift * params.drift; // 판마다 조금씩 바뀔 수 있음
      personal[type.id] = { mean: prior.mean, sd: Math.sqrt(priorVar) };
      if (!obs.pressed) return;
      const x = obs.t - baseTime(type, schedule);
      if (type.base !== 'start' && (x < 0 || x > 2500)) return; // 기준 AI보다 먼저 눌렀다면 이 유형의 숫자는 그대로
      const weight = posterior[k];
      if (weight < 1e-4) return;
      const noiseVar = params.types[type.id].noise ** 2 / weight;
      const postVar = 1 / (1 / priorVar + 1 / noiseVar);
      let mean = postVar * (prior.mean / priorVar + x / noiseVar);
      const limit = params.types[type.id].meanRange;
      if (limit) mean = Math.min(limit[1], Math.max(limit[0], mean));
      personal[type.id] = { mean, sd: Math.min(Math.sqrt(postVar), params.types[type.id].prior.sd * 1.5) };
    });

    return {
      belief: {
        probs,
        logw: probs.map((p) => Math.log(p)),
        personal,
        rounds: belief.rounds + 1,
        lastHit,
        history: belief.history || [],
        switchedAt: belief.switchedAt ?? null,
      },
      likelihoods: L,
      lastHit,
    };
  }

  // ───────── 보여주기용 ─────────
  function ranking(belief) {
    return TYPES.map((t, k) => ({ id: t.id, name: t.name, prob: belief.probs[k] })).sort((a, b) => b.prob - a.prob);
  }

  function describe(belief) {
    const top = ranking(belief)[0];
    const p = belief.personal[top.id];
    const sec = (ms) => (ms / 1000).toFixed(2);
    const text = {
      instant: `시작하자마자 약 ${sec(p?.mean ?? 0)}초에 누르는 습관`,
      fixed: `매번 약 ${sec(p?.mean ?? 0)}초쯤에 누르는 습관`,
      follow: `첫 AI가 누르고 약 ${sec(p?.mean ?? 0)}초 뒤에 따라 누르는 습관`,
      hold: `두 번째 AI가 누르고 약 ${sec(p?.mean ?? 0)}초 뒤에 누르는 습관`,
      random: '종잡을 수 없는 타이밍',
    }[top.id];
    return { ...top, text, readable: top.id !== 'random' };
  }

  return {
    TYPES,
    DEFAULT_PARAMS,
    normCdf,
    createBelief,
    predictive,
    massBetween,
    mode,
    obsLogLik,
    update,
    ranking,
    describe,
  };
});
