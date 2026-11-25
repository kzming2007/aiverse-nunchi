// AI 눈치게임 — 게임 화면
// 한 판의 흐름: 카운트다운 동안 AI가 작전 확정(🔒 사람 입력은 보지 않음) → 플레이 → 판정
//              → 참여자 유형 판단 갱신 → 결과와 AI의 작전 공개 → 저장
//   ai/model.js    플레이어 모델 (유형 확률 + 개인 숫자)
//   ai/planner.js  작전 계산 (공정 규칙 + 포획 확률 + 떠보기/공략)
'use strict';

const { esc, fmtSec, REASON, timelineHtml } = Shared;
const Model = NunchiModel;
const Planner = NunchiPlanner;
const params = new URLSearchParams(location.search);

const clampInt = (v, min, max, fallback) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

const RANKED_ROUNDS = 10; // 랭킹에 올라가는 게임의 판 수 (DB도 같은 규칙으로 다시 확인)

const CONFIG = {
  totalRounds: clampInt(params.get('rounds'), 1, 30, RANKED_ROUNDS), // ?rounds=3 처럼 붙이면 짧게 테스트 (연습 게임으로 저장)
  roundMs: 5000, // 한 판 제한 시간
  collisionMs: 150, // 이 간격 안에 2명 이상 누르면 모두 탈락 (동시 입력). 11/19 0.3초 → 0.15초
  aiMinMs: 100, // AI가 누를 수 있는 가장 이른 시각. 11/19 0.3초 → 0.1초
  aiMaxMs: 4700, // AI가 누를 수 있는 가장 늦은 시각
  countdownStepMs: params.get('pace') === 'fast' ? 450 : 650,
  resultMs: params.get('pace') === 'fast' ? 2300 : 3800, // 라운드 결과와 AI의 작전을 보여주는 시간
  restartDelayMs: 2000, // 종료 화면에서 실수로 바로 다시 시작되지 않도록 기다리는 시간
  keys: ['Space', 'Enter', 'NumpadEnter'], // 스페이스바 (+ 예비 대형 엔터키)
  ruleVersion: 'r2-w150-min100',
};

// 게임 종류 (랭킹은 누구나: 부스 노트북이든 휴대폰 QR 참여든 10판 일반 게임이면 올라감)
//   play:    랭킹 게임 (10판)
//   test:    연습 게임. ?rounds= 로 판 수를 바꾼 경우. AI는 똑같이 플레이하고 랭킹만 제외
//   collect: ?mode=collect 데이터 수집 모드. AI는 무작위로 누르고, 기록에 연기한 유형이 붙고, 랭킹 제외
const MODE = params.get('mode') === 'collect' ? 'collect' : CONFIG.totalRounds === RANKED_ROUNDS ? 'play' : 'test';
const TEST_REASON = MODE === 'test' ? `${CONFIG.totalRounds}판 테스트` : '';

const PLAN_OPTIONS = {
  roundMs: CONFIG.roundMs,
  windowMs: CONFIG.collisionMs,
  aiMinMs: CONFIG.aiMinMs,
  aiMaxMs: CONFIG.aiMaxMs,
  totalRounds: CONFIG.totalRounds,
};
const STATION = (params.get('station') || '1').slice(0, 10);
// 휴대폰·태블릿처럼 손가락으로 누르는 기기: 화면 아래 큰 버튼으로 플레이 (키보드도 그대로 됨)
const TOUCH = typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches;
const HIT_TOL = Model.DEFAULT_PARAMS.hitToleranceMs; // 예측 적중 기준 (±0.25초)
const COLLISION_SEC = `${CONFIG.collisionMs / 1000}초`; // 안내 문구용 (예: "0.15초")

const PLAYER = { id: 'player', name: '플레이어' };
// art: public/img/bots/{art}-{idle|press|result}.webp (대기·누름·결과 그림)
const AGENTS = [
  { id: 'ai1', name: 'ALPHA', art: 'alpha' },
  { id: 'ai2', name: 'BETA', art: 'beta' },
  { id: 'ai3', name: 'GAMMA', art: 'gamma' },
];
const SEATS = [PLAYER, ...AGENTS];

const REASON_TEXT = {
  collision: `AI와 ${COLLISION_SEC} 안에 같이 눌러서 잡혔어요`,
  last: '가장 마지막이었어요',
  timeout: '5초 안에 누르지 못했어요',
};
const COLLECT_LABELS = [...Model.TYPES.map((t) => ({ id: t.id, name: t.name })), { id: 'free', name: '자유 (평소대로)' }];

const $ = (id) => document.getElementById(id);
const pct = (p) => (p === null || p === undefined || !Number.isFinite(p) ? '-' : `${Math.round(p * 100)}%`);
const round4 = (x) => (x === null || x === undefined ? null : Math.round(x * 10000) / 10000);

