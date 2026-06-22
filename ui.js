// ui.js — UI Layer (Neo将棋 v0.4)
// DOM描画・イベント処理・ゲーム設定モーダル

import {
  NeoShogiEngine, resetUid, opp,
  KANJI, pieceKanji, promoType, makeToken, deepClone,
} from './engine.js?v=7';

import {
  StandardShogiPlugin,
  NoMovesWinPlugin,
  DoubleMovePlugin,
} from './plugins.js?v=7';

import {
  randomAIChooseAction,
  level1AIChooseAction,
  level2AIChooseAction,
  level3AIChooseAction,
  makeTimeLimitedAI,
} from './ai.js?v=7';

import {
  ReverseWinPlugin,
  ExplosivePiecePlugin,
  KamikazePlugin,
  ExileOnCapturePlugin,
  DefectionPlugin,
  BerserkerPlugin,
  PromoteAnywherePlugin,
  ShrinkBoardPlugin,
  GravityPlugin,
  CaptureWinPlugin,
  QueenPlugin,      QueenMovePlugin,
  CrazyKnightPlugin, CrazyKnightMovePlugin,
  NinjaPlugin,      NinjaMovePlugin,
  EXTRA_KANJI,
} from './plugins-extra.js?v=7';

// ── UI State ─────────────────────────────────────────────────────
let engine        = null;
let selectedCell  = null;   // {type:'board',row,col} | {type:'hand',player,pieceType}
let legalActions  = [];
let legalDests    = new Set();
let gameOver      = false;
let isAITurn      = false;
let aiEnabled     = true;
let aiChooseFn    = level1AIChooseAction;
let hasDoubleMove = false;
let captureWinActive = false;

// isAITurn の切り替えと同時に CSS クラスを付け、
// CSS レベルで全ポインターイベントをブロックする
function setAITurn(flag) {
  isAITurn = flag;
  document.body.classList.toggle('ai-thinking', flag);
}

// ── 2文字駒名 ────────────────────────────────────────────────────
let useTwoCharLabels = false;
const KANJI_2 = {
  P:'歩兵', '+P':'と金', L:'香車', '+L':'成香', N:'桂馬', '+N':'成桂',
  S:'銀将', '+S':'成銀', G:'金将', '+G':'金将', B:'角行', '+B':'龍馬',
  R:'飛車', '+R':'龍王', Q:'女王', CK:'跳馬', NJ:'忍者',
};

function pieceKanjiEx(token) {
  if (useTwoCharLabels) {
    if (token.type === 'K') return token.owner === 'black' ? '王将' : '玉将';
    return KANJI_2[token.type] || EXTRA_KANJI[token.type] || pieceKanji(token);
  }
  return EXTRA_KANJI[token.type] || pieceKanji(token);
}

// ── 棋譜（リプレイ）────────────────────────────────────────────
// replayHistory[0] = ゲーム開始直後の state
// replayHistory[N] = N手目の action 後の state
let replayHistory = [];    // { action, state }[]
let replayIndex   = -1;    // -1 = 再生中ではない
let replayDisplayState = null; // null = engine.state を使用

function getRenderState() {
  return replayDisplayState || engine.state;
}

// ── カスタム初期配置 ──────────────────────────────────────────────
// null = 標準配置。Array(9).fill(…) 形式: 各セルが {type, owner} | null
let customLayout = null;

function makeCustomInitPlugin(layout) {
  return {
    // priority 50 = StandardShogiPlugin(-100)・追加駒Plugin(-90) より後に実行
    // → 標準配置と手駒追加を上書きして盤面だけカスタムにする
    id: 'custom_init', priority: 50,
    hooks: {
      on_game_init(state) {
        const s = deepClone(state);
        // 盤だけクリア（手駒は他プラグインが追加したものを保持）
        for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) s.board[r][c].token = null;
        for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
          const item = layout[r][c];
          if (item) s.board[r][c].token = makeToken(item.type, item.owner);
        }
        return s;
      },
    },
  };
}

function getStandardLayout() {
  const tmp = new NeoShogiEngine();
  tmp.use(StandardShogiPlugin);
  tmp.init();
  return tmp.state.board.map(row => row.map(cell =>
    cell.token ? { type: cell.token.type, owner: cell.token.owner } : null
  ));
}

