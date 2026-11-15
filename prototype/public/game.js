// AI 눈치게임 — 게임 화면
// 프로토타입: AI 3명은 아직 '랜덤'으로 누릅니다. 나중에 startRound()의 aiTimes를 예측 AI로 바꾸면 됩니다.
'use strict';

const { esc, fmtSec, REASON, timelineHtml } = Shared;
const params = new URLSearchParams(location.search);

const clampInt = (v, min, max, fallback) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

const CONFIG = {
  totalRounds: clampInt(params.get('rounds'), 1, 30, 10), // ?rounds=3 처럼 주소에 붙이면 짧게 테스트
  roundMs: 5000, // 한 판 제한 시간
  collisionMs: 300, // 이 간격 안에 2명 이상 누르면 모두 탈락 (동시 입력)
  aiMinMs: 300, // AI가 누르는 가장 이른 시각
  aiMaxMs: 4700, // AI가 누르는 가장 늦은 시각
  countdownStepMs: 650,
  resultMs: 2600, // 라운드 결과를 보여주는 시간
  restartDelayMs: 2000, // 종료 화면에서 실수로 바로 다시 시작되지 않도록 기다리는 시간
  keys: ['Space', 'Enter', 'NumpadEnter'], // 스페이스바 (+ 예비 대형 엔터키)
};
const STATION = (params.get('station') || '1').slice(0, 10);

const PLAYER = { id: 'player', name: '나', avatar: '🧑‍🚀' };
const AGENTS = [
  { id: 'ai1', name: 'AI 알파', avatar: '🤖' },
  { id: 'ai2', name: 'AI 베타', avatar: '👾' },
  { id: 'ai3', name: 'AI 감마', avatar: '🛸' },
];
const SEATS = [PLAYER, ...AGENTS];

const REASON_TEXT = {
  collision: '0.3초 안에 다른 참가자와 같이 눌렀어요',
  last: '가장 마지막에 눌렀어요',
  timeout: '5초 안에 누르지 못했어요',
};

const $ = (id) => document.getElementById(id);

let state = 'nickname'; // nickname → countdown → playing → judging → result → (다음 라운드) … → final → nickname
let game = null; // { gameId, nickname, round, rounds, totalScore }
let round = null; // { start, aiTimes, presses, count, timer }
let acceptRestartAt = 0;
let suggestedName = '';

// ───────── 화면 그리기 ─────────
function seatHtml(s) {
  return `<div class="seat${s.id === 'player' ? ' player' : ''}" id="seat-${s.id}">
    <span class="callout"></span>
    <div class="avatar">${s.avatar}</div>
    <div class="name">${esc(s.name)}</div>
    <div class="status">대기 중</div>
  </div>`;
}

function buildSeats() {
  $('ai-seats').innerHTML = AGENTS.map(seatHtml).join('');
  $('player-seat').innerHTML = seatHtml(PLAYER);
}

function setSeat(id, { cls = null, callout = null, status = null } = {}) {
  const el = $(`seat-${id}`);
  if (cls !== null) el.className = `seat${id === 'player' ? ' player' : ''} ${cls}`;
  if (callout !== null) el.querySelector('.callout').textContent = callout;
  if (status !== null) el.querySelector('.status').textContent = status;
}

function resetSeats() {
  for (const s of SEATS) setSeat(s.id, { cls: '', callout: '', status: '대기 중' });
}

function showBig(text, sub = '', tone = '') {
  $('big').textContent = text;
  $('big').className = `big ${tone}`;
  $('sub').textContent = sub;
}

function setTimebar(ratio) {
  $('timefill').style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
}

function updateHud() {
  $('round').textContent = game ? `${game.round} / ${CONFIG.totalRounds}` : '-';
  $('score').textContent = game ? game.totalScore : 0;
  $('nickname').textContent = game ? game.nickname : '';
}

function rulesHtml() {
  return `<div class="rules">
    <div>⏱ 시작 신호 후 5초 안에 한 번 누르기</div>
    <div>💥 0.3초 안에 다른 참가자와 같이 누르면 같이 탈락</div>
    <div>🐢 가장 마지막에 누르면 탈락</div>
    <div>⭐ 살아남으면 누른 시각(초) × 100점 · 늦게 누를수록 고득점</div>
  </div>`;
}

// 닉네임 입력 화면 (뒤에는 규칙이 보이는 대기 화면)
function showEntry() {
  state = 'nickname';
  game = null;
  updateHud();
  resetSeats();
  setTimebar(0);
  $('timeline').innerHTML = rulesHtml();
  $('final').classList.add('hidden');
  showBig('AI 눈치게임', `AI 3명과 ${CONFIG.totalRounds}판`, 'title');

  suggestedName = makeNickname();
  $('entry-name').value = '';
  $('entry-name').placeholder = suggestedName;
  $('entry').classList.remove('hidden');
  $('entry-name').focus();
}