let state = 'nickname'; // nickname → countdown → playing → judging → result → (다음 라운드) … → final → nickname
let game = null; // { gameId, nickname, label, round, rounds, totalScore, belief }
let round = null; // { plan, order, start, aiTimes, presses, count, timer }
let extraKeys = 0; // 이번 판에서 '한 번' 말고 더 누른 횟수 (연타 확인용)
let acceptRestartAt = 0;
let suggestedName = '';

// ───────── 화면 그리기 ─────────
// AI 자리: 이름판 + 로봇 그림 3장(대기·누름·결과 중 하나만 보임, CSS가 자리 상태로 고름)
function botSeatHtml(s) {
  const imgs = Flight.bot(s.art);
  return `<div class="seat bot" id="seat-${s.id}">
    <div class="plate"><span class="name">${esc(s.name)}</span><span class="status">대기 중</span></div>
    <div class="bot-art" role="img" aria-label="${esc(s.name)}">${imgs}<span class="callout"></span></div>
  </div>`;
}

// 내 자리: 빨간 큰 버튼 + 이름판 (휴대폰에서는 버튼 대신 화면 아래 큰 버튼을 씀)
function playerSeatHtml() {
  return `<div class="seat player" id="seat-player">
    <div class="red-wrap"><span class="red-btn" role="button" tabindex="0" aria-label="플레이어 버튼">${Flight.cap('red')}</span><span class="callout"></span></div>
    <div class="plate"><span class="name">플레이어 <span id="nickname" class="nick"></span></span><span class="status">대기 중</span></div>
  </div>`;
}

function buildSeats() {
  $('ai-seats').innerHTML = AGENTS.map(botSeatHtml).join('');
  $('player-seat').innerHTML = playerSeatHtml();
  // PC에서도 빨간 버튼을 마우스로 누를 수 있음 (스페이스바와 같은 동작)
  document.querySelector('#seat-player .red-btn').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    unlockAudio();
    onPress(eventTime(e), e.pointerType === 'mouse' ? 'mouse' : 'touch');
  });
}

function setSeat(id, { cls = null, callout = null, status = null } = {}) {
  const el = $(`seat-${id}`);
  if (cls !== null) el.className = `seat${id === 'player' ? ' player' : ' bot'} ${cls}`;
  if (callout !== null) el.querySelector('.callout').textContent = callout;
  if (status !== null) el.querySelector('.status').textContent = status;
}

function resetSeats() {
  Flight.reset();
  for (const s of SEATS) setSeat(s.id, { cls: '', callout: '', status: '대기 중' });
}

function showBig(text, sub = '', tone = '') {
  $('big').textContent = text;
  $('big').className = `big ${tone}`;
  $('sub').textContent = sub;
}

