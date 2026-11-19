-- AI 눈치게임 기록 저장소 (Supabase 프로젝트: aiverse-nunchi)
--
-- 게임 화면과 현황판은 브라우저에서 publishable key로 바로 접속합니다.
--   읽기: 누구나 가능 (랭킹·판 기록)
--   쓰기: 아래 nunchi_* 함수로만 가능. 테이블에 직접 쓰는 것은 막혀 있고,
--         점수와 총점은 DB가 직접 계산합니다 (게임 화면이 보낸 점수를 믿지 않음).

-- ───────── 테이블 ─────────
create table public.nunchi_games (
  id text primary key check (char_length(id) between 8 and 64),
  nickname text not null check (char_length(nickname) between 1 and 30),
  station text not null default '1' check (char_length(station) between 1 and 10),
  total_rounds int not null check (total_rounds between 1 and 30),
  total_score int not null default 0,
  survived_rounds int not null default 0,
  started_at timestamptz not null default now(),
  finished_at timestamptz -- null이면 아직 진행 중 (랭킹에 안 나옴)
);

create table public.nunchi_rounds (
  game_id text not null references public.nunchi_games (id) on delete cascade,
  round int not null check (round between 1 and 30),
  time_ms numeric check (time_ms is null or (time_ms >= 0 and time_ms <= 5000)), -- 플레이어가 누른 시각, 못 눌렀으면 null
  survived boolean not null,
  reason text check (reason in ('collision', 'last', 'timeout')), -- 탈락 이유
  score int not null check (score between 0 and 500),
  presses jsonb not null default '[]'::jsonb -- 그 판 참가자 전원(플레이어+AI)의 기록
    check (jsonb_typeof(presses) = 'array' and jsonb_array_length(presses) <= 8),
  created_at timestamptz not null default now(),
  primary key (game_id, round)
);

create index nunchi_games_ranking_idx
  on public.nunchi_games (total_score desc, finished_at)
  where finished_at is not null;

-- ───────── 권한 ─────────
alter table public.nunchi_games enable row level security;
alter table public.nunchi_rounds enable row level security;

create policy "anyone can read games" on public.nunchi_games
  for select to anon, authenticated using (true);
create policy "anyone can read rounds" on public.nunchi_rounds
  for select to anon, authenticated using (true);

revoke insert, update, delete, truncate on public.nunchi_games, public.nunchi_rounds from anon, authenticated;
grant select on public.nunchi_games, public.nunchi_rounds to anon, authenticated;

-- ───────── 랭킹 (동점이면 같은 순위: 1, 2, 2, 4 …) ─────────
create view public.nunchi_ranking with (security_invoker = true) as
select
  rank() over (order by g.total_score desc) as rank,
  g.id as game_id,
  g.nickname,
  g.total_score,
  g.survived_rounds,
  g.total_rounds,
  g.finished_at
from public.nunchi_games g
where g.finished_at is not null;

grant select on public.nunchi_ranking to anon, authenticated;

-- ───────── 쓰기 함수 ─────────
-- 게임 시작. 같은 id로 다시 보내도 한 번만 저장됩니다.
create function public.nunchi_start_game(p_game_id text, p_nickname text, p_station text, p_total_rounds int)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.nunchi_games (id, nickname, station, total_rounds)
  values (
    p_game_id,
    left(btrim(p_nickname), 30),
    left(coalesce(nullif(btrim(p_station), ''), '1'), 10),
    p_total_rounds
  )
  on conflict (id) do nothing;
end;
$$;

-- 한 판 기록. 점수는 여기서 계산하고 돌려줍니다: 살아남으면 누른 시각(초) × 100, 탈락이면 0.
create function public.nunchi_record_round(
  p_game_id text,
  p_round int,
  p_time_ms numeric,
  p_survived boolean,
  p_reason text,
  p_presses jsonb
)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total_rounds int;
  v_score int;
