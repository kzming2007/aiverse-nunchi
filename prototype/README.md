# AI 눈치게임 프로토타입 (Aeye)

AI 3명(아직 랜덤)과 스페이스바로 눈치게임을 하고, 결과가 실시간 랭킹 현황판에 올라가는 프로토타입입니다.

| 화면 | 주소 |
|---|---|
| 게임 (1번 자리) | https://aiverse-nunchi.vercel.app/?station=1 |
| 게임 (2번 자리) | https://aiverse-nunchi.vercel.app/?station=2 |
| 현황판 (랭킹) | https://aiverse-nunchi.vercel.app/board |

짧게 테스트하려면 게임 주소 뒤에 `&rounds=3`을 붙이세요. 기본은 10판입니다.

## 구조

```
게임 화면 ──기록 저장(DB 함수)──▶ Supabase ──Realtime──▶ 현황판
  (Vercel에 올린 정적 페이지)        (aiverse-nunchi)        (Vercel)
```

- **Vercel**: `public/` 폴더의 화면 파일만 올립니다. 서버 코드는 없습니다.
- **Supabase** (프로젝트 `aiverse-nunchi`, 서울 리전, 무료 플랜)
  - `nunchi_games` 게임 1판(10라운드)당 한 줄, `nunchi_rounds` 라운드마다 한 줄 (AI 3명이 누른 시각까지)
  - `nunchi_ranking` 랭킹 (동점이면 같은 순위)
  - 브라우저는 **읽기만** 가능하고, 저장은 `nunchi_start_game` / `nunchi_record_round` / `nunchi_finish_game` 함수로만 됩니다.
    점수와 총점은 DB가 직접 계산하므로 브라우저에서 점수를 조작할 수 없습니다.
  - 전체 구조: [`supabase/schema.sql`](supabase/schema.sql)

## 진행 순서

1. **닉네임 입력** (최대 12자, 비워두고 Enter를 누르면 회색 추천 닉네임 사용)
2. **스페이스바** (또는 엔터)로 버튼 누르기 × 10판
3. 종료 화면에서 점수와 순위 확인 → 스페이스바를 누르면 다음 사람 닉네임 입력

## 규칙 (프로토타입)

- 시작 신호 후 5초 안에 한 번 누르기
- 0.3초 안에 2명 이상이 누르면 모두 탈락 (동시 입력)
- 모두 눌렀다면 가장 늦게 누른 사람 탈락, 5초 안에 못 누르면 탈락
- 살아남으면 **누른 시각(초) × 100점** (예: 2.37초 → 237점). 탈락하면 0점

규칙 숫자는 `public/game.js` 맨 위의 `CONFIG`에서 바꿀 수 있습니다.

## 현황판

- 닉네임과 점수 순위만 크게 보여줍니다. 어느 자리에서든 게임이 끝나면 그 줄이 반짝이며 바로 추가됩니다.
- 닉네임을 누르면 10판 기록 팝업이 열립니다 (판마다 누른 시각, 생존/탈락 이유, 점수, AI 3명이 누른 위치).
- 팝업은 ✕, Esc, 바깥 클릭으로 닫히고, 20초 동안 조작이 없으면 자동으로 닫힙니다.

## 배포 (자동)

GitHub 저장소의 `main` 브랜치에 push하면 Vercel이 **자동으로 배포**합니다. 따로 명령을 실행할 필요가 없습니다.

- Vercel 프로젝트 `aiverse-nunchi`가 이 저장소와 연결되어 있고, 루트 폴더는 `prototype`입니다.
- 배포 결과는 GitHub 커밋 옆의 체크 표시나 Vercel 대시보드에서 확인할 수 있습니다.
- `main`이 아닌 브랜치에 push하면 미리보기(Preview) 주소가 따로 만들어집니다. 미리보기 주소는 Vercel에 로그인한 팀 계정만 볼 수 있습니다.
- `.vercelignore`로 `public/` 화면 파일만 올라가고 `server.js` 등은 올라가지 않습니다.

## 로컬에서 확인하기

```bash
cd prototype
node server.js
```

http://localhost:3000 (게임), http://localhost:3000/board (현황판). 로컬에서 해도 기록은 **같은 Supabase에 저장**됩니다.

## 기록 지우기

Supabase 대시보드 → SQL Editor에서 실행합니다. 라운드 기록은 게임과 함께 지워집니다.

```sql
-- 특정 닉네임만
delete from public.nunchi_games where nickname = '지울 닉네임';
-- 전부 초기화
delete from public.nunchi_games;
```

## 주의

- Supabase 무료 플랜은 **7일 동안 사용이 없으면 프로젝트가 일시정지**됩니다. 행사(11/27) 전까지 주기적으로 접속하거나, 멈췄다면 대시보드에서 Restore를 누르세요.
- 행사장에서는 **인터넷 연결이 필요**합니다 (Supabase에 저장).
- `data/events.jsonl`은 Supabase로 옮기기 전 로컬 서버 시절의 기록 파일로, 지금은 쓰지 않습니다.

## 파일 구조

| 파일 | 역할 |
|---|---|
| `public/index.html` `game.js` `game.css` | 게임 화면 |
| `public/board.html` `board.js` `board.css` | 현황판 (랭킹 + 10판 기록 팝업) |
| `public/db.js` | Supabase 저장·조회·실시간 연결을 한곳에 모은 파일 |
| `public/config.js` | Supabase 주소와 공개용(publishable) 키 |
| `public/shared.js` `shared.css` | 게임과 현황판이 같이 쓰는 타임라인·스타일 |
| `supabase/schema.sql` | DB 테이블·함수·권한 |
| `server.js` | 로컬 확인용 정적 파일 서버 |
| `vercel.json` `.vercelignore` | Vercel 배포 설정 |

## 다음 단계에서 바꿀 곳

- AI를 랜덤에서 '예측하는 AI'로 바꾸기: `public/game.js`의 `startRound()` 안 `aiTimes`
- USB 버튼: 대부분 키보드 입력으로 인식되므로, 버튼이 보내는 키를 `CONFIG.keys`에 추가하면 됩니다