// 화면 가운데 잠깐 뜨는 안내 (수집 모드 연타 경고)
let warnTimer = null;
function warn(text, ms = 1600) {
  const el = $('warn');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(warnTimer);
  warnTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function setTimebar(ratio) {
  $('timefill').style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
}

function updateHud() {
  $('round').innerHTML = game ? `${game.round}<small>/${CONFIG.totalRounds}</small>` : '-'; // 숫자만 들어감
  $('score').textContent = game ? game.totalScore : 0;
  $('nickname').textContent = game ? game.nickname : '';
}

function showAiPanel(html) {
  $('ai-panel').innerHTML = html;
  $('ai-panel').classList.remove('hidden');
}

function hideAiPanel() {
  $('ai-panel').classList.add('hidden');
  $('ai-panel').innerHTML = '';
}

// AI가 본 유형 확률 막대
function beliefBarsHtml(belief, title, limit = 5) {
  const rows = Model.ranking(belief)
    .slice(0, limit)
    .map(
      (r, i) => `<div class="ai-bar${i === 0 ? ' top' : ''}">
        <span class="ai-bar-name">${esc(r.name)}</span>
        <span class="ai-bar-track"><span style="width:${(r.prob * 100).toFixed(1)}%"></span></span>
        <span class="ai-bar-pct">${pct(r.prob)}</span>
      </div>`
    )
    .join('');
  return `<div class="ai-bars"><div class="ai-bars-title">${title}</div>${rows}</div>`;
}

// 판이 끝난 뒤 공개하는 AI의 작전
function tacticHtml(plan, order) {
  if (plan.phase === 'collect') {
    return '<div class="ai-tactic"><span class="ai-phase">수집 모드</span> AI는 무작위로 눌렀어요 · 빨간 점선은 AI의 예상 입력 구간</div>';
  }
  const parts = plan.times.map((t, i) => {
    const agent = AGENTS.find((a) => a.id === order[i]);
    const role = plan.roles[i];
    return `<span class="ai-move"><b>${esc(agent.name)}</b> ${fmtSec(t)}초 <span class="role role-${role}">${Planner.ROLE_NAMES[role]}</span></span>`;
  });
  const head = plan.phase === 'attack' ? '🎯 공략' : '🔍 떠보기';
  return `<div class="ai-tactic"><span class="ai-phase">${head}</span> AI의 작전 ${parts.join('')}<span class="ai-legend">빨간 점선 = AI의 예상 입력 구간</span></div>`;
}

function rulesHtml() {
  return `<div class="rules">
    <div>⏱ 시작 신호 후 5초 안에 한 번 누르기</div>
    <div>💥 ${COLLISION_SEC} 안에 같이 누르거나 가장 마지막이면 탈락</div>
    <div>🤖 AI는 판이 시작되기 전에 이전 기록으로 작전을 정해요</div>
    <div>⭐ 살아남으면 100점 + AI가 잡을 거라 확신한 만큼 보너스 (최대 200점)</div>
  </div>`;
}

// 닉네임 입력 화면 (뒤에는 규칙이 보이는 대기 화면)
function showEntry() {
  state = 'nickname';
  refreshMusic();
  game = null;
  updateHud();
  resetSeats();
  setTimebar(0);
  hideAiPanel();
  $('timeline').innerHTML = rulesHtml();
  $('final').classList.add('hidden');
  showBig('AI 눈치게임', `5초 안에 한 번. 겹치거나 마지막이면 탈락!`, 'title');

  suggestedName = makeNickname();
  $('entry-name').value = '';
  $('entry-name').placeholder = suggestedName;
  if (MODE === 'collect') {
    // 수집 모드: 같은 사람인지 알아야 하므로 추천 닉네임 대신 직접 입력. 이 기기에서 마지막에 쓴 가명을 채워 둠
    $('entry-name').value = loadCollectName();
    $('entry-name').placeholder = '가명 입력 (예: aeye1)';
    $('entry-collect-hint').classList.remove('need');
  }
  $('entry').classList.remove('hidden');
  $('stage').dataset.phase = 'entry';
  setTap('wait', '준비…');
  if (!TOUCH) (MODE === 'collect' ? $('entry-name') : document.querySelector('.entry-start')).focus({preventScroll:true}); // 휴대폰에서는 자판이 바로 올라와 화면을 가리지 않게, 직접 누를 때만
}

// 수집 모드 가명: 이 기기(브라우저)에 기억해 두고 다음 게임에 채움
const COLLECT_NAME_STORE = 'nunchi.collectName';
function loadCollectName() {
  try {
    return localStorage.getItem(COLLECT_NAME_STORE) || '';
  } catch {
    return '';
  }
}
function saveCollectName(name) {
  try {
    localStorage.setItem(COLLECT_NAME_STORE, name);
  } catch {}
}

$('entry-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (state !== 'nickname') return;
  const typed = $('entry-name').value.trim().replace(/\s+/g, ' ').slice(0, 12);
  if (MODE === 'collect' && !typed) {
    $('entry-collect-hint').classList.add('need');
    $('entry-name').focus();
    return;
  }
  if (MODE === 'collect') saveCollectName(typed);
  const name = typed || suggestedName;
  const label = MODE === 'collect' ? $('entry-label').value : null;
  $('entry-name').blur(); // 이후 스페이스바가 입력창에 들어가지 않도록
  $('entry-label').blur();
  $('entry').classList.add('hidden');
  unlockAudio();
  startGame(name, label);
});

// ───────── 게임 진행 ─────────
function startGame(nickname, label) {
  game = { gameId: makeId(), nickname, label, round: 0, rounds: [], totalScore: 0, belief: Model.createBelief(), switchRounds: [] };
  $('final').classList.add('hidden');
  const { gameId } = game;
  save(() =>
    DB.startGame({ gameId, nickname, station: STATION, totalRounds: CONFIG.totalRounds, mode: MODE, label, ruleVersion: CONFIG.ruleVersion })
  );
  nextRound();
}

// 이번 판 작전. 수집 모드에서는 공정 규칙 안에서 무작위로 두되, AI의 예상은 기록해 둠
function makePlan() {
  if (MODE === 'collect') {
    const times = Planner.randomSchedule(PLAN_OPTIONS);
    return { ...Planner.evaluate(game.belief, times, PLAN_OPTIONS), times, phase: 'collect', target: null };
  }
  return Planner.plan(game.belief, game.round, PLAN_OPTIONS);
}