const COL_KANJI = ['9','8','7','6','5','4','3','2','1'];
const ROW_KANJI = ['一','二','三','四','五','六','七','八','九'];

// ── Rendering ────────────────────────────────────────────────────
function buildLabels() {
  const colEl = document.getElementById('col-labels');
  colEl.innerHTML = '';
  COL_KANJI.forEach(n => {
    const d = document.createElement('div');
    d.className = 'col-label';
    d.textContent = n;
    colEl.appendChild(d);
  });
  const rowEl = document.getElementById('row-labels');
  rowEl.innerHTML = '';
  ROW_KANJI.forEach(n => {
    const d = document.createElement('div');
    d.className = 'row-label';
    d.textContent = n;
    rowEl.appendChild(d);
  });
}

function renderAll() {
  renderBoard();
  renderHands();
  renderStatus();
  renderDoubleBtn();
}

function renderBoard() {
  const boardEl = document.getElementById('board');
  boardEl.innerHTML = '';
  const state = getRenderState();
  const lm    = state.global.lastMove;
  const bound = state.global.shrinkBound || 0;
  const expl  = state.global.lastExplosion;

  for (let r=0; r<9; r++) {
    for (let c=0; c<9; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';

      const isShrunk   = bound > 0 && (r < bound || r >= 9-bound || c < bound || c >= 9-bound);
      const isSelBoard = !replayDisplayState && selectedCell?.type==='board' && selectedCell.row===r && selectedCell.col===c;
      const isLegal    = !isShrunk && !replayDisplayState && legalDests.has(`${r},${c}`);
      const isLastFrom = lm?.from && lm.from.row===r && lm.from.col===c;
      const isLastTo   = lm?.to   && lm.to.row===r   && lm.to.col===c;
      const isExploded = expl && Math.abs(r-expl.row)<=1 && Math.abs(c-expl.col)<=1;

      if (isShrunk)         cell.classList.add('shrunk');
      else if (isSelBoard)  cell.classList.add('sel');
      else if (isLegal)     cell.classList.add('legal');
      else if (isExploded)  cell.classList.add('exploded');
      else if (isLastFrom)  cell.classList.add('last-from');
      else if (isLastTo)    cell.classList.add('last-to');

      const token = state.board[r][c].token;
      if (token) {
        const piece = document.createElement('div');
        piece.className = 'piece' +
          (token.owner==='white' ? ' white' : '') +
          (token.type.startsWith('+') ? ' promo' : '') +
          (useTwoCharLabels ? ' two-char' : '');
        piece.textContent = pieceKanjiEx(token);
        cell.appendChild(piece);
      }

      cell.addEventListener('click', () => handleCellClick(r, c));
      boardEl.appendChild(cell);
    }
  }
}

function renderHands() {
  renderHand('white');
  renderHand('black');
}

function renderHand(player) {
  const el = document.getElementById(player + '-pieces');
  el.innerHTML = '';
  const hand   = getRenderState().hands[player];
  const counts = {};
  for (const t of hand) counts[t.type] = (counts[t.type]||0) + 1;
  const entries = Object.entries(counts);

  if (!entries.length) {
    el.innerHTML = '<div class="no-pieces">なし</div>';
    return;
  }

  for (const [type, count] of entries) {
    const div = document.createElement('div');
    div.className = 'hp';
    const isSel = selectedCell?.type==='hand' && selectedCell.player===player && selectedCell.pieceType===type;
    if (isSel) div.classList.add('sel');

    // 駒の背景付きで描画（盤上の駒と同じ piece クラスを小さくしたもの）
    const pieceEl = document.createElement('div');
    pieceEl.className = 'piece hp-piece' + (player === 'white' ? ' white' : '');
    pieceEl.textContent = EXTRA_KANJI[type] || KANJI[type] || type;
    div.appendChild(pieceEl);

    if (count > 1) {
      const nEl = document.createElement('span');
      nEl.className = 'hp-n';
      nEl.textContent = `×${count}`;
      div.appendChild(nEl);
    }

    div.addEventListener('click', () => handleHandClick(player, type));
    el.appendChild(div);
  }
}

