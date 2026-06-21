// plugins-extra.js — 変則ルールプラグイン集 (Neo将棋)
// 各プラグインは独立。StandardShogiPlugin + NoMovesWinPlugin と任意で組み合わせ可能。

import {
  deepClone, opp, makeToken, demoteType, nextRandom, CAN_PROMOTE,
} from './engine.js?v=5';

// 駒の点数（駒取り将棋用）
const PIECE_POINTS = {
  P:1, '+P':1, L:3, '+L':3, N:3, '+N':3,
  S:5, '+S':5, G:5, '+G':5, B:7, '+B':7, R:8, '+R':8, K:0,
};

// before_action の時点ではまだ盤面が変わっていないため、
// 着地先に敵駒がいるか確認できる
function capturedAt(action, state) {
  if (action.tag !== 'move') return null;
  const { to } = action.payload;
  const t = state.board[to.row]?.[to.col]?.token;
  return (t && t.owner !== action.player) ? t : null;
}

// ── 1. 逆将棋 ─────────────────────────────────────────────────────
// 合法手がなくなったプレイヤーが「勝ち」。NoMovesWinPlugin と排他。
export const ReverseWinPlugin = {
  id: 'reverse_win', priority: 90,
  meta: { name: '逆将棋', description: '詰まされた（合法手がなくなった）方が勝ち' },
  hooks: {
    check_end(state, getLegalActions) {
      if (!getLegalActions) return null;
      return getLegalActions().length === 0 ? state.turn : null;
    },
  },
};

// ── 2. 爆発将棋 ───────────────────────────────────────────────────
// 移動後に 30% の確率で着地点周囲 1 マスを爆発消滅（手駒に入らない）
export const ExplosivePiecePlugin = {
  id: 'explosive_piece', priority: 20,
  meta: { name: '爆発将棋', description: '移動後30%の確率で着地周囲1マスが爆発消滅する' },
  hooks: {
    after_action(action, state) {
      if (action.tag !== 'move') return state;
      const { to } = action.payload;
      const s = deepClone(state);
      const rand = nextRandom(s);           // reproducible RNG（s.rng を更新）
      if (rand > 0.30) return s;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const r = to.row + dr, c = to.col + dc;
          if (r < 0 || r > 8 || c < 0 || c > 8) continue;
          s.board[r][c].token = null;       // 爆発消滅（手駒にも入らない）
        }
      }
      s.global.lastExplosion = { row: to.row, col: to.col }; // UI ヒント用
      return s;
    },
  },
};

// ── 3. 特攻将棋（カミカゼ）─────────────────────────────────────
// 駒を取ったとき、取った駒も盤上から消える（手駒は取られ駒のみ残る）
export const KamikazePlugin = {
  id: 'kamikaze', priority: 12,
  meta: { name: '特攻将棋', description: '敵駒を取ったとき、取った駒も盤上から消滅する' },
  hooks: {
    before_action(action, state) {
      const cap = capturedAt(action, state);
      if (!cap) return {};
      return { state: { ...state, global: { ...state.global, _kamikaze: true } } };
    },
    after_action(action, state) {
      const triggered = state.global._kamikaze;
      const g = { ...state.global };
      delete g._kamikaze;
      if (!triggered || action.tag !== 'move') return { ...state, global: g };
      const { to } = action.payload;
      const s = deepClone({ ...state, global: g });
      s.board[to.row][to.col].token = null; // 取った駒も消滅
      return s;
    },
  },
};

// ── 4. 取り捨て将棋 ───────────────────────────────────────────────
// 取った駒は手駒に入らず消滅する（持ち駒なしモード）
export const ExileOnCapturePlugin = {
  id: 'exile_on_capture', priority: 10,
  meta: { name: '取り捨て将棋', description: '取った駒は手駒に入らず消滅する' },
  hooks: {
    before_action(action, state) {
      const cap = capturedAt(action, state);
      return {
        state: {
          ...state, global: {
            ...state.global,
            _exileHandSize: cap ? state.hands[action.player].length : undefined,
          },
        },
      };
    },
    after_action(action, state) {
      const prev = state.global._exileHandSize;
      const g = { ...state.global };
      delete g._exileHandSize;
      if (prev === undefined || action.tag !== 'move') return { ...state, global: g };
      const hand = state.hands[action.player];
      if (hand.length > prev) {
        // StandardShogiPlugin が最後に追加した駒（捕獲駒）を取り除く
        return {
          ...state, global: g,
          hands: { ...state.hands, [action.player]: hand.slice(0, prev) },
        };
      }
      return { ...state, global: g };
    },
  },
};