async function nextRound() {
  game.round++;
  state = 'countdown';
  refreshMusic();
  extraKeys = 0;
  updateHud();
  resetSeats();
  setTimebar(0);
  hideAiPanel();
  $('timeline').innerHTML = '';
  setTap('wait', '준비…');

  // ▼ 카운트다운이 시작될 때 이번 판 작전을 확정합니다. 이후 참여자가 무엇을 하든 바뀌지 않습니다.
  const plan = makePlan();
  for (const n of ['3', '2', '1']) {
    showBig(n);
    beep(440, 0.08);
    await sleep(CONFIG.countdownStepMs);
  }
  startRound(plan);
}

function startRound(plan) {
  // 정해진 시각들을 AI 3명에게 무작위로 나눠 줍니다 (늘 같은 AI가 먼저 누르지 않도록)
  const order = shuffle(AGENTS.map((a) => a.id));
  const aiTimes = {};
  plan.times.forEach((t, i) => (aiTimes[order[i]] = t));

  round = { plan, order, start: performance.now(), aiTimes, presses: {}, count: 0, timer: null, input: null };
  state = 'playing';
  $('stage').dataset.phase = 'live';
  showBig('시작!', '');
  setTap('live', '누르기!');
  beep(880, 0.15);
  round.timer = setInterval(tick, 16);
}

function tick() {
  const elapsed = performance.now() - round.start;
  pressDueAgents(elapsed);
  if (state !== 'playing') return; // 방금 AI에게 잡혀 판이 끝남
  setTimebar(elapsed / CONFIG.roundMs);

  // AI 3명이 모두 눌렀으면 더 기다릴 필요가 없음 (아직 안 눌렀다면 이미 마지막)
  const allAiPressed = AGENTS.every((a) => round.presses[a.id] !== undefined);
  if (elapsed >= CONFIG.roundMs || allAiPressed) endNow(allAiPressed ? 'allAi' : 'time');
}

// 판을 지금 끝냄. caught = 참여자가 AI와 동시에 눌러 잡힘 (남은 AI는 더 누르지 않음)
function endNow(reason) {
  if (state !== 'playing') return;
  clearInterval(round.timer);
  state = 'judging';
  round.endedBy = reason;
  setTimeout(endRound, reason === 'caught' ? 600 : 400);
}

// 참여자가 이미 누른 AI와 동시 입력 간격 안에 있으면 그 자리에서 잡힘
function checkCaught() {
  const mine = round.presses.player;
  if (mine === undefined) return;
  const caught = AGENTS.some((a) => round.presses[a.id] !== undefined && Math.abs(round.presses[a.id] - mine) < CONFIG.collisionMs);
  if (caught) endNow('caught');
}

// 누를 시각이 된 AI를 처리합니다. 기록은 '예정 시각' 그대로 남겨 화면 지연과 상관없이 정확합니다.
function pressDueAgents(upTo) {
  AGENTS.filter((a) => round.presses[a.id] === undefined && round.aiTimes[a.id] <= upTo)
    .sort((a, b) => round.aiTimes[a.id] - round.aiTimes[b.id])
    .forEach((a) => registerPress(a.id, round.aiTimes[a.id]));
}

// input: 'key' 키보드 · 'touch' 손가락 · 'mouse' 마우스 (판 기록에 남겨, 기기마다 반응 시간 차이를 따로 볼 수 있게)
function playerPress(now, input = 'key') {
  if (round.presses.player !== undefined) {
    extraKeys++; // 이미 누른 뒤 또 누름 (연타)
    if (MODE === 'collect') warn('✋ 한 판에 한 번만! 더 누르면 이 판은 학습에서 빠져요');
    return;
  }
  const time = now - round.start;
  if (time < 0) {
    extraKeys++; // '시작!' 전에 누른 입력이 늦게 처리된 경우 → 미리 누름
    return;
  }
  if (time > CONFIG.roundMs) return;
  round.input = input;
  pressDueAgents(time); // 같은 순간 직전에 누른 AI가 있으면 순서를 맞춰 먼저 처리
  registerPress('player', time);
  if (state === 'playing') setTap('done', '눌렀어요');
}

function registerPress(id, time) {
  if (state !== 'playing') return; // 판이 이미 끝났으면 더 누르지 않음
  round.count++;
  round.presses[id] = time;
  setSeat(id, { cls: 'pressed', callout: `${round.count}!`, status: `${fmtSec(time)}초` });
  const caller = id === 'player' ? '플레이어' : AGENTS.find(agent => agent.id === id).name;
  const together = Flight.pressed(id, round.presses, CONFIG.collisionMs, caller);
  flightSound(id);
  if (together) {
    flightSound('clash');
    beep(118, 0.13, 'triangle', 0.19, 53);
  }
  checkCaught();
}

const probsObject = (probs) => Object.fromEntries(Model.TYPES.map((t, k) => [t.id, round4(probs[k])]));

