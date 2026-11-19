# AI 눈치게임 프로토타입 (Aeye)

AI 3명과 스페이스바로 눈치게임을 하고, 결과가 실시간 랭킹 현황판에 올라가는 프로토타입입니다.
AI는 판마다 참여자의 플레이 유형을 추정하고, 그에 맞춰 작전을 짭니다. 동작 원리는 [AI 시스템 설계](../docs/ai-system.md)에 있습니다.

| 화면 | 주소 |
|---|---|
| 게임 (1번 자리) | https://aiverse-nunchi.vercel.app/?station=1 |
| 게임 (2번 자리) | https://aiverse-nunchi.vercel.app/?station=2 |
| 데이터 수집 모드 | https://aiverse-nunchi.vercel.app/?mode=collect |
| 현황판 (랭킹) | https://aiverse-nunchi.vercel.app/board |

짧게 테스트하려면 게임 주소 뒤에 `&rounds=3`을 붙이세요. 기본은 10판입니다.

## 구조

```
게임 화면 ──기록 저장(DB 함수)──▶ Supabase ──Realtime──▶ 현황판
  ├ ai/model.js   플레이어 모델 (유형 확률 + 개인 숫자)
  └ ai/planner.js 작전 계산 (공정 규칙 + 포획 확률 + 떠보기/공략)
sim/run.js  같은 ai/ 코드로 가상 플레이어와 수천 판을 돌려 밸런스 확인
```

- **Vercel**: `public/` 폴더의 화면 파일만 올립니다. 서버 코드는 없고, AI 계산도 모두 브라우저에서 합니다.
- **Supabase** (프로젝트 `aiverse-nunchi`, 서울 리전, 무료 플랜)
  - `nunchi_games` 게임 1판(10라운드)당 한 줄 (`mode`: play/collect, 수집 모드의 연기 유형 `label`)
  - `nunchi_rounds` 라운드마다 한 줄 (4명 전원이 누른 시각, 연타 횟수, AI의 판단·작전·예상을 담은 `ai`)
  - `nunchi_ranking` 랭킹 (일반 게임만, 동점이면 같은 순위)
  - 브라우저는 **읽기만** 가능하고, 저장은 `nunchi_start_game_v2` / `nunchi_record_round_v2` / `nunchi_finish_game` 함수로만 됩니다.
    점수와 총점은 DB가 계산합니다.
  - 전체 구조: [`supabase/schema.sql`](supabase/schema.sql) (v1 함수는 예전 배포본 호환용으로 남겨 둠)

## 진행 순서

1. **닉네임 입력** (최대 12자, 비워두고 Enter를 누르면 회색 추천 닉네임 사용)
2. **스페이스바** (또는 엔터)로 버튼 누르기 × 10판
   - 카운트다운 동안 AI가 이번 판 작전을 확정합니다 (🔒, 참여자 입력은 보지 않음)
   - 1~3판은 AI가 떠보고, 4판부터 공략합니다
   - 판이 끝나면 AI의 작전(미끼·매복·마지막 지키기)과 "AI의 판단" 유형 확률, AI가 예상한 타이밍(빨간 점선)을 보여 줍니다
3. 종료 화면: 점수, 순위, AI가 추정한 플레이 스타일, AI에게 읽힌 정도 → 스페이스바를 누르면 다음 사람

## 규칙

- 시작 신호 후 5초 안에 한 번 누르기
- 0.15초 안에 2명 이상이 누르면 모두 탈락 (동시 입력, `CONFIG.collisionMs`). **참여자가 AI와 겹치면 그 순간 판이 끝나고 참여자 패배** (아직 안 누른 AI는 "판 종료")
- 가장 늦게 누르면 탈락. AI 3명이 모두 누르면 그 자리에서 판이 끝납니다 (아직 안 눌렀다면 마지막)
- 살아남으면 **100점 + AI 포획 예상 확률만큼 보너스** (예: AI가 78% 확률로 잡을 거라 봤는데 생존 → 178점). 탈락하면 0점
- AI는 0.1초~4.7초 사이에 누릅니다. 공정 규칙: AI끼리 0.18초 이상 간격, 가장 늦은 AI는 3초 이후, 살아남을 수 있는 시간 1초 이상

규칙 숫자는 `public/game.js`의 `CONFIG`와 `public/ai/planner.js`의 `DEFAULTS`에서 바꿀 수 있습니다.

## 데이터 수집 모드

주소에 `?mode=collect`를 붙이면 수집 모드입니다. 팀원이 유형을 정해 연기하며 플레이하고, 그 기록으로 AI의 숫자를 맞춥니다.

