// ui.js — UI Layer (Neo将棋 v0.4)
// DOM描画・イベント処理・ゲーム設定モーダル

import {
  NeoShogiEngine, resetUid, opp,
  KANJI, pieceKanji, promoType,
} from './engine.js';

import {
  StandardShogiPlugin,
  NoMovesWinPlugin,
  DoubleMovePlugin,
} from './plugins.js';

import {
  randomAIChooseAction,
  level1AIChooseAction,
} from './ai.js';

// ── UI State ─────────────────────────────────────────────────────
let engine       = null;
let selectedCell = null;   // {type:'board',row,col} | {type:'hand',player,pieceType}
let legalActions = [];
let legalDests   = new Set();
let gameOver     = false;
let isAITurn     = false;
let aiEnabled    = true;
let aiChooseFn   = level1AIChooseAction;
let hasDoubleMove = false;

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
  const state = engine.state;
  const lm = state.global.lastMove;

  for (let r=0; r<9; r++) {
    for (let c=0; c<9; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';

      const isSelBoard = selectedCell?.type==='board' && selectedCell.row===r && selectedCell.col===c;
      const isLegal    = legalDests.has(`${r},${c}`);
      const isLastFrom = lm?.from && lm.from.row===r && lm.from.col===c;
      const isLastTo   = lm?.to   && lm.to.row===r   && lm.to.col===c;

      if (isSelBoard)       cell.classList.add('sel');
      else if (isLegal)     cell.classList.add('legal');
      else if (isLastFrom)  cell.classList.add('last-from');
      else if (isLastTo)    cell.classList.add('last-to');

      const token = state.board[r][c].token;
      if (token) {
        const piece = document.createElement('div');
        piece.className = 'piece' +
          (token.owner==='white' ? ' white' : '') +
          (token.type.startsWith('+') ? ' promo' : '');
        piece.textContent = pieceKanji(token);
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
  const hand   = engine.state.hands[player];
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
    pieceEl.textContent = KANJI[type] || type;
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
  if (gameOver) {
    el.textContent = gameOver==='black' ? '先手(黒)の勝ち！' : '後手(白)の勝ち！';
    return;
  }
  if (isAITurn) { el.textContent = 'AIが考えています…'; return; }
  const turn = engine.state.turn;
  el.textContent = turn==='black' ? '先手(黒)のターン' : '後手(白)のターン (AI)';
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
function executeAction(action) {
  clearSel();
  const result = engine.step(action);
  // engine.step が check_end を呼び、NoMovesWinPlugin も含めて判定済み
  if (result) {
    gameOver = result;
    renderAll();
    showWinner(result);
    return;
  }
  renderAll();

  if (aiEnabled && engine.state.turn === 'white' && !gameOver) {
    isAITurn = true;
    renderStatus();
    setTimeout(doAITurn, 350 + Math.random() * 250);
  }
}

function doAITurn() {
  const action = aiChooseFn(engine);
  isAITurn = false;

  if (!action) {
    // AI に合法手がない（NoMovesWinPlugin が check_end で処理するはずだが念のため）
    gameOver = 'black';
    renderAll();
    showWinner('black');
    return;
  }

  const result = engine.step(action);
  if (result) {
    gameOver = result;
    renderAll();
    showWinner(result);
    return;
  }
  renderAll();

  // turn が white のまま（skipTurnChange が起きた場合）は再スケジュール
  // 例：将来的なプラグインで白にも特殊アクションが追加された場合の保険
  if (aiEnabled && engine.state.turn === 'white' && !gameOver) {
    isAITurn = true;
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
  document.getElementById('winner-title').textContent = winner==='black' ? '先手(黒)の勝ち！' : '後手(白)の勝ち！';
  document.getElementById('winner-msg').textContent   = winner==='black'
    ? '後手の合法手がなくなりました'
    : '先手の合法手がなくなりました';
  document.getElementById('winner-overlay').classList.add('show');
}

function hideWinner() {
  document.getElementById('winner-overlay').classList.remove('show');
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
  const useDoubleMove = document.getElementById('opt-double-move')?.checked || false;
  const aiLevel       = document.querySelector('input[name="ai-level"]:checked')?.value || 'level1';

  hideSetupModal();
  hideWinner();
  hidePromoDialog();
  clearSel();
  gameOver      = false;
  isAITurn      = false;
  hasDoubleMove = useDoubleMove;
  aiEnabled     = true;
  aiChooseFn    = aiLevel === 'level1' ? level1AIChooseAction : randomAIChooseAction;

  resetUid();
  engine = new NeoShogiEngine();
  engine.use(StandardShogiPlugin);
  engine.use(NoMovesWinPlugin);       // 詰み・ステイルメイト判定（常時）
  if (useDoubleMove) engine.use(DoubleMovePlugin);
  engine.init();

  buildLabels();
  renderAll();
}

// ── Wire up DOM events ────────────────────────────────────────────
document.getElementById('btn-new-game').addEventListener('click', showSetupModal);
document.getElementById('btn-start-game').addEventListener('click', startNewGame);
document.getElementById('btn-play-again').addEventListener('click', () => { hideWinner(); showSetupModal(); });

document.getElementById('btn-toggle-ai').addEventListener('click', () => {
  aiEnabled = !aiEnabled;
  document.getElementById('ai-toggle-label').textContent = aiEnabled ? 'ON' : 'OFF';
  if (aiEnabled && !gameOver && engine.state.turn === 'white') {
    isAITurn = true;
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