function renderStatus() {
  const el = document.getElementById('status');
  const scoreBar = document.getElementById('score-bar');

  // スコアバー（駒取り将棋）
  if (captureWinActive && engine) {
    const sc = engine.state.global.captureScores || { black: 0, white: 0 };
    scoreBar.style.display = '';
    scoreBar.textContent = `先手 ${sc.black||0}点 ／ 後手 ${sc.white||0}点（目標:20点）`;
  } else {
    scoreBar.style.display = 'none';
  }

  if (gameOver) {
    el.textContent = gameOver==='black' ? '先手(黒)の勝ち！' : '後手(白)の勝ち！';
    return;
  }
  if (isAITurn) { el.textContent = 'AIが考えています…'; return; }
  const turn = engine.state.turn;
  // 縮小将棋: 残り手数ヒント
  const bound = engine.state.global.shrinkBound || 0;
  const nextShrink = 10 - (engine.state.moveCount % 10);
  const shrinkHint = bound > 0 || nextShrink <= 10
    ? (bound > 0 ? ` ／ 縮小Lv${bound}` : '') + ` ／ 次縮小まで${nextShrink}手`
    : '';
  const base = turn==='black' ? '先手(黒)のターン' : '後手(白)のターン (AI)';
  el.textContent = engine.state.global.shrinkBound !== undefined || document.getElementById('opt-shrink')?.checked
    ? base + shrinkHint : base;
}

function renderDoubleBtn() {
  const btn = document.getElementById('btn-declare-double');
  if (!btn) return;
  if (!hasDoubleMove || gameOver || isAITurn) {
    btn.style.display = 'none';
    return;
  }
  const used = engine.state.global.doubleMoveUsed || {};
  const turn = engine.state.turn;
  // 宣言ボタンは先手（黒・人間）のターンかつ未使用のときのみ表示
  if (turn === 'black' && !used['black']) {
    btn.style.display = '';
  } else {
    btn.style.display = 'none';
  }
}

// ── Events ───────────────────────────────────────────────────────
function clearSel() {
  selectedCell = null;
  legalActions = [];
  legalDests   = new Set();
}

function handleCellClick(row, col) {
  if (gameOver || isAITurn) return;
  const state = engine.state;

  if (selectedCell && legalDests.has(`${row},${col}`)) {
    if (selectedCell.type === 'hand') {
      const a = legalActions.find(a => a.tag==='drop' && a.payload.to.row===row && a.payload.to.col===col);
      if (a) executeAction(a);
    } else {
      const matches = legalActions.filter(a => a.tag==='move' && a.payload.to.row===row && a.payload.to.col===col);
      if (!matches.length) return;
      if (matches.length === 1) {
        executeAction(matches[0]);
      } else {
        const wp = matches.find(a => a.payload.promote);
        const np = matches.find(a => !a.payload.promote);
        if (wp && np) showPromoDialog(wp, np);
        else executeAction(matches[0]);
      }
    }
    return;
  }

  const token = state.board[row][col].token;
  if (token && token.owner === state.turn) {
    // 既に選択中の同じ駒をクリック → 選択キャンセル
    if (selectedCell?.type === 'board' && selectedCell.row === row && selectedCell.col === col) {
      clearSel();
      renderAll();
      return;
    }
    clearSel();
    const all = engine.getLegalActions();
    legalActions = all.filter(a => a.tag==='move' && a.payload.from.row===row && a.payload.from.col===col);
    legalDests   = new Set(legalActions.map(a => `${a.payload.to.row},${a.payload.to.col}`));
    selectedCell = {type:'board', row, col};
    renderAll();
    return;
  }

  clearSel();
  renderAll();
}

function handleHandClick(player, pieceType) {
  if (gameOver || isAITurn) return;
  if (player !== engine.state.turn) return;

  if (selectedCell?.type==='hand' && selectedCell.player===player && selectedCell.pieceType===pieceType) {
    clearSel(); renderAll(); return;
  }

  clearSel();
  const all    = engine.getLegalActions();
  legalActions = all.filter(a => a.tag==='drop' && a.payload.type===pieceType);
  legalDests   = new Set(legalActions.map(a => `${a.payload.to.row},${a.payload.to.col}`));
  selectedCell = {type:'hand', player, pieceType};
  renderAll();
}

// ── Action execution ─────────────────────────────────────────────
function pushHistory(action) {
  replayHistory.push({ action, state: deepClone(engine.state) });
}