// ── 5. 降伏将棋 ───────────────────────────────────────────────────
// 取った駒は手駒に入らず、取った側の駒として「from」に残る（陣地交換）
export const DefectionPlugin = {
  id: 'defection', priority: 5,
  meta: { name: '降伏将棋', description: '取られた駒は相手の色に変わり、攻撃元マスに残る' },
  hooks: {
    before_action(action, state) {
      const cap = capturedAt(action, state);
      if (!cap) return {};
      const { from } = action.payload;
      return {
        state: {
          ...state, global: {
            ...state.global,
            _defection: { type: cap.type, fromRow: from.row, fromCol: from.col },
          },
        },
      };
    },
    after_action(action, state) {
      const info = state.global._defection;
      const g = { ...state.global };
      delete g._defection;
      if (!info || action.tag !== 'move') return { ...state, global: g };
      const s = deepClone({ ...state, global: g });
      const demoted = demoteType(info.type);
      // StandardShogiPlugin が追加した捕獲駒を手駒から取り除く
      const hand = s.hands[action.player];
      const idx = hand.findIndex(t => t.type === demoted);
      if (idx !== -1) {
        hand.splice(idx, 1);
        // 取った側の色で from マスに配置（降伏）
        s.board[info.fromRow][info.fromCol].token = makeToken(demoted, action.player);
      }
      return s;
    },
  },
};

// ── 6. 必取将棋 ───────────────────────────────────────────────────
// 取れる手があれば必ず取らなければならない
export const BerserkerPlugin = {
  id: 'berserker', priority: -50,
  meta: { name: '必取将棋', description: '取れる手がある場合、必ず取らなければならない' },
  hooks: {
    get_actions(actions, state) {
      const captures = actions.filter(a => {
        if (a.tag !== 'move') return false;
        const { to } = a.payload;
        const t = state.board[to.row]?.[to.col]?.token;
        return t && t.owner !== a.player;
      });
      return captures.length > 0 ? captures : actions;
    },
  },
};

// ── 7. どこでも成り将棋 ───────────────────────────────────────────
// 成れる駒はどのマスからでもどのマスへでも成れる
export const PromoteAnywherePlugin = {
  id: 'promote_anywhere', priority: -80,
  meta: { name: 'どこでも成り', description: '成れる駒はどこからでも・どこへでも成れる' },
  hooks: {
    get_actions(actions, state) {
      // すでに promote:true がある from→to ペアは追加しない
      const hasPromo = new Set(
        actions
          .filter(a => a.tag === 'move' && a.payload.promote)
          .map(a => `${a.payload.from.row},${a.payload.from.col}>${a.payload.to.row},${a.payload.to.col}`)
      );
      const extra = [];
      for (const a of actions) {
        if (a.tag !== 'move' || a.payload.promote) continue;
        const { from, to } = a.payload;
        const token = state.board[from.row]?.[from.col]?.token;
        if (!token || !CAN_PROMOTE.has(token.type)) continue;
        const key = `${from.row},${from.col}>${to.row},${to.col}`;
        if (!hasPromo.has(key)) extra.push({ ...a, payload: { ...a.payload, promote: true } });
      }
      return [...actions, ...extra];
    },
  },
};

// ── 8. 縮小将棋 ───────────────────────────────────────────────────
// 10 手ごとに外周 1 段が消滅し、そこにいた駒は相手の手駒になる
export const ShrinkBoardPlugin = {
  id: 'shrink_board', priority: 30,
  meta: { name: '縮小将棋', description: '10手ごとに盤の外周1段が消え、駒は相手の手駒になる' },
  hooks: {
    validate_action(action, state) {
      const bound = state.global.shrinkBound || 0;
      if (!bound) return true;
      const ok = (r, c) => r >= bound && r < 9 - bound && c >= bound && c < 9 - bound;
      if (action.tag === 'move') return ok(action.payload.to.row, action.payload.to.col);
      if (action.tag === 'drop') return ok(action.payload.to.row, action.payload.to.col);
      return true;
    },
    on_turn_end(state) {
      // on_turn_end は手番交代 "前" に呼ばれる。moveCount はまだ加算されていない
      if ((state.moveCount + 1) % 10 !== 0) return state;
      const oldBound = state.global.shrinkBound || 0;
      const newBound = oldBound + 1;
      if (newBound >= 4) return state; // 1×1 以下にはしない
      const s = deepClone(state);
      // 新たに除外されるリング（oldBound 行/列）の駒を相手手駒へ
      for (let r = oldBound; r < 9 - oldBound; r++) {
        for (let c = oldBound; c < 9 - oldBound; c++) {
          if (r !== oldBound && r !== 8 - oldBound && c !== oldBound && c !== 8 - oldBound) continue;
          const token = s.board[r][c].token;
          if (!token) continue;
          s.hands[opp(token.owner)].push(makeToken(demoteType(token.type), opp(token.owner)));
          s.board[r][c].token = null;
        }
      }
      s.global.shrinkBound = newBound;
      return s;
    },
  },
};