function endRound() {
  state = 'result';
  $('stage').dataset.phase = 'result';
  setTap('hide', ''); // 결과를 보는 동안은 버튼을 내려서 아래 'AI의 판단'을 가리지 않게
  const plan = round.plan;
  const caught = round.endedBy === 'caught';
  const results = Planner.judge(
    SEATS.map((s) => ({ id: s.id, name: s.name, time: round.presses[s.id] ?? null })),
    CONFIG.collisionMs,
    { partial: caught }
  );
  for (const r of results) {
    const notYet = r.time === null && !r.out; // 판이 먼저 끝나 아직 안 누른 AI
    setSeat(r.id, {
      cls: `${r.time !== null ? 'pressed ' : ''}${r.out ? 'out' : notYet ? '' : 'safe'}`,
      status: r.out ? `탈락 · ${REASON[r.reason]}` : notYet ? '판 종료' : `생존 · ${fmtSec(r.time)}초`,
    });
  }
  const shown = results.filter((r) => r.time !== null || r.out); // 타임라인·기록에는 실제로 누른 사람만
  const me = results.find((r) => r.id === 'player');

  // ── AI의 판단 갱신 (판 시작 전 판단으로 예측이 맞았는지도 기록) ──
  const obs = me.time !== null ? { pressed: true, t: me.time } : { pressed: false, censorAt: plan.times[2] };
  const before = game.belief.probs.slice();
  const updated = Model.update(game.belief, plan.times, obs);
  game.belief = updated.belief;
  if (updated.switched) game.switchRounds.push(game.round); // 최근 2판이 예전 습관과 너무 달라 새로 읽기 시작함
  const hitProb = obs.pressed ? updated.lastHit : null;
  const predictionHit = obs.pressed && plan.predictedMs !== null ? Math.abs(obs.t - plan.predictedMs) <= HIT_TOL : null;

  // ── 점수: 살아남으면 100점 + AI가 잡을 거라 본 확률만큼 보너스 (DB도 같은 식으로 계산) ──
  const pCatch = plan.pCatch ?? 0;
  const score = me.out ? 0 : Math.round(100 * (1 + pCatch));
  game.totalScore += score;
  game.rounds.push({ round: game.round, time: me.time, survived: !me.out, reason: me.reason, score, pCatch, phase: plan.phase, hitProb, predictionHit, extra: extraKeys });
  updateHud();

  const band = plan.predictedMs !== null ? { center: plan.predictedMs, half: HIT_TOL } : null;
  const narrow = typeof matchMedia === 'function' && matchMedia('(max-width: 600px)').matches; // 휴대폰: 작은 타임라인
  $('timeline').innerHTML = timelineHtml(shown, CONFIG.roundMs, { band, compact: narrow });

  const catchText = `AI 포획 예상 ${pct(pCatch)}`;
  if (me.out) {
    showBig(me.reason === 'collision' ? '잡혔다!' : '탈락!', `${REASON_TEXT[me.reason]} · ${catchText}`, 'bad');
    if (me.reason !== 'collision') beep(160, 0.16, 'triangle', 0.07);
  } else {
    const escape = predictionHit ? '예측 범위 안에서 생존' : '생존';
    showBig(`생존 +${score}`, `${escape} · ${fmtSec(me.time)}초 · 보너스 +${score - 100}`, 'good');
    beep(1046, 0.12);
    setTimeout(() => beep(1318, 0.16), 110);
  }
  const switchHtml = updated.switched
    ? '<div class="ai-switch">🔄 입력 패턴 변화 <small>최근 두 판을 기준으로 AI가 예측을 다시 시작했어요</small></div>'
    : '';
  // 수집 모드: 연타한 판은 학습에서 빠지므로 바로 알려 줌 (가운데 + 아래 패널)
  if (MODE === 'collect' && extraKeys > 0) warn(`⚠️ 이번 판은 연타로 학습에서 빠져요 (${extraKeys}번 더 누름)`, CONFIG.resultMs);
  const mashHtml =
    MODE === 'collect' && extraKeys > 0
      ? `<div class="ai-warn">⚠️ 이번 판은 ${extraKeys}번 더 눌러서 학습에서 빠져요 <small>'시작!' 뒤에 한 판에 한 번만 눌러 주세요</small></div>`
      : '';
  showAiPanel(mashHtml + switchHtml + tacticHtml(plan, round.order) + beliefBarsHtml(game.belief, '이번 판까지 AI가 본 플레이 유형'));

  const record = {
    gameId: game.gameId,
    round: game.round,
    time: me.time,
    survived: !me.out,
    reason: me.reason,
    presses: shown,
    extraPresses: extraKeys,
    ai: {
      endedBy: round.endedBy, // caught = AI에게 잡혀 즉시 종료, allAi = AI가 다 누름, time = 5초 지남
      input: round.input, // 참여자가 누른 방법: key / touch / mouse (안 눌렀으면 null)
      phase: plan.phase,
      pCatch: round4(pCatch),
      target: round4(plan.target),
      predictedMs: plan.predictedMs,
      hitProb: round4(hitProb),
      predictionHit,
      schedule: Object.fromEntries(round.order.map((id, i) => [id, plan.times[i]])),
      roles: plan.roles ? Object.fromEntries(round.order.map((id, i) => [id, plan.roles[i]])) : null,
      before: probsObject(before),
      after: probsObject(game.belief.probs),
      switchDetected: updated.switched, // 전략 변경 감지 (true면 after는 최근 2판만으로 다시 읽은 판단)
      switchScore: round4(updated.switchScore), // 새 판단이 최근 판을 얼마나 더 잘 맞혔나 (log, 2 넘으면 감지)
      modelVersion: Model.DEFAULT_PARAMS.version,
    },
  };
  save(() => DB.recordRound(record));

  setTimeout(() => (game.round < CONFIG.totalRounds ? nextRound() : finishGame()), CONFIG.resultMs);
}