function executeAction(action) {
  clearSel();
  const result = engine.step(action);
  pushHistory(action);
  if (result) {
    gameOver = result;
    renderAll();
    showWinner(result);
    return;
  }
  renderAll();

  if (aiEnabled && engine.state.turn === 'white' && !gameOver) {
    setAITurn(true);
    renderStatus();
    setTimeout(doAITurn, 350 + Math.random() * 250);
  }
}

function doAITurn() {
  // AI手番前に事前選択をクリア（先行入力防止）
  clearSel();

  const action = aiChooseFn(engine);
  setAITurn(false);

  if (!action) {
    gameOver = 'black';
    renderAll();
    showWinner('black');
    return;
  }

  const result = engine.step(action);
  pushHistory(action);
  if (result) {
    gameOver = result;
    renderAll();
    showWinner(result);
    return;
  }
  renderAll();

  if (aiEnabled && engine.state.turn === 'white' && !gameOver) {
    setAITurn(true);
    renderStatus();
    setTimeout(doAITurn, 200);
  }
}

// ── Promotion dialog ─────────────────────────────────────────────
function showPromoDialog(withP, withoutP) {
  const type = withoutP.payload.from
    ? engine.state.board[withoutP.payload.from.row][withoutP.payload.from.col].token?.type
    : null;
  document.getElementById('p-before').textContent = type ? (KANJI[type]||type) : '?';
  document.getElementById('p-after').textContent  = type ? (KANJI[promoType(type)]||promoType(type)) : '?';
  document.getElementById('overlay').style.display = 'block';
  document.getElementById('promo-dialog').style.display = 'block';
  document.getElementById('btn-promo-yes').onclick = () => { hidePromoDialog(); executeAction(withP); };
  document.getElementById('btn-promo-no').onclick  = () => { hidePromoDialog(); executeAction(withoutP); };
}

function hidePromoDialog() {
  document.getElementById('overlay').style.display      = 'none';
  document.getElementById('promo-dialog').style.display = 'none';
}

// ── Winner overlay ────────────────────────────────────────────────
function showWinner(winner) {
  const title = winner==='black' ? '先手(黒)の勝ち！' : '後手(白)の勝ち！';
  const msg   = winner==='black' ? '後手の合法手がなくなりました' : '先手の合法手がなくなりました';
  document.getElementById('winner-title').textContent = title;
  document.getElementById('winner-msg').textContent   = msg;
  document.getElementById('winner-mini-text').textContent = title;
  document.getElementById('winner-mini').style.display = 'none';
  document.getElementById('winner-overlay').classList.add('show');
}

// ── 棋譜再生 ─────────────────────────────────────────────────────
function enterReplay() {
  if (!replayHistory.length) return;
  replayIndex = replayHistory.length - 1;       // 最終局面から
  replayDisplayState = replayHistory[replayIndex].state;
  hideWinner();
  document.getElementById('replay-controls').classList.add('show');
  renderAll();
  updateReplayInfo();
}

function exitReplay() {
  replayIndex       = -1;
  replayDisplayState = null;
  document.getElementById('replay-controls').classList.remove('show');
  renderAll();
  if (gameOver) showWinner(gameOver);
}

function stepReplay(delta) {
  const next = Math.max(0, Math.min(replayHistory.length - 1, replayIndex + delta));
  replayIndex       = next;
  replayDisplayState = replayHistory[next].state;
  renderAll();
  updateReplayInfo();
}

function updateReplayInfo() {
  const total = replayHistory.length - 1;
  const cur   = replayIndex;
  const h     = replayHistory[cur];
  let label = `${cur}/${total} 手`;
  if (h.action && h.action.player) {
    label += ` (${h.action.player === 'black' ? '先手' : '後手'})`;
  }
  document.getElementById('replay-info').textContent = label;
}

function exportGame() {
  const data = {
    format:  'NeoShogi-v1',
    date:    new Date().toISOString().split('T')[0],
    result:  gameOver || 'unknown',
    plugins: engine.plugins.map(p => p.id),
    moves:   replayHistory.slice(1).map(h => h.action).filter(Boolean),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href: url, download: `neo-shogi-${Date.now()}.json`
  });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function hideWinner() {
  document.getElementById('winner-overlay').classList.remove('show');
  document.getElementById('winner-mini').style.display = 'none';
}