// ── 9. 重力将棋 ───────────────────────────────────────────────────
// 各手の後に全駒が盤の下（row 8 方向）へ落ちる
export const GravityPlugin = {
  id: 'gravity', priority: 25,
  meta: { name: '重力将棋', description: '各手の後、全ての駒が重力で下（後手陣方向）へ落ちる' },
  hooks: {
    after_action(action, state) {
      if (action.tag === 'declare_double') return state;
      const s = deepClone(state);
      for (let c = 0; c < 9; c++) {
        const tokens = [];
        for (let r = 0; r < 9; r++) {
          if (s.board[r][c].token) {
            tokens.push(s.board[r][c].token);
            s.board[r][c].token = null;
          }
        }
        // 下から積む（元の上下順を維持）
        for (let i = 0; i < tokens.length; i++) {
          s.board[8 - i][c].token = tokens[tokens.length - 1 - i];
        }
      }
      return s;
    },
  },
};

// ── 10. 駒取り将棋 ────────────────────────────────────────────────
// 先に targetPoints 点分の駒を取った方が勝ち
// 点数: 歩=1, 香桂=3, 銀金=5, 角=7, 飛=8
export const CaptureWinPlugin = (targetPoints = 20) => ({
  id: 'capture_win', priority: 8,
  meta: {
    name: `駒取り将棋（${targetPoints}点先取）`,
    description: `駒を取ってポイントを積み、${targetPoints}点先取した方の勝ち。歩1/香桂3/銀金5/角7/飛8点`,
  },
  hooks: {
    before_action(action, state) {
      const cap = capturedAt(action, state);
      if (!cap) return {};
      return {
        state: { ...state, global: { ...state.global, _capPts: PIECE_POINTS[cap.type] || 1 } },
      };
    },
    after_action(action, state) {
      const pts = state.global._capPts;
      const g = { ...state.global };
      delete g._capPts;
      if (!pts || action.tag !== 'move') return { ...state, global: g };
      const scores = { black: 0, white: 0, ...(g.captureScores || {}) };
      scores[action.player] += pts;
      return { ...state, global: { ...g, captureScores: scores } };
    },
    check_end(state) {
      const sc = state.global.captureScores || {};
      if ((sc.black || 0) >= targetPoints) return 'black';
      if ((sc.white || 0) >= targetPoints) return 'white';
      return null;
    },
  },
});

// ── 追加駒プラグイン用 共通ユーティリティ ─────────────────────────
// 8方向スライド（クイーン・飛び角用）
function slideMoves(token, row, col, board, dirs) {
  const moves = [];
  for (const [dr, dc] of dirs) {
    let r = row + dr, c = col + dc;
    while (r >= 0 && r < 9 && c >= 0 && c < 9) {
      const t = board[r][c].token;
      if (!t) { moves.push({ row: r, col: c }); }
      else { if (t.owner !== token.owner) moves.push({ row: r, col: c }); break; }
      r += dr; c += dc;
    }
  }
  return moves;
}

// ジャンプ移動（桂馬系）
function jumpMoves(token, row, col, board, offsets) {
  const moves = [];
  for (const [dr, dc] of offsets) {
    const r = row + dr, c = col + dc;
    if (r < 0 || r > 8 || c < 0 || c > 8) continue;
    const t = board[r][c].token;
    if (!t || t.owner !== token.owner) moves.push({ row: r, col: c });
  }
  return moves;
}

