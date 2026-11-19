// AI 눈치게임 — 현황판 (실시간 랭킹 + 10판 기록 팝업)
// Supabase Realtime으로 어느 스테이션에서든 게임이 끝나면 랭킹을 바로 다시 불러옵니다.
'use strict';

const { esc, fmtSec, REASON, timelineHtml } = Shared;
const $ = (id) => document.getElementById(id);

const MEDAL = { 1: '🥇', 2: '🥈', 3: '🥉' };
const POPUP_AUTO_CLOSE_MS = 20 * 1000; // 팝업을 열어둔 채 떠나도 랭킹이 다시 보이도록

// ───────── 랭킹 ─────────
// newGameId: 방금 끝난 게임 (반짝이며 그 자리로 이동)
function renderRanking(list, newGameId = null) {
  $('count').textContent = `${list.length}명 참여`;
  if (!list.length) {
    $('ranking').innerHTML = '<li class="empty">아직 기록이 없어요. 첫 번째 주인공이 되어보세요!</li>';
    return;
  }

  $('ranking').innerHTML = list
    .map((g) => {
      const cls = ['row', g.rank <= 3 ? `top top${g.rank}` : '', g.gameId === newGameId ? 'flash' : '']
        .join(' ')
        .trim();
      return `<li class="${cls}" data-game-id="${esc(g.gameId)}" tabindex="0">
        <span class="rank">${MEDAL[g.rank] || g.rank}</span>
        <span class="who">${esc(g.nickname)}</span>
        <span class="pts">${g.totalScore}<small>점</small></span>
      </li>`;
    })
    .join('');

  // 방금 끝난 게임이 화면 밖에 있으면 그 자리로 이동
  $('ranking').querySelector('.flash')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// ───────── 10판 기록 팝업 ─────────
let openGameId = null;
let autoCloseTimer = null;

function restartAutoClose() {
  clearTimeout(autoCloseTimer);
  autoCloseTimer = setTimeout(closeDetail, POPUP_AUTO_CLOSE_MS);
}

async function openDetail(gameId) {
  openGameId = gameId;
  $('modal-body').innerHTML = '<div class="empty">기록을 불러오는 중…</div>';
  $('modal').classList.remove('hidden');
  restartAutoClose();

  try {
    const game = await DB.gameDetail(gameId);
    if (!game) throw new Error('게임을 찾을 수 없음');
    if (openGameId === gameId) $('modal-body').innerHTML = detailHtml(game);
  } catch (err) {
    console.error('기록 불러오기 실패', err);
    if (openGameId === gameId) $('modal-body').innerHTML = '<div class="empty">기록을 불러오지 못했어요</div>';
  }
}

function closeDetail() {
  openGameId = null;
  clearTimeout(autoCloseTimer);
  $('modal').classList.add('hidden');
}

function detailHtml(g) {
  const rows = g.rounds
    .map((r) => {
      // 좁은 칸에 맞게 짧은 이름으로: 플레이어는 '나', AI는 'AI ' 떼고 '알파'
      const presses = r.presses.map((p) => ({ ...p, name: p.id === 'player' ? '나' : p.name.replace(/^AI\s*/, '') }));
      const ai = r.ai || {};
      const band = Number.isFinite(ai.predictedMs) ? { center: ai.predictedMs, half: 250 } : null;
      const aiText = Number.isFinite(ai.pCatch) ? `<span class="r-ai">AI 포획 예상 ${Math.round(ai.pCatch * 100)}%</span>` : '';
      return `<div class="round-card ${r.survived ? 'ok' : 'ko'}">
        <div class="r-head">
          <span class="r-num">R${esc(r.round)}</span>
          <span>${r.time === null ? '안 누름' : `${fmtSec(r.time)}초`}</span>
          ${r.survived ? '<span class="good">생존</span>' : `<span class="bad">탈락 · ${REASON[r.reason] || ''}</span>`}
          ${aiText}
          <span class="r-score">${r.survived ? `+${esc(r.score)}` : '0'}</span>
        </div>
        ${timelineHtml(presses, 5000, { compact: true, band })}
      </div>`;
    })
    .join('');

  return `<div class="d-head">
      <div class="d-rank">${g.rank ? `${MEDAL[g.rank] || ''} ${g.rank}위` : '진행 중'}</div>
      <div class="d-name">${esc(g.nickname)}</div>
      <div class="d-score">${esc(g.totalScore)}<small>점</small></div>
    </div>
    <div class="d-meta">${g.rounds.length}판 중 ${g.survivedRounds}판 생존</div>
    <div class="rounds">${rows || '<div class="empty">판 기록이 없어요</div>'}</div>
    ${g.rounds.some((r) => r.ai) ? '<div class="d-legend">빨간 점선 = 그 판에 AI가 예상한 타이밍</div>' : ''}`;
}

$('ranking').addEventListener('click', (e) => {
  const row = e.target.closest('li[data-game-id]');
  if (row) openDetail(row.dataset.gameId);
});
$('ranking').addEventListener('keydown', (e) => {
  const row = e.target.closest('li[data-game-id]');
  if (row && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    openDetail(row.dataset.gameId);
  }
});
$('modal-close').addEventListener('click', closeDetail);
$('modal').addEventListener('click', (e) => {
  if (e.target === $('modal')) closeDetail(); // 바깥 어두운 곳을 누르면 닫기
});
$('modal').addEventListener('pointermove', () => openGameId && restartAutoClose());
$('modal').addEventListener('wheel', () => openGameId && restartAutoClose(), { passive: true });
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDetail();
});

// ───────── 서버 연결 ─────────
function setConn(ok) {
  $('conn').className = `conn ${ok ? 'ok' : 'bad'}`;
  $('conn').textContent = ok ? '실시간 연결됨' : '연결 끊김 · 다시 연결 중…';
}

async function refresh(newGameId = null) {
  try {
    renderRanking(await DB.ranking(), newGameId);
  } catch (err) {
    setConn(false);
    console.error('랭킹 불러오기 실패', err);
  }
}

DB.onGameFinished(
  (gameId) => refresh(gameId),
  (status) => setConn(status === 'SUBSCRIBED')
);
refresh();
setInterval(() => refresh(), 30 * 1000); // 실시간 연결이 잠깐 끊겨도 30초마다 다시 불러옵니다
