// plugins.js — Plugin Layer (Neo将棋 v0.4)
// StandardShogiPlugin + NoMovesWinPlugin + DoubleMovePlugin

import {
  deepClone, opp, inB,
  makeToken, makeBoard, PIECE_TAGS,
  CAN_PROMOTE, promoType, demoteType, inPromoZone, mustPromo,
  getMoves, isKingInCheck, simulateAction,
} from './engine.js?v=9';

// ── Initial position (standard shogi SFEN start) ──────────────────
const INIT_SETUP = [
  // White (rows 0-2, top of screen)
  {r:0,c:0,t:'L',o:'white'},{r:0,c:1,t:'N',o:'white'},{r:0,c:2,t:'S',o:'white'},
  {r:0,c:3,t:'G',o:'white'},{r:0,c:4,t:'K',o:'white'},{r:0,c:5,t:'G',o:'white'},
  {r:0,c:6,t:'S',o:'white'},{r:0,c:7,t:'N',o:'white'},{r:0,c:8,t:'L',o:'white'},
  {r:1,c:1,t:'R',o:'white'},{r:1,c:7,t:'B',o:'white'},
  ...Array.from({length:9},(_,c)=>({r:2,c,t:'P',o:'white'})),
  // Black (rows 6-8, bottom of screen)
  ...Array.from({length:9},(_,c)=>({r:6,c,t:'P',o:'black'})),
  {r:7,c:1,t:'B',o:'black'},{r:7,c:7,t:'R',o:'black'},
  {r:8,c:0,t:'L',o:'black'},{r:8,c:1,t:'N',o:'black'},{r:8,c:2,t:'S',o:'black'},
  {r:8,c:3,t:'G',o:'black'},{r:8,c:4,t:'K',o:'black'},{r:8,c:5,t:'G',o:'black'},
  {r:8,c:6,t:'S',o:'black'},{r:8,c:7,t:'N',o:'black'},{r:8,c:8,t:'L',o:'black'},
];

function hasPawnInCol(board, col, player) {
  for (let r=0; r<9; r++) {
    const t = board[r][col].token;
    if (t && t.owner===player && t.type==='P') return true;
  }
  return false;
}

function badDropRank(type, row, player) {
  if (player==='black') {
    if (type==='P'||type==='L') return row===0;
    if (type==='N') return row<=1;
  } else {
    if (type==='P'||type==='L') return row===8;
    if (type==='N') return row>=7;
  }
  return false;
}

// ── StandardShogiPlugin ───────────────────────────────────────────
export const StandardShogiPlugin = {
  id: 'standard_shogi',
  priority: -100,
  meta: { name: '標準将棋ルール', description: '9×9盤・8駒種・打ち駒・成り・王手放置禁止' },

  hooks: {
    on_game_init(state) {
      const s = deepClone(state);
      for (const {r,c,t,o} of INIT_SETUP)
        s.board[r][c].token = makeToken(t, o);
      return s;
    },

    get_actions(actions, state) {
      const player = state.turn;
      const out = [];

      // Board moves
      for (let r=0; r<9; r++) {
        for (let c=0; c<9; c++) {
          const token = state.board[r][c].token;
          if (!token || token.owner !== player) continue;
          const dests = getMoves(token, r, c, state.board);
          for (const {row, col} of dests) {
            const inPZ = inPromoZone(r, player) || inPromoZone(row, player);
            const cp   = CAN_PROMOTE.has(token.type) && inPZ;
            const mp   = mustPromo(token.type, row, player);
            if (cp && !mp) {
              out.push({player, tag:'move', payload:{from:{row:r,col:c}, to:{row,col}, promote:false}});
              out.push({player, tag:'move', payload:{from:{row:r,col:c}, to:{row,col}, promote:true}});
            } else {
              out.push({player, tag:'move', payload:{from:{row:r,col:c}, to:{row,col}, promote:mp}});
            }
          }
        }
      }

      // Drop moves
      const seen = new Set();
      for (const token of state.hands[player]) {
        if (seen.has(token.type)) continue;
        seen.add(token.type);
        for (let r=0; r<9; r++) {
          for (let c=0; c<9; c++) {
            if (state.board[r][c].token) continue;
            if (badDropRank(token.type, r, player)) continue;
            if (token.type==='P' && hasPawnInCol(state.board, c, player)) continue;
            out.push({player, tag:'drop', payload:{type:token.type, to:{row:r, col:c}}});
          }
        }
      }

      return [...actions, ...out];
    },

    // 王手放置禁止：移動後に自分の王が取られる状態になるなら不可
    validate_action(action, state) {
      if (action.tag === 'declare_double') return true;
      const next = simulateAction(action, state, [StandardShogiPlugin]);
      if (!next) return false;
      return !isKingInCheck(next, action.player);
    },

    apply_action(action, state) {
      if (action.tag === 'move') {
        const {from, to, promote} = action.payload;
        const s = deepClone(state);
        let token = {...s.board[from.row][from.col].token};
        const target = s.board[to.row][to.col].token;
        if (target) {
          s.hands[action.player].push(makeToken(demoteType(target.type), action.player));
        }
        s.board[from.row][from.col].token = null;
        if (promote) {
          token.type = promoType(token.type);
          const base = token.type.replace('+','');
          token.tags = ['piece','promoted',...(PIECE_TAGS[base]||[])];
        }
        s.board[to.row][to.col].token = token;
        s.global.lastMove = {from, to};
        return s;
      }
      if (action.tag === 'drop') {
        const {type, to} = action.payload;
        const s = deepClone(state);
        const idx = s.hands[action.player].findIndex(t => t.type===type);
        if (idx === -1) return null;
        const [token] = s.hands[action.player].splice(idx, 1);
        s.board[to.row][to.col].token = {...token};
        s.global.lastMove = {from:null, to};
        return s;
      }
      return null;
    },

    check_end(state) {
      // Safety net: detect king capture (shouldn't happen with proper check validation)
      let bk=false, wk=false;
      for (let r=0; r<9; r++) for (let c=0; c<9; c++) {
        const t = state.board[r][c].token;
        if (t?.type==='K') { if(t.owner==='black') bk=true; else wk=true; }
      }
      if (!bk) return 'white';
      if (!wk) return 'black';
      return null;
    },
  }
};