async function finishGame() {
  state = 'final';
  refreshMusic();
  acceptRestartAt = performance.now() + CONFIG.restartDelayMs;
  hideAiPanel();

  const survived = game.rounds.filter((r) => r.survived).length;
  const observed = CONFIG.totalRounds > Planner.DEFAULTS.probeRounds ? Planner.DEFAULTS.probeRounds : 0;
  const forecastRounds = game.rounds.filter(r => r.round > observed);
  const eligible = forecastRounds.filter(r => r.predictionHit !== null);
  const noInput = forecastRounds.filter(r => r.time === null).length;
  const noForecast = forecastRounds.length - eligible.length - noInput;
  const scope = [observed && `${MODE === 'collect' ? '집계 제외' : '관찰'} ${observed}판`, noInput && `미입력 ${noInput}판`, noForecast && `예측 없음 ${noForecast}판`].filter(Boolean).join(' · ');
  const hits = eligible.filter(r => r.predictionHit).length;
  const style = Model.describe(game.belief);
  const [first, second] = Model.ranking(game.belief);
  const hasInput = game.rounds.some(r => r.time !== null);
  const close = first.prob - second.prob < 0.12;
  const type = !hasInput ? '입력 기록 없음' : close ? first.name + ' / ' + second.name : style.name;
  const behavior = !hasInput ? '버튼 입력이 없어 유형을 비교하기 어려워요.'
    : close ? '이번 기록에는 두 유형의 특징이 비슷하게 나타났어요.'
    : style.readable ? style.text.replace(/ 습관$/, ' 편이에요.') : '누르는 시각이 판마다 달랐어요.';
  const behaviorHtml = esc(behavior).replace(/\d+(?:\.\d+)?초/g, '<strong class="read-time">$&</strong>');
  const summary = !eligible.length ? '비교할 입력이 없어요.'
    : !hits ? 'AI의 예상 구간을 모두 피했어요!'
    : hits === eligible.length ? '이번에는 AI가 매번 타이밍을 읽었어요.'
    : 'AI의 타이밍 예측';
  const modeLabel = MODE === 'collect' ? '수집' : MODE === 'test' ? '연습' : '';
  const collectText = MODE === 'collect' ? `<p>수집 유형 ${esc(COLLECT_LABELS.find(l => l.id === game.label)?.name)} · 연타 없이 완료 ${game.rounds.filter(r => r.extra === 0).length}판</p>` : '';
  const chips = game.rounds.map(r => {
    const outcome = r.survived ? '+' + r.score : REASON[r.reason];
    const timing = r.time === null ? '미입력' : fmtSec(r.time) + '초';
    return `<li class="${r.survived ? 'safe' : 'out'}"><small>${r.round}판</small>
      <strong>${outcome}</strong><span>${timing}</span></li>`;
  }).join('');
  $('final').innerHTML = `<section class="final-card debrief">
    <header class="debrief-head"><span>${esc(game.nickname)}</span><b>AI 눈치게임</b><span>${modeLabel} ${game.rounds.length}판 종료</span></header>
    <div class="type-reveal"><p>AI가 본 이번 플레이</p><h1>${esc(type)}</h1><p>${behaviorHtml}</p></div>
    <div class="prediction"><span>${summary}</span>${eligible.length ? `<b>${eligible.length}판 중 ${hits}판 적중</b>` : ''}${scope ? `<small>${scope}</small>` : ''}</div>
    <div class="debrief-stats"><div>총점<strong>${game.totalScore}<small>점</small><span class="record-flag" hidden>NEW</span></strong></div>
      <div>생존<strong>${survived}<small> / ${game.rounds.length}판</small></strong></div>
      <div>${modeLabel ? '모드' : '누적 순위'}<strong id="rank">${modeLabel || '집계 중'}</strong></div></div>
    <ol class="round-receipt" aria-label="라운드별 결과">${chips}</ol>
    ${collectText}<button type="button" id="handoff">버튼을 누르면 다음 사람 차례&nbsp; →</button>
  </section>`;
  const rankEl = $('rank');
  $('handoff').addEventListener('click', () => onPress(performance.now(), 'mouse'));
  $('final').classList.remove('hidden');
  const { gameId } = game;
  const rank = await save(() => DB.finishGame(gameId)).catch(() => null);
  if (modeLabel || game?.gameId !== gameId || !rankEl.isConnected) return;
  rankEl.textContent = rank ? rank + '위' : '미집계';
  if (rank >= 1 && rank <= 3) rankEl.dataset.place = String(rank);
  if (Number(rank) !== 1 || !game.totalScore) return;
  // The finish RPC also returns 1 for ties. Only celebrate a confirmed outright lead.
  const leaders = await DB.ranking(2).catch(() => []);
  if (game?.gameId === gameId && rankEl.isConnected && leaders[0]?.gameId === gameId &&
      (!leaders[1] || leaders[0].totalScore > leaders[1].totalScore)) {
    rankEl.closest('.debrief').querySelector('.record-flag').hidden = false;
  }
}

