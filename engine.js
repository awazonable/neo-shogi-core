// engine.js — Core Layer (Neo将棋 v0.4)
// 将棋の概念は一切持たない。座標系・トークン・イベントバスのみ。

// ── Utilities ──────────────────────────────────────────────────────
let _uid = 0;
export const uid      = () => `t${++_uid}`;
export const resetUid = () => { _uid = 0; };
export const opp      = p => p === 'black' ? 'white' : 'black';
export const inB      = (r, c) => r >= 0 && r < 9 && c >= 0 && c < 9;
export const tokAt    = (board, r, c) => inB(r, c) ? board[r][c].token : null;
export const deepClone = o => JSON.parse(JSON.stringify(o));

// ── Piece definitions ──────────────────────────────────────────────
export const KANJI = {
  K_b:'王', K_w:'玉', K:'王',
  R:'飛', B:'角', G:'金', S:'銀', N:'桂', L:'香', P:'歩',
  '+R':'龍', '+B':'馬', '+S':'全', '+N':'圭', '+L':'杏', '+P':'と',
};

export function pieceKanji(token) {
  if (token.type === 'K') return token.owner === 'black' ? KANJI.K_b : KANJI.K_w;
  return KANJI[token.type] || token.type;
}

export const PIECE_TAGS = {
  K:['royal','king'], R:['rook','major'], B:['bishop','major'],
  G:['gold'], S:['silver'], N:['knight'], L:['lance'], P:['pawn'],
};

export function makeToken(type, owner) {
  const base = type.replace('+', '');
  const isP  = type.startsWith('+');
  return {
    id: uid(), owner, type,
    tags: ['piece', ...(isP ? ['promoted'] : []), ...(PIECE_TAGS[base] || [])],
    attrs: {}
  };
}

export const CAN_PROMOTE  = new Set(['R','B','S','N','L','P']);
export const promoType    = t => ({R:'+R',B:'+B',S:'+S',N:'+N',L:'+L',P:'+P'}[t] || t);
export const demoteType   = t => t.replace('+', '');
export const inPromoZone  = (row, player) => player === 'black' ? row <= 2 : row >= 6;

export function mustPromo(type, row, player) {
  if (player === 'black') {
    if (type === 'P' || type === 'L') return row === 0;
    if (type === 'N') return row <= 1;
  } else {
    if (type === 'P' || type === 'L') return row === 8;
    if (type === 'N') return row >= 7;
  }
  return false;
}

// ── Move generation ────────────────────────────────────────────────
export function getMoves(token, fr, fc, board) {
  const f = token.owner === 'black' ? -1 : 1;
  const D = {
    F:{dr:f,dc:0}, B:{dr:-f,dc:0},
    L:{dr:0,dc:-1}, R:{dr:0,dc:1},
    FL:{dr:f,dc:-1}, FR:{dr:f,dc:1},
    BL:{dr:-f,dc:-1}, BR:{dr:-f,dc:1},
  };
  const moves = [];

  function slide(dir, max=8) {
    let r=fr+dir.dr, c=fc+dir.dc, n=0;
    while (inB(r,c) && n<max) {
      const t = tokAt(board,r,c);
      if (t) { if (t.owner !== token.owner) moves.push({row:r,col:c}); break; }
      moves.push({row:r,col:c});
      r+=dir.dr; c+=dir.dc; n++;
    }
  }
  function jump(dr, dc) {
    const r=fr+dr, c=fc+dc;
    if (inB(r,c)) {
      const t = tokAt(board,r,c);
      if (!t || t.owner !== token.owner) moves.push({row:r,col:c});
    }
  }

  const G = [D.F,D.FL,D.FR,D.L,D.R,D.B];
  switch(token.type) {
    case 'K':
      [D.F,D.B,D.L,D.R,D.FL,D.FR,D.BL,D.BR].forEach(d=>jump(d.dr,d.dc)); break;
    case 'R':  [D.F,D.B,D.L,D.R].forEach(d=>slide(d)); break;
    case 'B':  [D.FL,D.FR,D.BL,D.BR].forEach(d=>slide(d)); break;
    case 'G':  G.forEach(d=>jump(d.dr,d.dc)); break;
    case 'S':  [D.F,D.FL,D.FR,D.BL,D.BR].forEach(d=>jump(d.dr,d.dc)); break;
    case 'N':  jump(f*2,-1); jump(f*2,1); break;
    case 'L':  slide(D.F); break;
    case 'P':  jump(D.F.dr, D.F.dc); break;
    case '+R':
      [D.F,D.B,D.L,D.R].forEach(d=>slide(d));
      [D.FL,D.FR,D.BL,D.BR].forEach(d=>jump(d.dr,d.dc)); break;
    case '+B':
      [D.FL,D.FR,D.BL,D.BR].forEach(d=>slide(d));
      [D.F,D.B,D.L,D.R].forEach(d=>jump(d.dr,d.dc)); break;
    case '+G': case '+S': case '+N': case '+L': case '+P':
      G.forEach(d=>jump(d.dr,d.dc)); break;
  }
  return moves;
}

