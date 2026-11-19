// AI 눈치게임 — 작전 계산기
// 판이 시작되기 전에 AI 3명이 누를 시각을 정합니다. 사람 입력은 보지 않습니다(공정함).
//   1) 후보: AI 3명 시각 조합 (0.1초 간격)
//   2) 공정 규칙: AI끼리 간격 · 가장 늦은 AI는 3초 이후 · 살아남을 수 있는 시간 1초 이상
//   3) 포획 확률: 플레이어 모델의 예측으로 "이 작전이면 잡힐 확률"을 계산
//   4) 고르기: 1~3판은 떠보기(탐색), 4판부터는 목표 포획 확률에 맞춰 공략
// 브라우저에서는 window.NunchiPlanner, Node(시뮬레이터)에서는 require('./planner.js')
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const Model = isNode ? require('./model.js') : root.NunchiModel;
  const api = factory(Model);
  if (isNode) module.exports = api;
  else root.NunchiPlanner = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Model) {
  'use strict';

  const DEFAULTS = {
    roundMs: 5000,
    windowMs: 150, // 동시 입력 판정 간격
    aiMinMs: 100, // AI가 누를 수 있는 가장 이른 시각
    aiMaxMs: 4700, // AI가 누를 수 있는 가장 늦은 시각
    gridMs: 100, // 후보 시각 간격
    minGapMs: 180, // 공정 규칙: AI끼리 최소 간격 (서로 부딪히지 않게)
    lateMinMs: 3000, // 공정 규칙: 가장 늦은 AI는 이 시각 이후 (일찍 몰아서 누르는 꼼수 금지)
    minSafeMs: 1000, // 공정 규칙: 살아남을 수 있는 시간이 합쳐서 이만큼은 남아야 함
    totalRounds: 10,
    probeRounds: 3, // 떠보기 판 수
    probeA1: [
      [600, 900],
      [1800, 2200],
      [1100, 1400],
    ], // 떠보기 판마다 첫 AI가 누를 구간 (일찍 / 늦게 / 중간)
    probeGapMs: 700, // 떠보기: 첫째·둘째 AI 간격을 벌려 눈치형과 버티기형을 구분
    probeTarget: 0.4, // 떠보기 판의 목표 포획 확률
    reprobeBelow: 0.2, // 공략 중 예측이 이만큼도 안 맞으면(전략을 바꾼 듯) 다음 판에 다시 떠봄
    reprobeRandomMax: 0.5, // 단, 이미 랜덤형으로 보는 확률이 이 이상이면 다시 떠봐도 소용없으니 생략
    // 전략 변경을 감지한 다음 판에도 다시 떠볼지. 시뮬레이터에서 떠보면 그 사이 플레이어가 더 살아남아(목표 포획 40%)
    // 끔: 감지하면 새로 읽은 판단으로 바로 공략 (2026-11-19, docs/ai-system.md)
    reprobeOnSwitch: false,
    targetFrom: 0.5, // 공략 첫 판의 목표 포획 확률
    targetTo: 0.75, // 마지막 판의 목표 포획 확률
    pickTop: 25, // 목표에 가까운 후보 중 이만큼에서 무작위로 고름 (매번 같은 수를 두지 않게)
    ambushMass: 0.12, // 이 이상 예측을 덮는 AI를 '매복'이라 부름
    lureProb: 0.25, // 눈치형/버티기형 확률이 이 이상이면 기준 AI를 '미끼'라 부름
  };

  const ROLE_NAMES = { ambush: '매복', lure: '미끼', guard: '마지막 지키기', block: '길목 막기' };

  // 참여자가 잡히는 시간대: 각 AI 앞뒤 windowMs 안(동시 입력) + 가장 늦은 AI 이후(마지막)
  function caughtIntervals(a, W) {
    const raw = [
      [a[0] - W, a[0] + W],
      [a[1] - W, a[1] + W],
      [a[2] - W, Infinity],
    ].sort((x, y) => x[0] - y[0]);
    const out = [];
    for (const [lo, hi] of raw) {
      const last = out[out.length - 1];
      if (last && lo <= last[1]) last[1] = Math.max(last[1], hi);
      else out.push([lo, hi]);
    }
    return out;
  }

  // 살아남을 수 있는 시간의 합 (ms)
  function safeMs(a, W) {
    let pos = 0;
    let safe = 0;
    for (const [lo, hi] of caughtIntervals(a, W)) {
      if (lo > pos) safe += lo - pos;
      pos = Math.max(pos, hi);
      if (pos === Infinity) break;
    }
    return safe;
  }

  // 공정 규칙을 통과한 모든 작전 후보 (설정이 같으면 한 번만 만듦)
  const cache = new Map();
  function candidates(o) {
    const key = [o.windowMs, o.aiMinMs, o.aiMaxMs, o.gridMs, o.minGapMs, o.lateMinMs, o.minSafeMs].join(',');
    if (cache.has(key)) return cache.get(key);
    const vals = [];
    for (let v = o.aiMinMs; v <= o.aiMaxMs; v += o.gridMs) vals.push(v);
    const list = [];
    for (let i = 0; i < vals.length; i++) {
      for (let j = i + 1; j < vals.length; j++) {
        if (vals[j] - vals[i] < o.minGapMs) continue;
        for (let k = j + 1; k < vals.length; k++) {
          const a = [vals[i], vals[j], vals[k]];
          if (a[2] < o.lateMinMs || a[2] - a[1] < o.minGapMs) continue;
          if (safeMs(a, o.windowMs) < o.minSafeMs) continue;
          list.push(a);
        }
      }
    }
    cache.set(key, list);
    return list;
  }

  function pCatch(mix, a, W) {
    let p = 0;
    for (const [lo, hi] of caughtIntervals(a, W)) p += Model.massBetween(mix, lo, hi);
    return Math.min(1, p);
  }

  // 정해진 작전에 대해 포획 확률 · 예상 시각 · 역할을 계산
  function evaluate(belief, times, opts = {}, modelParams = Model.DEFAULT_PARAMS) {
    const o = { ...DEFAULTS, ...opts };
    const mix = Model.predictive(belief, times, modelParams);
    const W = o.windowMs;
    const masses = times.map((x) => Model.massBetween(mix, x - W, x + W));
    const idx = (id) => Model.TYPES.findIndex((t) => t.id === id);
    const pFollow = belief.probs[idx('follow')];
    const pHold = belief.probs[idx('hold')];
    const roles = times.map((_, i) => {
      if (masses[i] >= o.ambushMass) return 'ambush';
      if (i === 0 && pFollow >= o.lureProb) return 'lure';
      if (i === 1 && pHold >= o.lureProb) return 'lure';
      if (i === 2) return 'guard';
      return 'block';
    });
    return { pCatch: pCatch(mix, times, W), predictedMs: Model.mode(mix), masses, roles };
  }

  // 이번 판 작전 고르기. roundNo는 1부터
  function plan(belief, roundNo, opts = {}, rng = Math.random, modelParams = Model.DEFAULT_PARAMS) {
    const o = { ...DEFAULTS, ...opts };
    const all = candidates(o);
    let pool = all;
    let phase = 'attack';
    let target;

    const pRandom = belief.probs[Model.TYPES.findIndex((t) => t.id === 'random')];
    const missedBig = roundNo > o.probeRounds + 1 && belief.lastHit !== null && belief.lastHit < o.reprobeBelow && pRandom < o.reprobeRandomMax;
    const switchedNow = o.reprobeOnSwitch && roundNo > o.probeRounds && belief.switchedAt != null && belief.switchedAt === belief.rounds;
    const surprised = missedBig || switchedNow;

    if (roundNo <= o.probeRounds || surprised) {
      // 떠보기: 첫 AI 시각을 일부러 바꿔, AI를 보고 누르는 사람인지 확인
      // (공략 중이라도 예측이 크게 빗나가면 전략을 바꿨다고 보고 다시 떠봄)
      phase = surprised ? 'reprobe' : 'probe';
      const windowIndex = surprised ? Math.floor(rng() * o.probeA1.length) : (roundNo - 1) % o.probeA1.length;
      const [lo, hi] = o.probeA1[windowIndex];
      pool = all.filter((a) => a[0] >= lo && a[0] <= hi && a[1] - a[0] >= o.probeGapMs);
      if (!pool.length) pool = all;
      target = o.probeTarget;
    } else {
      // 공략: 판이 갈수록 목표 포획 확률을 올림
      const span = Math.max(1, o.totalRounds - o.probeRounds - 1);
      const f = Math.min(1, Math.max(0, (roundNo - o.probeRounds - 1) / span));
      target = o.targetFrom + (o.targetTo - o.targetFrom) * f;
    }

    const mixCache = new Map(); // 눈치형·버티기형 예측은 첫째·둘째 AI 시각에만 달라짐
    const scored = pool.map((a) => {
      const key = a[0] * 100000 + a[1];
      let mix = mixCache.get(key);
      if (!mix) {
        mix = Model.predictive(belief, a, modelParams);
        mixCache.set(key, mix);
      }
      return { a, p: pCatch(mix, a, o.windowMs) };
    });

    const maxP = scored.reduce((m, s) => Math.max(m, s.p), 0);
    let choices;
    if (maxP < target) {
      // 목표만큼 잡기 어려운 상대(잘 안 읽힘) → 할 수 있는 최선 쪽에서 고름
      choices = scored.filter((s) => s.p >= maxP - 0.02);
    } else {
      choices = scored.sort((x, y) => Math.abs(x.p - target) - Math.abs(y.p - target)).slice(0, o.pickTop);
    }
    const pick = choices[Math.floor(rng() * choices.length)];
    const ev = evaluate(belief, pick.a, o, modelParams);
    return { times: pick.a, phase, target, maxPCatch: maxP, candidates: pool.length, afterSwitch: switchedNow, ...ev };
  }

  // 데이터 수집용: 공정 규칙 안에서 무작위 작전
  function randomSchedule(opts = {}, rng = Math.random) {
    const list = candidates({ ...DEFAULTS, ...opts });
    return list[Math.floor(rng() * list.length)];
  }

  // 판정: ① windowMs 안에 겹친 사람 모두 탈락 ② 안 누른 사람: 나머지가 다 눌렀으면 마지막, 아니면 시간 초과
  //       ③ 모두 눌렀다면 가장 늦게 누른 사람 탈락
  // entries: [{ id, time(ms|null), ... }]
  // partial: 참여자가 AI에게 잡혀 판이 도중에 끝난 경우 — 아직 안 누른 사람은 판정하지 않고 동시 입력만 봄
  function judge(entries, windowMs, { partial = false } = {}) {
    const list = entries.map((e) => ({ ...e, time: e.time ?? null, out: false, reason: null }));
    const mark = (p, reason) => {
      if (!p.out) {
        p.out = true;
        p.reason = reason;
      }
    };
    const pressed = list.filter((p) => p.time !== null).sort((a, b) => a.time - b.time);
    for (let i = 0; i < pressed.length; i++) {
      for (let j = i + 1; j < pressed.length && pressed[j].time - pressed[i].time < windowMs; j++) {
        mark(pressed[i], 'collision');
        mark(pressed[j], 'collision');
      }
    }
    if (partial) return list;
    const missing = list.length - pressed.length;
    for (const p of list) if (p.time === null) mark(p, missing === 1 ? 'last' : 'timeout');
    if (pressed.length === list.length) mark(pressed[pressed.length - 1], 'last');
    return list;
  }

  return { DEFAULTS, ROLE_NAMES, caughtIntervals, safeMs, candidates, pCatch, evaluate, plan, randomSchedule, judge };
});
