// ai.js — AI Layer (Neo将棋 v0.4)
// RandomAI + Level1AI（王手放置なし・1手読み）

import { opp, tokAt, getMoves, isKingInCheck, simulateAction } from './engine.js?v=6';

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

// ── Minimax 共通 ──────────────────────────────────────────────────
// make-unmake 方式：探索中の deepClone を廃止し、盤面を直接書き換えて元に戻す。
// これにより探索ノードあたりの deepClone を 30→0 に削減し約10〜20倍高速化。

const EVAL_VAL = {
  P:100, '+P':150, L:300, '+L':350, N:300, '+N':350,
  S:500, '+S':550, G:500, '+G':500, B:700, '+B':900,
  R:800, '+R':1100, K:0,
  Q:1200, CK:400, NJ:900,
};

function evalBoard(state, forPlayer) {
  let score = 0;
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
    const t = state.board[r][c].token;
    if (!t) continue;
    const v = EVAL_VAL[t.type] || 200;
    const pos = (t.owner === 'black') ? (8 - r) * 5 : r * 5;
    score += (t.owner === forPlayer ? 1 : -1) * (v + pos);
  }
  for (const t of state.hands[forPlayer])
    score += Math.floor((EVAL_VAL[t.type] || 200) * 0.85);
  for (const t of state.hands[opp(forPlayer)])
    score -= Math.floor((EVAL_VAL[t.type] || 200) * 0.85);
  return score;
}

function sortByCapture(actions, state) {
  return [...actions].sort((a, b) => {
    const capV = act => {
      if (act.tag !== 'move') return 0;
      const t = state.board[act.payload.to.row]?.[act.payload.to.col]?.token;
      return (t && t.owner !== act.player) ? (EVAL_VAL[t.type] || 200) : 0;
    };
    return capV(b) - capV(a);
  });
}

// ── Make / Unmake（deepClone なし）───────────────────────────────
function makeMove(action, state) {
  if (action.tag === 'move') {
    const {from, to, promote} = action.payload;
    const movingToken = state.board[from.row][from.col].token;
    const capturedToken = state.board[to.row][to.col].token;
    const handLen = state.hands[action.player].length;

    state.board[from.row][from.col].token = null;
    const placed = (promote && movingToken && !movingToken.type.startsWith('+'))
      ? {...movingToken, type: '+' + movingToken.type}
      : movingToken ? {...movingToken} : null;
    state.board[to.row][to.col].token = placed;

    if (capturedToken) {
      state.hands[action.player].push({
        ...capturedToken, type: capturedToken.type.replace('+', ''), owner: action.player,
      });
    }
    state.turn = opp(state.turn);
    return { tag: 'move', from, to, movingToken, capturedToken, handLen };
  }
  if (action.tag === 'drop') {
    const {type, to} = action.payload;
    const idx = state.hands[action.player].findIndex(t => t.type === type);
    const token = state.hands[action.player].splice(idx, 1)[0];
    state.board[to.row][to.col].token = {...token};
    state.turn = opp(state.turn);
    return { tag: 'drop', to, idx, token };
  }
  // その他（declare_double など）：ターンだけ変更
  state.turn = opp(state.turn);
  return { tag: 'other' };
}

function unmakeMove(action, state, undo) {
  state.turn = opp(state.turn);
  if (undo.tag === 'move') {
    state.board[undo.from.row][undo.from.col].token = undo.movingToken;
    state.board[undo.to.row][undo.to.col].token = undo.capturedToken;
    state.hands[action.player].length = undo.handLen;
  } else if (undo.tag === 'drop') {
    state.board[undo.to.row][undo.to.col].token = null;
    state.hands[action.player].splice(undo.idx, 0, undo.token);
  }
}

// ── 高速合法手生成（deepClone なし）─────────────────────────────
// get_actions フックを直接呼び、check 検査だけ make-unmake で行う。
// declare_double は探索から除外（AIは宣言しない）。
function fastGetLegal(engine, state) {
  let actions = [];
  for (const p of engine.plugins) {
    if (p.hooks?.get_actions) {
      try { actions = p.hooks.get_actions(actions, state) || actions; }
      catch(e) {}
    }
  }
  return actions
    .filter(a => a.tag !== 'declare_double')
    .filter(a => {
      const undo = makeMove(a, state);
      const ok = !isKingInCheck(state, a.player);
      unmakeMove(a, state, undo);
      return ok;
    });
}

// 玉の存否で即死判定（getLegalActions を呼ばない）
function kingAlive(state, player) {
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
    const t = state.board[r][c].token;
    if (t?.type === 'K' && t.owner === player) return true;
  }
  return false;
}