- 시작 화면에서 **연기할 유형**(즉시형 · 공격형 · 눈치형 · 버티기형 · 랜덤형 · 자유)을 고릅니다. 한 게임 동안 그 유형 하나만 진지하게 연기합니다.
- AI는 공정 규칙 안에서 **무작위로** 누릅니다 (AI의 예상은 기록만 해 둠).
- 기록에 유형 라벨과 연타 횟수가 붙고, **랭킹에는 올라가지 않습니다.**
- 권장: 1명이 유형마다 20판(2게임)씩.

수집한 기록 보기 (Supabase SQL Editor):

```sql
select g.label, r.round, r.time_ms, r.presses, r.extra_presses, r.ai
from public.nunchi_rounds r join public.nunchi_games g on g.id = r.game_id
where g.mode = 'collect' order by g.started_at, r.round;
```

## 시뮬레이터

```bash
node prototype/sim/run.js 150 1
```

유형별 가상 플레이어(즉시형, 공격형, 눈치형, 버티기형, 랜덤형, 연타, 6판에 전략 변경)와 150게임씩 돌려 생존율, 점수, 유형 정답률, 계산 시간을 출력하고 `sim/results/latest.json`에 남깁니다.
`SIM_MODEL='{"decay":0.6}'`처럼 환경변수로 모델 숫자를 바꿔 비교할 수 있습니다. 가상 플레이어 결과이며, 사람의 재미나 실제 정확도는 아닙니다.

## 현황판

- 닉네임과 점수 순위만 크게 보여줍니다. 어느 자리에서든 게임이 끝나면 그 줄이 반짝이며 바로 추가됩니다.
- 닉네임을 누르면 10판 기록 팝업이 열립니다 (판마다 누른 시각, 생존/탈락 이유, 점수, AI 포획 예상, AI 3명이 누른 위치, AI가 예상한 타이밍).
- 팝업은 ✕, Esc, 바깥 클릭으로 닫히고, 20초 동안 조작이 없으면 자동으로 닫힙니다.

## 배포 (자동)

GitHub 저장소의 `main` 브랜치에 push하면 Vercel이 **자동으로 배포**합니다. 따로 명령을 실행할 필요가 없습니다.

- Vercel 프로젝트 `aiverse-nunchi`가 이 저장소와 연결되어 있고, 루트 폴더는 `prototype`입니다.
- 배포 결과는 GitHub 커밋 옆의 체크 표시나 Vercel 대시보드에서 확인할 수 있습니다.
- `main`이 아닌 브랜치에 push하면 미리보기(Preview) 주소가 따로 만들어집니다. 미리보기 주소는 Vercel에 로그인한 팀 계정만 볼 수 있습니다.
- `.vercelignore`로 `public/` 화면 파일만 올라가고 `server.js`, `sim/` 등은 올라가지 않습니다.

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
-- 일반 게임만 전부 초기화 (수집 데이터는 남김) — 행사 전에 랭킹 비우기
delete from public.nunchi_games where mode = 'play';
```

## 주의

- Supabase 무료 플랜은 **7일 동안 사용이 없으면 프로젝트가 일시정지**됩니다. 행사(11/27) 전까지 주기적으로 접속하거나, 멈췄다면 대시보드에서 Restore를 누르세요.
- 행사장에서는 **인터넷 연결이 필요**합니다 (Supabase에 저장). AI 계산은 브라우저에서 하므로 저장이 끊겨도 게임은 계속됩니다.
- `data/events.jsonl`은 Supabase로 옮기기 전 로컬 서버 시절의 기록 파일로, 지금은 쓰지 않습니다.

## 파일 구조

| 파일 | 역할 |
|---|---|
| `public/index.html` `game.js` `game.css` | 게임 화면 |
| `public/ai/model.js` | 플레이어 모델: 유형 확률과 개인 숫자, 베이즈 갱신 (브라우저·Node 겸용) |
| `public/ai/planner.js` | 작전 계산: 후보 생성, 공정 규칙, 포획 확률, 떠보기/공략, 판정 (브라우저·Node 겸용) |
| `public/board.html` `board.js` `board.css` | 현황판 (랭킹 + 10판 기록 팝업) |
| `public/db.js` | Supabase 저장·조회·실시간 연결을 한곳에 모은 파일 |
| `public/config.js` | Supabase 주소와 공개용(publishable) 키 |
| `public/shared.js` `shared.css` | 게임과 현황판이 같이 쓰는 타임라인·스타일 |
| `sim/run.js` | 밸런스 시뮬레이터 (결과: `sim/results/latest.json`) |
| `supabase/schema.sql` | DB 테이블·함수·권한 |
| `server.js` | 로컬 확인용 정적 파일 서버 |
| `vercel.json` `.vercelignore` | Vercel 배포 설정 |

## 다음 단계

- 수집 데이터로 `ai/model.js`의 유형별 숫자(`DEFAULT_PARAMS.types`) 다시 맞추기
- USB 버튼: 대부분 키보드 입력으로 인식되므로, 버튼이 보내는 키를 `CONFIG.keys`에 추가하면 됩니다