// ───────── 입력 ─────────
// 누른 순간 = 입력 이벤트가 생긴 시각 (처리가 늦어져도 정확하게). 값이 이상하면 지금 시각
function eventTime(e) {
  const now = performance.now();
  const t = e && e.timeStamp;
  return Number.isFinite(t) && t > 0 && Math.abs(now - t) < 2000 ? t : now;
}

// 키보드·화면 버튼이 같이 쓰는 '버튼 한 번 누름'
function onPress(now, input) {
  if (state === 'playing') playerPress(now, input);
  else if (state === 'countdown') {
    extraKeys++; // 시작 전에 누름 (연타)
    if (MODE === 'collect') warn("⏳ 아직이에요! '시작!' 뒤에 한 번만 눌러 주세요");
  } else if (state === 'final' && now >= acceptRestartAt) showEntry();
}

addEventListener('keydown', (e) => {
  if (e.target.closest?.('#sound-toggle,#music-toggle')) return;
  if (state === 'nickname' && MODE !== 'collect' && CONFIG.keys.includes(e.code) &&
      document.activeElement !== $('entry-name') && document.activeElement !== $('entry-label')) {
    e.preventDefault();
    if (!e.repeat) $('entry-form').requestSubmit();
    return;
  }
  if (state === 'nickname') {
    // 닉네임에는 띄어쓰기도 들어가야 하므로, 입력 중에는 스페이스바를 게임 키로 쓰지 않습니다
    if (document.activeElement !== $('entry-name') && document.activeElement !== $('entry-label')) $('entry-name').focus();
    return;
  }
  if (!CONFIG.keys.includes(e.code)) return;
  e.preventDefault();
  if (e.repeat) return; // 꾹 누르고 있을 때 반복 입력 무시
  unlockAudio();
  onPress(eventTime(e), 'key');
});

// 휴대폰: 화면 아래 큰 버튼. 손가락이 닿는 순간(pointerdown)에 누른 것으로 침
$('tap').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  unlockAudio();
  onPress(eventTime(e), e.pointerType === 'mouse' ? 'mouse' : 'touch');
});
// 큰 버튼 모양: wait(준비·대기) / live(지금 누르기) / done(이번 판 누름)
function setTap(mode, label) {
  $('tap').className = `tap-btn ${mode}`;
  $('tap').textContent = label;
}

// ───────── 기록 저장 (Supabase) ─────────
// 게임 시작 → 판 기록 → 게임 종료가 반드시 이 순서로 저장되도록 한 줄로 세워서 보냅니다.
// 저장이 실패해도 게임은 계속 진행됩니다.
let saveQueue = Promise.resolve();

function save(task) {
  const run = saveQueue.then(() => withRetry(task));
  saveQueue = run.catch(() => {}); // 하나가 실패해도 다음 저장은 계속
  return run;
}

async function withRetry(task, tries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await task();
      setConn(true);
      return result;
    } catch (err) {
      if (attempt >= tries) {
        setConn(false);
        console.error('기록 저장 실패', err);
        throw err;
      }
      await sleep(400 * attempt);
    }
  }
}

async function checkServer() {
  try {
    await DB.ping();
    setConn(true);
  } catch {
    setConn(false);
  }
}