function minimizeWinner() {
  document.getElementById('winner-overlay').classList.remove('show');
  document.getElementById('winner-mini').style.display = 'flex';
}

function restoreWinner() {
  document.getElementById('winner-mini').style.display = 'none';
  document.getElementById('winner-overlay').classList.add('show');
}

// ── Board Editor ──────────────────────────────────────────────────
// 全駒種パレット定義
const PALETTE_PIECES = ['P','L','N','S','G','B','R','K','+P','+L','+N','+S','+B','+R'];

let editorLayout = null;       // 編集中の盤面
let selectedPalette = null;    // {type, owner} | null（null=消去）

function openEditor() {
  editorLayout = customLayout
    ? customLayout.map(row => row.map(c => c ? {...c} : null))
    : getStandardLayout();
  selectedPalette = null;
  buildPalette();
  renderEditorBoard();
  document.getElementById('editor-overlay').style.display = 'block';
  document.getElementById('editor-modal').style.display   = 'block';
}

function closeEditor() {
  document.getElementById('editor-overlay').style.display = 'none';
  document.getElementById('editor-modal').style.display   = 'none';
}

function getActivePieceTypes() {
  // パレットには常に全追加駒種を表示（プラグイン選択状態に依存しない）
  return ['Q', 'CK', 'NJ'];
}

function buildPalette() {
  const el = document.getElementById('editor-palette');
  el.innerHTML = '';

  // 消去タイル
  const eraser = document.createElement('div');
  eraser.className = 'palette-tile eraser' + (selectedPalette === null ? ' selected' : '');
  eraser.textContent = '✕';
  eraser.title = '消去';
  eraser.onclick = () => { selectedPalette = null; buildPalette(); };
  el.appendChild(eraser);

  // 追加駒タイプ（プラグイン選択中のもの）も含める
  const allTypes = [...PALETTE_PIECES, ...getActivePieceTypes()];

  for (const owner of ['black', 'white']) {
    const lbl = document.createElement('div');
    lbl.className = 'palette-group-label';
    lbl.textContent = owner === 'black' ? '先手(黒)' : '後手(白)';
    el.appendChild(lbl);

    for (const type of allTypes) {
      const tile = document.createElement('div');
      const isSel = selectedPalette?.type === type && selectedPalette?.owner === owner;
      tile.className = 'palette-tile' + (owner === 'white' ? ' white-piece' : '') + (isSel ? ' selected' : '');
      const kanji = useTwoCharLabels
        ? (type === 'K' ? (owner === 'black' ? '王将' : '玉将') : KANJI_2[type] || EXTRA_KANJI[type] || type)
        : (EXTRA_KANJI[type] || KANJI[type] || type);
      tile.textContent = kanji;
      tile.title = `${owner === 'black' ? '先手' : '後手'} ${type}`;
      tile.onclick = () => { selectedPalette = { type, owner }; buildPalette(); };
      el.appendChild(tile);
    }
  }
}

function renderEditorBoard() {
  const el = document.getElementById('editor-board');
  el.innerHTML = '';
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const cell = document.createElement('div');
      cell.className = 'editor-cell';
      const item = editorLayout[r][c];
      if (item) {
        const piece = document.createElement('div');
        piece.className = 'piece' +
          (item.owner === 'white' ? ' white' : '') +
          (item.type.startsWith('+') ? ' promo' : '');
        piece.textContent = EXTRA_KANJI[item.type] || KANJI[item.type] || item.type;
        cell.appendChild(piece);
      }
      const rr = r, cc = c;
      cell.addEventListener('click', () => {
        if (selectedPalette === null) {
          editorLayout[rr][cc] = null;
        } else {
          editorLayout[rr][cc] = { ...selectedPalette };
        }
        renderEditorBoard();
      });
      el.appendChild(cell);
    }
  }
}

function updateCustomLayoutBadge() {
  document.getElementById('custom-layout-badge').style.display = customLayout ? '' : 'none';
}

// ── Setup modal ───────────────────────────────────────────────────
function showSetupModal() {
  document.getElementById('setup-overlay').style.display = 'block';
  document.getElementById('setup-modal').style.display   = 'block';
}

function hideSetupModal() {
  document.getElementById('setup-overlay').style.display = 'none';
  document.getElementById('setup-modal').style.display   = 'none';
}

