// Supabase와 주고받는 부분을 한곳에 모았습니다. 게임 화면과 현황판이 같이 씁니다.
// (DB 구조와 함수는 supabase/schema.sql)
'use strict';

const DB = (() => {
  const { supabaseUrl, supabaseKey } = window.NUNCHI_CONFIG;
  const client = window.supabase.createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  async function rpc(name, args) {
    const { data, error } = await client.rpc(name, args);
    if (error) throw error;
    return data;
  }

  const toRound = (r) => ({
    round: r.round,
    time: r.time_ms === null ? null : Number(r.time_ms),
    survived: r.survived,
    reason: r.reason,
    score: r.score,
    presses: r.presses || [],
    ai: r.ai || null, // AI의 판단·작전·예상 (v2부터)
  });

  return {
    // ── 게임 화면에서 쓰는 것 (v2: 수집·연습 모드, AI 기록, 새 점수) ──
    // mode: 'play' 랭킹 / 'test' 연습(판 수를 바꾼 게임) / 'collect' 수집. 랭킹에는 10판 일반 게임만 올라감 (DB가 확인)
    startGame: ({ gameId, nickname, station, totalRounds, mode = 'play', label = null, ruleVersion = null }) =>
      rpc('nunchi_start_game_v2', {
        p_game_id: gameId,
        p_nickname: nickname,
        p_station: station,
        p_total_rounds: totalRounds,
        p_mode: mode,
        p_label: label,
        p_rule_version: ruleVersion,
      }),

    // 돌려주는 값: DB가 계산한 이번 판 점수 (살아남으면 100 × (1 + AI 포획 예상))
    recordRound: ({ gameId, round, time, survived, reason, presses, extraPresses = 0, ai = null }) =>
      rpc('nunchi_record_round_v2', {
        p_game_id: gameId,
        p_round: round,
        p_time_ms: time,
        p_survived: survived,
        p_reason: reason,
        p_presses: presses,
        p_extra_presses: extraPresses,
        p_ai: ai,
      }),

    // 돌려주는 값: 순위
    finishGame: (gameId) => rpc('nunchi_finish_game', { p_game_id: gameId }),

    async ping() {
      const { error } = await client.from('nunchi_ranking').select('game_id', { head: true, count: 'exact' });
      if (error) throw error;
    },

    // ── 현황판에서 쓰는 것 ──
    async ranking(limit) {
      let query = client
        .from('nunchi_ranking')
        .select('rank, game_id, nickname, total_score')
        .order('rank')
        .order('finished_at');
      if (limit) query = query.limit(limit);
      const { data, error } = await query;
      if (error) throw error;
      return data.map((g) => ({ rank: g.rank, gameId: g.game_id, nickname: g.nickname, totalScore: g.total_score }));
    },

    async gameDetail(gameId) {
      const [game, rounds] = await Promise.all([
        client.from('nunchi_ranking').select('*').eq('game_id', gameId).maybeSingle(),
        client
          .from('nunchi_rounds')
          .select('round, time_ms, survived, reason, score, presses, ai')
          .eq('game_id', gameId)
          .order('round'),
      ]);
      if (game.error) throw game.error;
      if (rounds.error) throw rounds.error;
      if (!game.data) return null;
      return {
        rank: game.data.rank,
        nickname: game.data.nickname,
        totalScore: game.data.total_score,
        survivedRounds: game.data.survived_rounds,
        rounds: rounds.data.map(toRound),
      };
    },

    // 어느 스테이션에서든 게임이 끝나면 onFinished(gameId)가 바로 불립니다
    onGameFinished(onFinished, onStatus) {
      return client
        .channel('nunchi-ranking')
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'nunchi_games' }, (payload) => {
          if (payload.new && payload.new.finished_at) onFinished(payload.new.id);
        })
        .subscribe((status) => onStatus && onStatus(status));
    },
  };
})();