function setConn(ok) {
  $('conn').className = `conn ${ok ? 'ok' : 'bad'}`;
  $('conn').textContent = ok ? '기록 서버 연결됨' : '기록 서버 연결 끊김';
}

// ───────── 소리 (파일 없이 브라우저에서 생성) ─────────
let audioCtx = null;
let soundEnabled = false;
let musicEnabled = false;
let musicTimer = null;
function refreshMusic() {
  clearInterval(musicTimer);
  if (!soundEnabled || !musicEnabled || !['nickname', 'final'].includes(state)) return;
  // A short original lobby motif leaves the timed round entirely to the switches.
  const notes = [196, 0, 294, 330, 0, 247, 0, 0];
  let step = 0;
  musicTimer = setInterval(() => {
    const note = notes[step++ % notes.length];
    if (note && !document.hidden) beep(note, 0.095, 'triangle', 0.033);
  }, 240);
}
$('music-toggle').addEventListener('click', () => {
  musicEnabled = !musicEnabled;
  $('music-toggle').setAttribute('aria-pressed', String(musicEnabled));
  $('music-toggle').textContent = musicEnabled ? '배경음 켜짐' : '배경음 꺼짐';
  refreshMusic();
  $('music-toggle').blur();
});
const sounds = new Map();
const audioFiles = { ai1:'strike0', ai2:'strike1', ai3:'strike2', player:'strike3', clash:'clash' };
function flightSound(id) {
  if (!soundEnabled) return;
  const sample = sounds.get(id);
  if (!sample) return;
  sample.currentTime = 0;
  sample.play().catch(() => {});
}
$('sound-toggle').addEventListener('click', () => {
  soundEnabled = !soundEnabled;
  $('music-toggle').hidden = !soundEnabled;
  $('sound-toggle').setAttribute('aria-pressed', String(soundEnabled));
  $('sound-toggle').textContent = soundEnabled ? '소리 켜짐' : '소리 꺼짐';
  if (!soundEnabled) {
    for (const sample of sounds.values()) sample.pause();
    if (audioCtx?.state === 'running') audioCtx.suspend();
  } else {
    for (const [id, file] of Object.entries(audioFiles)) {
      if (sounds.has(id)) continue;
      const sample = new Audio('/flight/' + file + '.wav');
      sample.volume = id === 'player' ? 0.75 : 0.44;
      sample.preload = 'auto';
      sounds.set(id, sample);
    }
    unlockAudio();
  }
  refreshMusic();
  $('sound-toggle').blur();
});
function unlockAudio() {
  if (!soundEnabled) return;
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audioCtx = new AC();
  }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}

function beep(freq, dur = 0.1, type = 'sine', vol = 0.12, endFreq = freq) {
  if (!soundEnabled || !audioCtx) return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  osc.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

// ───────── 도구 ─────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
// crypto.randomUUID는 http://IP 주소 접속에서 막히므로 직접 만듭니다
const makeId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

const ADJ = ['재빠른', '느긋한', '수상한', '침착한', '엉뚱한', '눈치빠른', '배고픈', '졸린', '반짝이는', '용감한', '소심한', '대담한'];
const NOUN = ['수달', '고양이', '펭귄', '너구리', '다람쥐', '부엉이', '고래', '토끼', '여우', '판다', '햄스터', '우주인'];
const makeNickname = () => `${pick(ADJ)} ${pick(NOUN)}`; // 입력창에 보여줄 추천 닉네임

// ───────── 시작 ─────────
$('station').textContent = `스테이션 ${STATION}${MODE === 'collect' ? ' · 데이터 수집 모드' : MODE === 'test' ? ` · 연습 모드 (${TEST_REASON}, 랭킹 미반영)` : ''}`;
if (MODE === 'test') $('entry-notice').textContent = `연습 모드예요 (${TEST_REASON}). 플레이 기록은 AI 학습에만 쓰이고 랭킹에는 올라가지 않아요`;
if (MODE === 'collect') {
  $('entry-title').textContent = '데이터 수집 모드';
  $('entry-name-hint').textContent = '실명 대신 가명으로 · 최대 12자';
  $('entry-notice').textContent = '수집 기록(가명, 고른 유형, 누른 시각)은 AI 학습에만 쓰여요';
  $('entry-label').innerHTML = COLLECT_LABELS.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
  $('entry-collect').classList.remove('hidden');
}
document.body.classList.toggle('touch', TOUCH);
document.body.classList.toggle('collect', MODE === 'collect'); // 연타 경고 줄은 수집 모드에만
if (TOUCH) document.querySelector('.entry-start').textContent = '시작하기';
buildSeats();
if (TOUCH) document.querySelector('#seat-player .red-wrap').append($('tap'));
showEntry();
checkServer();
setInterval(checkServer, 15000);