// α-β minimax（make-unmake 版）
function minimaxFast(engine, state, depth, alpha, beta, rootPlayer) {
  if (!kingAlive(state, 'black')) return rootPlayer === 'white' ? 999999 : -999999;
  if (!kingAlive(state, 'white')) return rootPlayer === 'black' ? 999999 : -999999;
  if (depth === 0) return evalBoard(state, rootPlayer);

  const actions = sortByCapture(fastGetLegal(engine, state), state);
  if (!actions.length) return state.turn === rootPlayer ? -999999 : 999999;

  const isMax = state.turn === rootPlayer;
  let best = isMax ? -Infinity : Infinity;

  for (const action of actions) {
    const undo = makeMove(action, state);
    const score = minimaxFast(engine, state, depth - 1, alpha, beta, rootPlayer);
    unmakeMove(action, state, undo);

    if (isMax) { if (score > best) { best = score; if (best > alpha) alpha = best; } }
    else        { if (score < best) { best = score; if (best < beta)  beta  = best; } }
    if (alpha >= beta) break;
  }
  return best;
}

// ルートから1手を選ぶ（ルートのみ通常の getLegalActions を使う）
function minimaxRoot(engine, extraDepth) {
  const rootActions = sortByCapture(engine.getLegalActions(), engine.state);
  if (!rootActions.length) return null;
  const player = engine.state.turn;

  // 探索用に1回だけ deepClone
  const st = JSON.parse(JSON.stringify(engine.state));

  let best = -Infinity, bestAction = rootActions[0];
  for (const action of rootActions) {
    const undo = makeMove(action, st);
    const score = minimaxFast(engine, st, extraDepth, -Infinity, Infinity, player);
    unmakeMove(action, st, undo);
    if (score > best) { best = score; bestAction = action; }
  }
  return bestAction;
}

// ── Level2 AI（2手読み）─────────────────────────────────────────
export function level2AIChooseAction(engine) { return minimaxRoot(engine, 1); }

// ── Level3 AI（3手読み）─────────────────────────────────────────
export function level3AIChooseAction(engine) { return minimaxRoot(engine, 2); }

// ── 時間制限AI（iterative deepening）────────────────────────────
// 深さ1から順に完全探索し、残り時間がなくなった時点で最後に完成した深さの最善手を返す。
const TO = Symbol('timeout');

function minimaxTimed(engine, state, depth, alpha, beta, rootPlayer, deadline) {
  if (Date.now() >= deadline) return TO;

  if (!kingAlive(state, 'black')) return rootPlayer === 'white' ? 999999 : -999999;
  if (!kingAlive(state, 'white')) return rootPlayer === 'black' ? 999999 : -999999;
  if (depth === 0) return evalBoard(state, rootPlayer);

  const actions = sortByCapture(fastGetLegal(engine, state), state);
  if (!actions.length) return state.turn === rootPlayer ? -999999 : 999999;

  const isMax = state.turn === rootPlayer;
  let best = isMax ? -Infinity : Infinity;

  for (const action of actions) {
    const undo = makeMove(action, state);
    const score = minimaxTimed(engine, state, depth - 1, alpha, beta, rootPlayer, deadline);
    unmakeMove(action, state, undo);
    if (score === TO) return TO;
    if (isMax) { if (score > best) { best = score; if (best > alpha) alpha = best; } }
    else        { if (score < best) { best = score; if (best < beta)  beta  = best; } }
    if (alpha >= beta) break;
  }
  return best;
}

function timeLimitedAIChooseAction(engine, timeLimitMs) {
  const rootActions = sortByCapture(engine.getLegalActions(), engine.state);
  if (!rootActions.length) return null;
  const player = engine.state.turn;
  const st = JSON.parse(JSON.stringify(engine.state));
  const deadline = Date.now() + timeLimitMs;

  let bestAction = rootActions[0];

  for (let depth = 1; depth <= 20; depth++) {
    if (Date.now() >= deadline) break;
    let depthBest = -Infinity, depthBestAction = null, timedOut = false;

    for (const action of rootActions) {
      if (Date.now() >= deadline) { timedOut = true; break; }
      const undo = makeMove(action, st);
      const score = minimaxTimed(engine, st, depth - 1, -Infinity, Infinity, player, deadline);
      unmakeMove(action, st, undo);
      if (score === TO) { timedOut = true; break; }
      if (score > depthBest) { depthBest = score; depthBestAction = action; }
    }
    if (!timedOut && depthBestAction) bestAction = depthBestAction;
    if (timedOut) break;
  }
  return bestAction;
}

// ファクトリ：timeLimitMs をクロージャで持つ AI 関数を返す
export function makeTimeLimitedAI(timeLimitMs = 10000) {
  return (engine) => timeLimitedAIChooseAction(engine, timeLimitMs);
}

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
