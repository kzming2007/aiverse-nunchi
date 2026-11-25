// AI가 쓰는 숫자 — 숫자 맞추기 도구가 만드는 파일입니다. 손으로 고치지 마세요.
//   만든 때: 2026-11-26 · 수집 기록: 사람 5명, 게임 27, 판 270 · 맞추기에서 뺀 게임 1개 (people.json "제외")
//   바꾼 숫자: 공격형·눈치형만 (나머지는 model.js 기본값)
//   만들기: node prototype/sim/fit.js --apply --only fixed,follow   ·   되돌리기: 아래 값을 null로 두거나 git에서 이전 버전으로
// null이면 model.js의 기본값(BUILTIN_PARAMS)을 그대로 씁니다.
(function (root, data) {
  if (typeof module === 'object' && module.exports) module.exports = data;
  else root.NunchiParams = data;
})(typeof globalThis !== 'undefined' ? globalThis : this, {
  "version": "fit-20261126-p5-fixed+follow",
  "meta": {
    "fittedAt": "2026-11-26",
    "people": 5,
    "games": 27,
    "rounds": 270,
    "input": "all",
    "only": [
      "fixed",
      "follow"
    ],
    "skipped": [
      "mwwaggmn9mo38fbr"
    ]
  },
  "types": {
    "fixed": {
      "noise": 144
    },
    "follow": {
      "noise": 82,
      "prior": {
        "mean": 384,
        "sd": 118
      }
    }
  }
});