begin
  select total_rounds into v_total_rounds
  from public.nunchi_games
  where id = p_game_id and finished_at is null;

  if not found then
    raise exception 'game % not found or already finished', p_game_id;
  end if;
  if p_round > v_total_rounds then
    raise exception 'round % exceeds total rounds %', p_round, v_total_rounds;
  end if;
  if p_survived and p_time_ms is null then
    raise exception 'a surviving round needs a press time';
  end if;

  v_score := case when p_survived then round(p_time_ms / 10)::int else 0 end;

  insert into public.nunchi_rounds (game_id, round, time_ms, survived, reason, score, presses)
  values (
    p_game_id,
    p_round,
    p_time_ms,
    p_survived,
    case when p_survived then null else p_reason end,
    v_score,
    coalesce(p_presses, '[]'::jsonb)
  )
  on conflict (game_id, round) do nothing;

  return v_score;
end;
$$;

-- 게임 종료. 총점·생존 판 수를 계산해 저장하고 순위를 돌려줍니다. 다시 불러도 같은 순위를 돌려줍니다.
create function public.nunchi_finish_game(p_game_id text)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_finished timestamptz;
  v_total int;
  v_survived int;
begin
  select finished_at, total_score into v_finished, v_total
  from public.nunchi_games
  where id = p_game_id;

  if not found then
    raise exception 'game % not found', p_game_id;
  end if;

  if v_finished is null then
    select coalesce(sum(score), 0)::int, (count(*) filter (where survived))::int
      into v_total, v_survived
    from public.nunchi_rounds
    where game_id = p_game_id;

    update public.nunchi_games
       set finished_at = now(), total_score = v_total, survived_rounds = v_survived
     where id = p_game_id;
  end if;

  return (
    select count(*) + 1
    from public.nunchi_games
    where finished_at is not null and total_score > v_total
  )::int;
end;
$$;

revoke execute on function public.nunchi_start_game(text, text, text, int) from public;
revoke execute on function public.nunchi_record_round(text, int, numeric, boolean, text, jsonb) from public;
revoke execute on function public.nunchi_finish_game(text) from public;
grant execute on function public.nunchi_start_game(text, text, text, int) to anon, authenticated;
grant execute on function public.nunchi_record_round(text, int, numeric, boolean, text, jsonb) to anon, authenticated;
grant execute on function public.nunchi_finish_game(text) to anon, authenticated;

-- ───────── 실시간 ─────────
-- 게임이 끝나 nunchi_games가 바뀌면 현황판이 바로 알 수 있도록
alter publication supabase_realtime add table public.nunchi_games;


-- ════════════════════════════════════════════════════════════════
-- v2 (2026-11-19): 예측 AI 기록, 데이터 수집 모드, 새 점수
-- 기존 v1 함수는 그대로 두어, 아직 v1을 쓰는 배포본도 계속 동작합니다.
-- ════════════════════════════════════════════════════════════════

alter table public.nunchi_games
  add column mode text not null default 'play' check (mode in ('play', 'collect')), -- collect = 데이터 수집 (랭킹 제외)
  add column label text check (label is null or char_length(label) <= 20), -- 수집 모드에서 연기한 유형
  add column rule_version text check (rule_version is null or char_length(rule_version) <= 30);

alter table public.nunchi_rounds
  add column extra_presses int not null default 0 check (extra_presses between 0 and 1000), -- 연타 확인용
  add column ai jsonb check (ai is null or (jsonb_typeof(ai) = 'object' and pg_column_size(ai) < 8000)); -- AI의 판단·작전·예상

-- 랭킹은 일반 게임만
create or replace view public.nunchi_ranking with (security_invoker = true) as
select
  rank() over (order by g.total_score desc) as rank,
  g.id as game_id,
  g.nickname,
  g.total_score,
  g.survived_rounds,
  g.total_rounds,
  g.finished_at
