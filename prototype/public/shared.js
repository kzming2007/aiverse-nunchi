// 게임 화면과 현황판이 같이 쓰는 함수
'use strict';

const Shared = (() => {
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

  // 밀리초 → "2.37"
  const fmtSec = (ms) => (ms === null || ms === undefined ? '-' : (ms / 1000).toFixed(2));

  const REASON = {
    collision: '동시 입력',
    last: '마지막',
    timeout: '시간 초과',
  };

  // 라벨을 놓을 줄. 가까이 붙은 기록은 다른 줄에 놓아 글자가 겹치지 않게 합니다.
  const LANES = ['above', 'below', 'above2', 'below2'];

  // presses: [{ id, name, time(ms|null), out, reason }]
  // band: { center, half } 를 주면 AI가 예상한 타이밍 구간을 빨간 점선으로 표시
  function timelineHtml(presses, roundMs = 5000, { compact = false, band = null } = {}) {
    const minGapMs = compact ? 800 : 600; // 같은 줄에 놓을 라벨 사이 최소 간격
    const items = presses
      .map((p) => ({ ...p, missed: p.time === null || p.time === undefined }))
      .map((p) => ({ ...p, at: p.missed ? roundMs : p.time })) // 못 누른 사람은 막대 끝에 표시
      .sort((a, b) => a.at - b.at);

    let ticks = '';
    for (let s = 0; s <= roundMs / 1000; s++) {
      ticks += `<span class="tl-tick" style="left:${((s * 1000) / roundMs) * 100}%">${s}s</span>`;
    }

    const laneLast = {};
    const marks = items
      .map((p) => {
        const lane =
          LANES.find((l) => laneLast[l] === undefined || p.at - laneLast[l] >= minGapMs) ??
          LANES.reduce((a, b) => (laneLast[a] <= laneLast[b] ? a : b));
        laneLast[lane] = p.at;

        const left = Math.min(100, (p.at / roundMs) * 100);
        const cls = [
          'tl-mark',
          p.id === 'player' ? 'is-player' : 'is-ai',
          p.out ? 'is-out' : '',
          lane,
          left < 12 ? 'edge-l' : left > 88 ? 'edge-r' : '', // 양 끝에서는 라벨이 밖으로 나가지 않게
        ].join(' ');
        const label = p.missed ? `${esc(p.name)} 시간 초과` : `${esc(p.name)} ${fmtSec(p.time)}s`;
        return `<div class="${cls}" style="left:${left}%"><span class="tl-dot"></span><span class="tl-label">${label}${p.out ? ' ✕' : ''}</span></div>`;
      })
      .join('');

    let bandHtml = '';
    if (band && Number.isFinite(band.center)) {
      const lo = Math.max(0, band.center - band.half);
      const hi = Math.min(roundMs, band.center + band.half);
      bandHtml = `<div class="tl-band" style="left:${(lo / roundMs) * 100}%;width:${((hi - lo) / roundMs) * 100}%" title="AI 예상 ${fmtSec(band.center)}초"></div>`;
    }

    return `<div class="tl${compact ? ' compact' : ''}"><div class="tl-track">${ticks}${bandHtml}${marks}</div></div>`;
  }

  return { esc, fmtSec, REASON, timelineHtml };
})();