// ── Game initialization ───────────────────────────────────────────
function startNewGame() {
  const winCond          = document.querySelector('input[name="win-condition"]:checked')?.value || 'standard';
  const useDoubleMove    = document.getElementById('opt-double-move')?.checked    || false;
  const useExplosive     = document.getElementById('opt-explosive')?.checked      || false;
  const useKamikaze      = document.getElementById('opt-kamikaze')?.checked       || false;
  const useExile         = document.getElementById('opt-exile')?.checked          || false;
  const useDefection     = document.getElementById('opt-defection')?.checked      || false;
  const useBerserker     = document.getElementById('opt-berserker')?.checked      || false;
  const usePromoAnywhere = document.getElementById('opt-promote-anywhere')?.checked || false;
  const useGravity       = document.getElementById('opt-gravity')?.checked        || false;
  const useShrink        = document.getElementById('opt-shrink')?.checked         || false;
  const useQueen         = document.getElementById('opt-queen')?.checked          || false;
  const useCrazyKnight   = document.getElementById('opt-crazy-knight')?.checked   || false;
  const useNinja         = false; // 廃止（単調なゲームプレイのため）
  const aiLevel          = document.querySelector('input[name="ai-level"]:checked')?.value || 'level1';

  hideSetupModal();
  hideWinner();
  hidePromoDialog();
  clearSel();
  gameOver         = false;
  setAITurn(false);
  hasDoubleMove    = useDoubleMove;
  captureWinActive = winCond === 'capture';
  aiEnabled        = true;
  const timeSec = parseInt(document.getElementById('ai-time-sec')?.value) || 10;
  aiChooseFn = {
    random:    randomAIChooseAction,
    level1:    level1AIChooseAction,
    level2:    level2AIChooseAction,
    level3:    level3AIChooseAction,
    timelimit: makeTimeLimitedAI(timeSec * 1000),
  }[aiLevel] || level1AIChooseAction;

  resetUid();
  engine = new NeoShogiEngine();
  engine.use(StandardShogiPlugin);

  // ── 勝利条件 ──────────────────────────────
  if (winCond === 'reverse') {
    engine.use(ReverseWinPlugin);
  } else if (winCond === 'capture') {
    engine.use(CaptureWinPlugin(20));
    engine.use(NoMovesWinPlugin);  // フォールバック（手詰まり時）
  } else {
    engine.use(NoMovesWinPlugin);
  }

  // ── 移動系（優先度が低い順に use する必要はなし。priority で自動ソート）──
  if (usePromoAnywhere) engine.use(PromoteAnywherePlugin);
  if (useBerserker)     engine.use(BerserkerPlugin);

  // ── 駒の効果 ──────────────────────────────
  if (useDefection) engine.use(DefectionPlugin);
  if (useExile)     engine.use(ExileOnCapturePlugin);
  if (useKamikaze)  engine.use(KamikazePlugin);
  if (useExplosive) engine.use(ExplosivePiecePlugin);

  // ── アクション系 ──────────────────────────
  if (useDoubleMove) engine.use(DoubleMovePlugin);

  // ── 盤面効果 ──────────────────────────────
  if (useGravity) engine.use(GravityPlugin);
  if (useShrink)  engine.use(ShrinkBoardPlugin);

  // ── 追加駒 ────────────────────────────────
  if (useQueen)       engine.use(QueenPlugin);
  if (useCrazyKnight) engine.use(CrazyKnightPlugin);
  if (useNinja)       engine.use(NinjaPlugin);

  // ── カスタム初期配置 ──────────────────────
  if (customLayout) {
    // 配置された追加駒のタイプを検出し、未登録の動作プラグインを自動追加
    const layoutTypes = new Set();
    for (const row of customLayout) for (const cell of row) if (cell) layoutTypes.add(cell.type);
    if (layoutTypes.has('Q')  && !useQueen)       engine.use(QueenMovePlugin);
    if (layoutTypes.has('CK') && !useCrazyKnight) engine.use(CrazyKnightMovePlugin);
    if (layoutTypes.has('NJ') && !useNinja)       engine.use(NinjaMovePlugin);
    engine.use(makeCustomInitPlugin(customLayout));
  }

  engine.init();

  // 棋譜リセット
  replayHistory     = [{ action: null, state: deepClone(engine.state) }];
  replayIndex       = -1;
  replayDisplayState = null;
  document.getElementById('replay-controls').classList.remove('show');

  buildLabels();
  renderAll();
}