from public.nunchi_games g
where g.finished_at is not null and g.mode = 'play';

create function public.nunchi_start_game_v2(
  p_game_id text,
  p_nickname text,
  p_station text,
  p_total_rounds int,
  p_mode text,
  p_label text,
  p_rule_version text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.nunchi_games (id, nickname, station, total_rounds, mode, label, rule_version)
  values (
    p_game_id,
    left(btrim(p_nickname), 30),
    left(coalesce(nullif(btrim(p_station), ''), '1'), 10),
    p_total_rounds,
    coalesce(nullif(btrim(p_mode), ''), 'play'),
    nullif(left(btrim(coalesce(p_label, '')), 20), ''),
    left(p_rule_version, 30)
  )
  on conflict (id) do nothing;
end;
$$;

-- 점수: 살아남으면 100점 + AI가 잡을 거라 본 확률(pCatch)만큼 보너스, 최대 200점
create function public.nunchi_record_round_v2(
  p_game_id text,
  p_round int,
  p_time_ms numeric,
  p_survived boolean,
  p_reason text,
  p_presses jsonb,
  p_extra_presses int,
  p_ai jsonb
)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total_rounds int;
  v_pcatch numeric;
  v_score int;
begin
  select total_rounds into v_total_rounds
  from public.nunchi_games
  where id = p_game_id and finished_at is null;

  if not found then
    raise exception 'game % not found or already finished', p_game_id;
  end if;
  if p_round > v_total_rounds then
    raise exception 'round % exceeds total rounds %', p_round, v_total_rounds;
  end if;
  if p_survived and p_time_ms is null then
    raise exception 'a surviving round needs a press time';
  end if;

  v_pcatch := least(1, greatest(0, coalesce((p_ai ->> 'pCatch')::numeric, 0)));
  v_score := case when p_survived then round(100 * (1 + v_pcatch))::int else 0 end;

  insert into public.nunchi_rounds (game_id, round, time_ms, survived, reason, score, presses, extra_presses, ai)
  values (
    p_game_id,
    p_round,
    p_time_ms,
    p_survived,
    case when p_survived then null else p_reason end,
    v_score,
    coalesce(p_presses, '[]'::jsonb),
    least(1000, greatest(0, coalesce(p_extra_presses, 0))),
    p_ai
  )
  on conflict (game_id, round) do nothing;

  return v_score;
end;
$$;

-- 게임 종료: 순위는 일반 게임끼리만 비교, 수집 모드는 0을 돌려줌
create or replace function public.nunchi_finish_game(p_game_id text)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_finished timestamptz;
  v_total int;
  v_survived int;
  v_mode text;
begin
  select finished_at, total_score, mode into v_finished, v_total, v_mode
  from public.nunchi_games
  where id = p_game_id;

  if not found then
    raise exception 'game % not found', p_game_id;
  end if;

  if v_finished is null then
    select coalesce(sum(score), 0)::int, (count(*) filter (where survived))::int
      into v_total, v_survived
    from public.nunchi_rounds
    where game_id = p_game_id;

    update public.nunchi_games
       set finished_at = now(), total_score = v_total, survived_rounds = v_survived
     where id = p_game_id;
  end if;

  if v_mode <> 'play' then
    return 0;
  end if;

  return (
    select count(*) + 1
    from public.nunchi_games
    where finished_at is not null and mode = 'play' and total_score > v_total
  )::int;
end;
$$;

revoke execute on function public.nunchi_start_game_v2(text, text, text, int, text, text, text) from public;
revoke execute on function public.nunchi_record_round_v2(text, int, numeric, boolean, text, jsonb, int, jsonb) from public;
grant execute on function public.nunchi_start_game_v2(text, text, text, int, text, text, text) to anon, authenticated;
grant execute on function public.nunchi_record_round_v2(text, int, numeric, boolean, text, jsonb, int, jsonb) to anon, authenticated;