// get_actions のボイラープレート（盤上の手 + 持ち駒打ち）
function extraPieceActions(state, type, moveFn) {
  const player = state.turn;
  const extra = [];

  // 盤上の駒の移動
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
    const token = state.board[r][c].token;
    if (!token || token.owner !== player || token.type !== type) continue;
    for (const dest of moveFn(token, r, c, state.board)) {
      extra.push({ player, tag: 'move', payload: { from: { row:r, col:c }, to: dest, promote: false } });
    }
  }

  // 持ち駒の打ち（持ち駒に type があるとき）
  if (state.hands[player].some(t => t.type === type)) {
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
      if (!state.board[r][c].token)
        extra.push({ player, tag: 'drop', payload: { type, to: { row:r, col:c } } });
    }
  }

  return extra;
}

// ── 11. クイーン（女王）──────────────────────────────────────────
// 全8方向スライダー。各プレイヤーの持ち駒として1枚追加。成れない。
const Q_DIRS = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]];
export const QueenPlugin = {
  id: 'queen_piece', priority: -90,
  meta: { name: 'クイーン追加', description: '全方向スライダー。各プレイヤーに持ち駒1枚追加（飛車+角の合体）' },
  hooks: {
    on_game_init(state) {
      const s = deepClone(state);
      s.hands.black.push(makeToken('Q', 'black'));
      s.hands.white.push(makeToken('Q', 'white'));
      return s;
    },
    get_actions(actions, state) {
      return [...actions, ...extraPieceActions(state, 'Q',
        (t, r, c, b) => slideMoves(t, r, c, b, Q_DIRS))];
    },
  },
};

// ── 12. 全方向桂（跳馬）─────────────────────────────────────────
// チェスのナイトと同様に8方向に桂馬跳び。各プレイヤーに1枚追加。
const CK_OFFSETS = [[-2,-1],[-2,1],[2,-1],[2,1],[-1,-2],[-1,2],[1,-2],[1,2]];
export const CrazyKnightPlugin = {
  id: 'crazy_knight', priority: -90,
  meta: { name: '全方向桂追加', description: 'チェスのナイト同様、全8方向に桂馬跳び。各プレイヤーに1枚追加' },
  hooks: {
    on_game_init(state) {
      const s = deepClone(state);
      s.hands.black.push(makeToken('CK', 'black'));
      s.hands.white.push(makeToken('CK', 'white'));
      return s;
    },
    get_actions(actions, state) {
      return [...actions, ...extraPieceActions(state, 'CK',
        (t, r, c, b) => jumpMoves(t, r, c, b, CK_OFFSETS))];
    },
  },
};

// ── 13. 忍者（瞬間移動）─────────────────────────────────────────
// 盤上の任意の空きマスへ瞬間移動、または任意の敵駒を取る。
// 手駒には入れず、存在するだけでプレッシャーをかける変則駒。
export const NinjaPlugin = {
  id: 'ninja_piece', priority: -90,
  meta: { name: '忍者追加', description: '任意の空きマスへ瞬間移動・任意の敵駒を取れる超機動駒。各プレイヤーに1枚追加' },
  hooks: {
    on_game_init(state) {
      const s = deepClone(state);
      s.hands.black.push(makeToken('NJ', 'black'));
      s.hands.white.push(makeToken('NJ', 'white'));
      return s;
    },
    get_actions(actions, state) {
      const player = state.turn;
      const extra = [];
      let ninjaPos = null;
      for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
        const t = state.board[r][c].token;
        if (t && t.owner === player && t.type === 'NJ') { ninjaPos = {r, c}; break; }
      }
      if (ninjaPos) {
        const {r, c} = ninjaPos;
        for (let tr = 0; tr < 9; tr++) for (let tc = 0; tc < 9; tc++) {
          if (tr === r && tc === c) continue;
          const target = state.board[tr][tc].token;
          if (!target || target.owner !== player) {
            extra.push({ player, tag: 'move', payload: { from:{row:r,col:c}, to:{row:tr,col:tc}, promote:false }});
          }
        }
      }
      // 打ち
      if (state.hands[player].some(t => t.type === 'NJ')) {
        for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
          if (!state.board[r][c].token)
            extra.push({ player, tag: 'drop', payload: { type:'NJ', to:{row:r,col:c} }});
        }
      }
      return [...actions, ...extra];
    },
  },
};

// ── 追加駒の表示名（ui.js で利用）───────────────────────────────
export const EXTRA_KANJI = { Q: '女', CK: '跳', NJ: '忍' };