$('entry-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (state !== 'nickname') return;
  const name = $('entry-name').value.trim().replace(/\s+/g, ' ').slice(0, 12) || suggestedName;
  $('entry-name').blur(); // 이후 스페이스바가 입력창에 들어가지 않도록
  $('entry').classList.add('hidden');
  unlockAudio();
  startGame(name);
});

// ───────── 게임 진행 ─────────
function startGame(nickname) {
  game = { gameId: makeId(), nickname, round: 0, rounds: [], totalScore: 0 };
  $('final').classList.add('hidden');
  const { gameId } = game;
  save(() => DB.startGame({ gameId, nickname, station: STATION, totalRounds: CONFIG.totalRounds }));
  nextRound();
}

async function nextRound() {
  game.round++;
  state = 'countdown';
  updateHud();
  resetSeats();
  setTimebar(0);
  $('timeline').innerHTML = '';
  for (const n of ['3', '2', '1']) {
    showBig(n, `${game.round}라운드 준비`);
    beep(440, 0.08);
    await sleep(CONFIG.countdownStepMs);
  }
  startRound();
}

function startRound() {
  // ▼ 지금은 랜덤. 나중에 '플레이어 패턴을 예측하는 AI'로 바꿀 자리입니다.
  const aiTimes = {};
  for (const a of AGENTS) aiTimes[a.id] = randomBetween(CONFIG.aiMinMs, CONFIG.aiMaxMs);

  round = { start: performance.now(), aiTimes, presses: {}, count: 0, timer: null };
  state = 'playing';
  showBig('시작!', '원하는 타이밍에 스페이스바');
  beep(880, 0.15);
  round.timer = setInterval(tick, 16);
}

function tick() {
  const elapsed = performance.now() - round.start;
  pressDueAgents(elapsed);
  setTimebar(elapsed / CONFIG.roundMs);

  const everyonePressed = SEATS.every((s) => round.presses[s.id] !== undefined);
  if (elapsed >= CONFIG.roundMs || everyonePressed) {
    clearInterval(round.timer);
    state = 'judging';
    setTimeout(endRound, everyonePressed ? 350 : 0);
  }
}

// 누를 시각이 된 AI를 처리합니다. 기록은 '예정 시각' 그대로 남겨 화면 지연과 상관없이 정확합니다.
function pressDueAgents(upTo) {
  AGENTS.filter((a) => round.presses[a.id] === undefined && round.aiTimes[a.id] <= upTo)
    .sort((a, b) => round.aiTimes[a.id] - round.aiTimes[b.id])
    .forEach((a) => registerPress(a.id, round.aiTimes[a.id]));
}

function playerPress(now) {
  if (round.presses.player !== undefined) return; // 한 판에 한 번만
  const time = now - round.start;
  if (time > CONFIG.roundMs) return;
  pressDueAgents(time); // 같은 순간 직전에 누른 AI가 있으면 순서를 맞춰 먼저 처리
  registerPress('player', time);
}

function registerPress(id, time) {
  round.count++;
  round.presses[id] = time;
  setSeat(id, { cls: 'pressed', callout: `${round.count}!`, status: `${fmtSec(time)}초` });
  beep(520 + round.count * 110, 0.09, id === 'player' ? 'square' : 'sine');
}

// 판정: ① 0.3초 안에 겹친 사람 모두 탈락 ② 못 누른 사람 탈락 ③ 모두 눌렀다면 가장 늦은 사람 탈락
function judgeRound(presses) {
  const list = SEATS.map((s) => ({ id: s.id, name: s.name, time: presses[s.id] ?? null, out: false, reason: null }));
  const mark = (p, reason) => {
    if (!p.out) {
      p.out = true;
      p.reason = reason;
    }
  };
  const pressed = list.filter((p) => p.time !== null).sort((a, b) => a.time - b.time);

  for (let i = 0; i < pressed.length; i++) {
    for (let j = i + 1; j < pressed.length && pressed[j].time - pressed[i].time < CONFIG.collisionMs; j++) {
      mark(pressed[i], 'collision');
      mark(pressed[j], 'collision');
    }
  }
  for (const p of list) if (p.time === null) mark(p, 'timeout');
  if (pressed.length === list.length) mark(pressed.at(-1), 'last');
  return list;
}