// ── Wire up DOM events ────────────────────────────────────────────
// ゲーム関連のボタンは AI 思考中に受け付けない（CSS の pointer-events:none に加えてガード）
document.getElementById('btn-new-game').addEventListener('click', () => { if (!isAITurn) showSetupModal(); });
document.getElementById('btn-start-game').addEventListener('click', () => { if (!isAITurn) startNewGame(); });
document.getElementById('btn-play-again').addEventListener('click', () => { if (!isAITurn) { hideWinner(); showSetupModal(); } });

// Winner minimize / restore
document.getElementById('btn-minimize-winner').addEventListener('click', minimizeWinner);
document.getElementById('btn-winner-restore').addEventListener('click', restoreWinner);
document.getElementById('btn-winner-mini-again').addEventListener('click', () => { hideWinner(); showSetupModal(); });

// Board editor
document.getElementById('btn-open-editor').addEventListener('click', () => {
  hideSetupModal();
  openEditor();
});
document.getElementById('btn-editor-done').addEventListener('click', () => {
  customLayout = editorLayout.map(row => row.map(c => c ? {...c} : null));
  closeEditor();
  updateCustomLayoutBadge();
  showSetupModal();
});
document.getElementById('btn-editor-cancel').addEventListener('click', () => {
  closeEditor();
  showSetupModal();
});
document.getElementById('btn-editor-standard').addEventListener('click', () => {
  editorLayout = getStandardLayout();
  renderEditorBoard();
});
document.getElementById('btn-editor-clear').addEventListener('click', () => {
  editorLayout = Array.from({length:9}, () => Array(9).fill(null));
  renderEditorBoard();
});
document.getElementById('btn-clear-editor').addEventListener('click', () => {
  customLayout = null;
  updateCustomLayoutBadge();
});

// 棋譜再生
document.getElementById('btn-view-kifu').addEventListener('click', enterReplay);
document.getElementById('btn-mini-kifu').addEventListener('click', enterReplay);
document.getElementById('btn-replay-start').addEventListener('click', () => stepReplay(-9999));
document.getElementById('btn-replay-prev').addEventListener('click',  () => stepReplay(-1));
document.getElementById('btn-replay-next').addEventListener('click',  () => stepReplay(+1));
document.getElementById('btn-replay-end').addEventListener('click',   () => stepReplay(+9999));
document.getElementById('btn-replay-export').addEventListener('click', exportGame);
document.getElementById('btn-replay-exit').addEventListener('click',   exitReplay);

// 2文字駒名トグル
document.getElementById('btn-toggle-labels').addEventListener('click', () => {
  useTwoCharLabels = !useTwoCharLabels;
  document.getElementById('btn-toggle-labels').textContent =
    useTwoCharLabels ? '駒名: 2字' : '駒名: 1字';
  renderAll();
});

// 時間制限AI: ラジオ変更で入力フィールド表示切り替え
document.querySelectorAll('input[name="ai-level"]').forEach(r => {
  r.addEventListener('change', () => {
    const show = document.querySelector('input[name="ai-level"]:checked')?.value === 'timelimit';
    document.getElementById('timelimit-row').style.display = show ? '' : 'none';
  });
});

document.getElementById('btn-toggle-ai').addEventListener('click', () => {
  if (isAITurn) return;  // 思考中は操作不可
  aiEnabled = !aiEnabled;
  document.getElementById('ai-toggle-label').textContent = aiEnabled ? 'ON' : 'OFF';
  if (aiEnabled && !gameOver && engine && engine.state.turn === 'white') {
    setAITurn(true);
    renderStatus();
    setTimeout(doAITurn, 350);
  }
});

const dblBtn = document.getElementById('btn-declare-double');
if (dblBtn) {
  dblBtn.addEventListener('click', () => {
    if (gameOver || isAITurn) return;
    const action = engine.getLegalActions().find(a => a.tag === 'declare_double');
    if (action) executeAction(action);
  });
}

// ── Bootstrap ─────────────────────────────────────────────────────
showSetupModal();