// ── Board / State ──────────────────────────────────────────────────
export function makeBoard() {
  return Array.from({length:9}, (_,r) =>
    Array.from({length:9}, (_,c) => ({coord:{row:r,col:c},token:null,attrs:{}}))
  );
}

export function makeState() {
  return {
    board: makeBoard(),
    hands: {black:[],white:[]},
    zones: {black:{},white:{}},
    turn: 'black',
    moveCount: 0,
    history: [],
    rng: {seed:42,cursor:0},
    global: {}
  };
}

// ── Check detection ────────────────────────────────────────────────
export function findKingPos(state, player) {
  for (let r=0; r<9; r++) for (let c=0; c<9; c++) {
    const t = state.board[r][c].token;
    if (t?.type==='K' && t.owner===player) return {row:r, col:c};
  }
  return null;
}

// Returns true if opponent can immediately capture `player`'s king
export function isKingInCheck(state, player) {
  const kp = findKingPos(state, player);
  if (!kp) return false;
  const op = opp(player);
  for (let r=0; r<9; r++) for (let c=0; c<9; c++) {
    const t = tokAt(state.board, r, c);
    if (!t || t.owner !== op) continue;
    if (getMoves(t, r, c, state.board).some(m => m.row===kp.row && m.col===kp.col)) return true;
  }
  return false;
}

// ── Reproducible RNG (for chaos plugins) ──────────────────────────
export function nextRandom(state) {
  state.rng.cursor++;
  const x = Math.sin(state.rng.seed + state.rng.cursor) * 10000;
  return x - Math.floor(x);
}

// ── Dry-run action (no turn change, used by validate_action & AI) ──
export function simulateAction(action, state, plugins) {
  for (const p of plugins) {
    if (p.hooks?.apply_action) {
      try {
        const r = p.hooks.apply_action(action, state);
        if (r) return r;
      } catch(e) {}
    }
  }
  return null;
}

// ── Engine (Core) ─────────────────────────────────────────────────
export class NeoShogiEngine {
  constructor() { this.plugins = []; this.state = null; }

  use(plugin) {
    this.plugins.push(plugin);
    this.plugins.sort((a,b) => (a.priority||0) - (b.priority||0));
    return this;
  }

  init() {
    this.state = makeState();
    for (const p of this.plugins) {
      if (p.hooks?.on_game_init) {
        try { this.state = p.hooks.on_game_init(this.state) || this.state; }
        catch(e) { console.error(`[${p.id}] on_game_init:`, e); }
      }
    }
    return this;
  }

  getLegalActions() {
    let actions = [];
    for (const p of this.plugins) {
      if (p.hooks?.get_actions) {
        try { actions = p.hooks.get_actions(actions, this.state) || actions; }
        catch(e) { console.error(`[${p.id}] get_actions:`, e); }
      }
    }
    return actions.filter(action =>
      this.plugins.every(p => {
        if (!p.hooks?.validate_action) return true;
        try { return p.hooks.validate_action(action, this.state) !== false; }
        catch(e) { return true; }
      })
    );
  }

  step(action) {
    let skip = false;
    for (const p of this.plugins) {
      if (p.hooks?.before_action) {
        try {
          const r = p.hooks.before_action(action, this.state);
          if (r?.skip) { skip=true; if(r.state) this.state=r.state; break; }
          if (r?.state) this.state = r.state;
        } catch(e) {}
      }
    }

    if (!skip) {
      for (const p of this.plugins) {
        if (p.hooks?.apply_action) {
          try {
            const r = p.hooks.apply_action(action, this.state);
            if (r) { this.state = r; break; }
          } catch(e) { console.error(`[${p.id}] apply_action:`, e); }
        }
      }
    }

    for (const p of this.plugins) {
      if (p.hooks?.after_action) {
        try { this.state = p.hooks.after_action(action, this.state) || this.state; }
        catch(e) {}
      }
    }

    for (const p of this.plugins) {
      if (p.hooks?.on_turn_end) {
        try { this.state = p.hooks.on_turn_end(this.state) || this.state; }
        catch(e) {}
      }
    }

    if (!this.state.global.skipTurnChange) {
      this.state = {
        ...this.state,
        turn: opp(this.state.turn),
        moveCount: this.state.moveCount + 1,
      };
    }
    const g = {...this.state.global};
    delete g.skipTurnChange;
    this.state = {...this.state, global:g};

    for (const p of this.plugins) {
      if (p.hooks?.on_turn_start) {
        try { this.state = p.hooks.on_turn_start(this.state) || this.state; }
        catch(e) {}
      }
    }

    return this.checkEnd();
  }

  checkEnd() {
    // Pass a getLegalActions callback so plugins can detect no-moves (詰み/ステイルメイト)
    const getActions = () => this.getLegalActions();
    for (const p of this.plugins) {
      if (p.hooks?.check_end) {
        try {
          const r = p.hooks.check_end(this.state, getActions);
          if (r != null) return r;
        } catch(e) {}
      }
    }
    return null;
  }
}