function endRound() {
  state = 'result';
  const results = judgeRound(round.presses);
  for (const r of results) {
    setSeat(r.id, {
      cls: `${r.time !== null ? 'pressed ' : ''}${r.out ? 'out' : 'safe'}`,
      status: r.out ? `탈락 · ${REASON[r.reason]}` : `생존 · ${fmtSec(r.time)}초`,
    });
  }

  const me = results.find((r) => r.id === 'player');
  const score = me.out ? 0 : Math.round(me.time / 10); // 누른 시각(초) × 100
  game.totalScore += score;
  game.rounds.push({ round: game.round, time: me.time, survived: !me.out, reason: me.reason, score });
  updateHud();
  $('timeline').innerHTML = timelineHtml(results, CONFIG.roundMs);

  if (me.out) {
    showBig('탈락!', REASON_TEXT[me.reason], 'bad');
    beep(160, 0.35, 'sawtooth');
  } else {
    showBig(`생존 +${score}`, `${fmtSec(me.time)}초에 눌렀어요`, 'good');
    beep(1046, 0.12);
    setTimeout(() => beep(1318, 0.16), 110);
  }

  const record = { gameId: game.gameId, round: game.round, time: me.time, survived: !me.out, reason: me.reason, presses: results };
  save(() => DB.recordRound(record));

  setTimeout(() => (game.round < CONFIG.totalRounds ? nextRound() : finishGame()), CONFIG.resultMs);
}

async function finishGame() {
  state = 'final';
  acceptRestartAt = performance.now() + CONFIG.restartDelayMs;

  const survived = game.rounds.filter((r) => r.survived).length;
  const times = game.rounds.filter((r) => r.time !== null).map((r) => r.time);
  const avg = times.length ? times.reduce((a, b) => a + b, 0) / times.length : null;
  const chips = game.rounds
    .map(
      (r) =>
        `<div class="${r.survived ? 'ok' : 'ko'}">R${r.round}<br>${r.time === null ? '안 누름' : `${fmtSec(r.time)}s`}<br>${
          r.survived ? `+${r.score}` : REASON[r.reason]
        }</div>`
    )
    .join('');

  $('final').innerHTML = `<div class="final-card">
    <div class="final-title">게임 끝!</div>
    <div class="final-nick">${esc(game.nickname)}</div>
    <div class="final-score">${game.totalScore}<span>점</span></div>
    <div class="final-meta">생존 <b>${survived}/${game.rounds.length}</b> · 평균 누른 시각 <b>${fmtSec(avg)}초</b> · <span id="rank">순위 계산 중…</span></div>
    <div class="final-rounds">${chips}</div>
    <div class="final-hint">스페이스바를 누르면 다음 사람 차례</div>
  </div>`;
  $('final').classList.remove('hidden');

  const { gameId } = game;
  const rank = await save(() => DB.finishGame(gameId)).catch(() => null);
  const rankEl = $('rank');
  if (rankEl) rankEl.innerHTML = rank ? `오늘 <b>${rank}위</b>` : '기록을 저장하지 못했어요';
}

// ───────── 입력 ─────────
addEventListener('keydown', (e) => {
  if (state === 'nickname') {
    // 닉네임에는 띄어쓰기도 들어가야 하므로, 입력 중에는 스페이스바를 게임 키로 쓰지 않습니다
    if (document.activeElement !== $('entry-name')) $('entry-name').focus();
    return;
  }
  if (!CONFIG.keys.includes(e.code)) return;
  e.preventDefault();
  if (e.repeat) return; // 꾹 누르고 있을 때 반복 입력 무시
  const now = performance.now();
  unlockAudio();
  if (state === 'playing') playerPress(now);
  else if (state === 'final' && now >= acceptRestartAt) showEntry();
});

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
function unlockAudio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audioCtx = new AC();
  }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}

function beep(freq, dur = 0.1, type = 'sine', vol = 0.12) {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

// ───────── 도구 ─────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomBetween = (min, max) => min + Math.random() * (max - min);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
// crypto.randomUUID는 http://IP 주소 접속에서 막히므로 직접 만듭니다
const makeId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

const ADJ = ['재빠른', '느긋한', '수상한', '침착한', '엉뚱한', '눈치빠른', '배고픈', '졸린', '반짝이는', '용감한', '소심한', '대담한'];
const NOUN = ['수달', '고양이', '펭귄', '너구리', '다람쥐', '부엉이', '고래', '토끼', '여우', '판다', '햄스터', '우주인'];
const makeNickname = () => `${pick(ADJ)} ${pick(NOUN)}`; // 입력창에 보여줄 추천 닉네임

// ───────── 시작 ─────────
$('station').textContent = `스테이션 ${STATION}`;
buildSeats();
showEntry();
checkServer();
setInterval(checkServer, 15000);
