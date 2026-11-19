// AI가 쓰는 숫자 — 숫자 맞추기 도구가 만드는 파일입니다. 손으로 고치지 마세요.
//   만들기: node prototype/sim/fit.js --apply   (수집 모드 기록으로 유형별 숫자를 맞춤)
//   되돌리기: 아래 값을 null로 두거나 git에서 이전 버전으로
// null이면 model.js의 기본값(BUILTIN_PARAMS)을 그대로 씁니다.
(function (root, data) {
  if (typeof module === 'object' && module.exports) module.exports = data;
  else root.NunchiParams = data;
})(typeof globalThis !== 'undefined' ? globalThis : this, null);