// ── NoMovesWinPlugin ──────────────────────────────────────────────
// 詰み（王手されて動けない）またはステイルメイト（王手でないが動けない）で
// 手番プレイヤーの負け。将棋では引き分けなし。
export const NoMovesWinPlugin = {
  id: 'no_moves_win',
  priority: 90,
  meta: {
    name: '詰み・ステイルメイト判定',
    description: '合法手がなくなったプレイヤーの負け（詰み・自玉包囲どちらも）',
  },

  hooks: {
    // getLegalActions は engine.checkEnd() から渡されるコールバック
    check_end(state, getLegalActions) {
      if (!getLegalActions) return null;
      const actions = getLegalActions();
      if (!actions.length) return opp(state.turn);
      return null;
    },
  },
};

// ── DoubleMovePlugin ──────────────────────────────────────────────
// 先手（黒・人間）専用。1局1回だけ宣言で2手連続。
export const DoubleMovePlugin = {
  id: 'double_move',
  priority: 0,
  meta: {
    name: '二手指しモード',
    description: '先手が1局に1回だけ「二手指し宣言」ができ、次の1手は手番交代しない',
  },

  hooks: {
    get_actions(actions, state) {
      // 先手（黒）専用：AIに誤用させない
      if (state.turn !== 'black') return actions;
      const used = state.global.doubleMoveUsed || {};
      if (used['black']) return actions;
      return [...actions, {
        player: 'black',
        tag:    'declare_double',
        payload: {},
      }];
    },

    apply_action(action, state) {
      if (action.tag === 'declare_double') {
        // 盤面は変わらない。after_action で skipTurnChange を設定する
        return deepClone(state);
      }
      return null;
    },

    after_action(action, state) {
      if (action.tag === 'declare_double') {
        return {
          ...state,
          global: {
            ...state.global,
            doubleMoveUsed: { ...(state.global.doubleMoveUsed || {}), black: true },
            doubleMoveRemaining: 1,  // 宣言後1手ぶん skipTurnChange を残す
            skipTurnChange: true,    // 宣言ステップ自体の手番交代を防ぐ
          },
        };
      }
      // 二手指し権利消化中：実際の指し手で skipTurnChange を消費
      const remaining = state.global.doubleMoveRemaining || 0;
      if (remaining > 0 && action.player === 'black') {
        return {
          ...state,
          global: {
            ...state.global,
            doubleMoveRemaining: remaining - 1,
            skipTurnChange: true,
          },
        };
      }
      return state;
    },
  },
};
