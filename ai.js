// ai.js — AI Layer (Neo将棋 v0.4)
// RandomAI + Level1AI（王手放置なし・1手読み）

import { opp, tokAt, getMoves, isKingInCheck, simulateAction } from './engine.js';

// ── Random AI ─────────────────────────────────────────────────────
// 合法手から取り手を60%優先してランダム選択
export function randomAIChooseAction(engine) {
  const actions = engine.getLegalActions();
  if (!actions.length) return null;
  const captures = actions.filter(a =>
    a.tag==='move' && engine.state.board[a.payload.to.row][a.payload.to.col].token
  );
  const pool = captures.length > 0 && Math.random() < 0.6 ? captures : actions;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ── Helpers ───────────────────────────────────────────────────────
// 指定プレイヤーの全駒の移動先座標セット（素の移動、validate なし）
function getOpponentRawDests(state, player) {
  const dests = new Set();
  for (let r=0; r<9; r++) for (let c=0; c<9; c++) {
    const t = tokAt(state.board, r, c);
    if (!t || t.owner !== player) continue;
    getMoves(t, r, c, state.board).forEach(m => dests.add(`${m.row},${m.col}`));
  }
  return dests;
}

// 駒の相対的な価値（スコアリング用）
const PIECE_VALUE = {
  P:1, L:3, N:3, S:4, G:5, B:8, R:10, K:100,
  '+P':5, '+L':5, '+N':5, '+S':5, '+B':11, '+R':13,
};
function pieceValue(type) { return PIECE_VALUE[type] || 1; }

// ── Level1 AI ─────────────────────────────────────────────────────
// getLegalActions() は validate_action 済みなので王手放置は既に除外されている。
// さらに1手読み：相手が即座に取れる手を減点、王手になる手を加点。
export function level1AIChooseAction(engine) {
  const actions = engine.getLegalActions();
  if (!actions.length) return null;

  // 宣言系アクション（declare_double）は盤面評価不要なので後回しにして最低優先
  const boardActions   = actions.filter(a => a.tag !== 'declare_double');
  const declareActions = actions.filter(a => a.tag === 'declare_double');

  if (!boardActions.length) {
    return declareActions[0] || null;
  }

  const myPlayer = engine.state.turn;
  const opPlayer = opp(myPlayer);

  const scored = boardActions.map(action => {
    const next = simulateAction(action, engine.state, engine.plugins);
    if (!next) return { action, score: -99 };

    let score = 0;

    // 取り手：駒の価値に応じて加点
    if (action.tag === 'move') {
      const target = engine.state.board[action.payload.to.row][action.payload.to.col].token;
      if (target) score += pieceValue(target.type) * 2;
    }

    // 移動先が相手の射程内 → 減点（取られる手を避ける）
    if (action.tag === 'move') {
      const opDests = getOpponentRawDests(next, opPlayer);
      const {to} = action.payload;
      if (opDests.has(`${to.row},${to.col}`)) {
        // 取られる駒の価値で重み付け
        const movedToken = next.board[to.row][to.col].token;
        const loss = movedToken ? pieceValue(movedToken.type) : 1;
        score -= loss;
      }
    }

    // 相手王を王手にする → 大きく加点
    if (isKingInCheck(next, opPlayer)) score += 8;

    // 成り手を僅かに優先
    if (action.tag === 'move' && action.payload.promote) score += 0.5;

    return { action, score };
  });

  // スコア最大の手群からランダムに選ぶ（tie-breaking で確率的な多様性を保つ）
  scored.sort((a, b) => b.score - a.score);
  const best  = scored[0].score;
  const pool  = scored.filter(s => s.score >= best - 0.1);
  return pool[Math.floor(Math.random() * pool.length)].action;
}
