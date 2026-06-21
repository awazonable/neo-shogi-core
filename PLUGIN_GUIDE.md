# Neo将棋 プラグイン作成ガイド

> 対象バージョン: v0.4 (PoC 段階)  
> 本書は「新しいプラグインを作るとき何を気にすれば良いか」を説明します。

---

## 1. アーキテクチャ概要

```
┌─────────────────────────────────────────────────────────┐
│  Plugin Layer（plugins.js / plugins-extra.js）           │
│  StandardShogiPlugin / QueenPlugin / DoubleMovePlugin …  │
│        ↕ engine.js のフックとユーティリティだけを使う       │
├─────────────────────────────────────────────────────────┤
│  Core Layer（engine.js）                                  │
│  NeoShogiEngine / Token / GameState / makeToken 等        │
│  「将棋の概念」は一切持たない。座標・トークン・イベントバスのみ。 │
└─────────────────────────────────────────────────────────┘
```

**原則**: プラグイン同士は直接インポートしない。  
フックの呼び出し順は `priority`（数値が小さいほど先）で決まる。

---

## 2. プラグインが使えるフック一覧

| フック名 | 引数 | 戻り値 | 用途 |
|---|---|---|---|
| `on_game_init(state)` | GameState | GameState | 初期盤面の構築 |
| `get_actions(actions, state)` | Action[], GameState | Action[] | 合法手の追加 |
| `validate_action(action, state)` | Action, GameState | boolean | 合法手のフィルタ |
| `before_action(action, state)` | Action, GameState | `{skip?, state?}` | 手の前処理 |
| `apply_action(action, state)` | Action, GameState | GameState\|null | 盤面変更（最初の非null が採用） |
| `after_action(action, state)` | Action, GameState | GameState | 手の後処理 |
| `on_turn_end(state)` | GameState | GameState | ターン終了時（手番交代前） |
| `on_turn_start(state)` | GameState | GameState | ターン開始時（手番交代後） |
| `check_end(state, getLegalActions?)` | GameState | Player\|null | 終局判定 |

---

## 3. シンプルなプラグインのテンプレート

```js
// my-plugin.js
import { deepClone, opp, makeToken } from './engine.js?vN';

export const MyPlugin = {
  id: 'my_plugin',       // 一意なID（文字列）
  priority: 0,           // 実行順。低いほど先（StandardShogiPlugin = -100）
  meta: {
    name: 'マイプラグイン',
    description: 'ゲームの説明',
  },
  hooks: {
    on_game_init(state) {
      // 盤面を変更するときは必ず deepClone して新しいオブジェクトを返す
      const s = deepClone(state);
      // ... 駒の配置など
      return s;
    },

    get_actions(actions, state) {
      // 手を追加する（state は読み取り専用）
      const extra = [];
      // ...
      return [...actions, ...extra];
    },

    validate_action(action, state) {
      // false を返すと、その手が合法手から除外される
      return true;
    },

    after_action(action, state) {
      // 毎ターン呼ばれる。state を変更したい場合は新オブジェクトを返す
      if (action.tag !== 'move') return state;
      // ...
      return { ...state, global: { ...state.global, myFlag: true } };
    },

    on_turn_start(state) {
      // ターン開始時のリセット処理など
      return state;
    },

    check_end(state, getLegalActions) {
      // ゲームが終わったか判定
      // null = 続行、'black' or 'white' = 勝者
      return null;
    },
  },
};
```

---

## 4. 新しい駒種を追加するプラグイン

StandardShogiPlugin の 8 駒種以外の駒を追加する場合のパターン。

### 4-1. 動きの生成（get_actions）

```js
function myPieceMoves(token, row, col, board) {
  const moves = [];
  // ... 移動先を計算
  return moves; // [{row, col}, ...]
}

hooks: {
  on_game_init(state) {
    // 持ち駒に追加
    const s = deepClone(state);
    s.hands.black.push(makeToken('MP', 'black'));
    s.hands.white.push(makeToken('MP', 'white'));
    return s;
  },

  get_actions(actions, state) {
    const player = state.turn;
    const extra = [];
    // 盤上の移動
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
      const t = state.board[r][c].token;
      if (!t || t.owner !== player || t.type !== 'MP') continue;
      for (const dest of myPieceMoves(t, r, c, state.board)) {
        extra.push({ player, tag: 'move',
          payload: { from:{row:r,col:c}, to:dest, promote:false } });
      }
    }
    // 持ち駒から打つ
    if (state.hands[player].some(t => t.type === 'MP')) {
      for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
        if (!state.board[r][c].token)
          extra.push({ player, tag: 'drop',
            payload: { type: 'MP', to: {row:r, col:c} } });
      }
    }
    return [...actions, ...extra];
  },
}
```

### 4-2. ⚠️ 王手放置禁止の対応（validate_action）

**これが疎結合の限界点です。**

StandardShogiPlugin の `validate_action` は組み込みの `isKingInCheck` を使います。
この関数は `getMoves`（engine.js）が知っている 8 駒種しか検出しません。

**新しい駒種を追加したとき、その駒による王手を放置できてしまいます。**

対処: プラグイン自身に `validate_action` を追加して、自駒種が玉を狙っていないか確認する。

```js
function lightApply(action, state) {
  // deepClone して盤面だけ仮適用する（手駒変化は省略）
  const s = deepClone(state);
  if (action.tag === 'move') {
    const { from, to, promote } = action.payload;
    const token = s.board[from.row]?.[from.col]?.token;
    if (!token) return s;
    s.board[from.row][from.col].token = null;
    if (promote && !token.type.startsWith('+')) token.type = '+' + token.type;
    s.board[to.row][to.col].token = token;
  } else if (action.tag === 'drop') {
    const { type, to } = action.payload;
    const idx = s.hands[action.player].findIndex(t => t.type === type);
    if (idx >= 0) {
      const [token] = s.hands[action.player].splice(idx, 1);
      s.board[to.row][to.col].token = { ...token };
    }
  }
  return s;
}

// 追加
validate_action(action, state) {
  if (action.tag === 'declare_double') return true;
  const next = lightApply(action, state);
  const kp = findKingPos(next, action.player);
  if (!kp) return true;
  const op = opp(action.player);
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
    const t = next.board[r][c].token;
    if (!t || t.owner !== op || t.type !== 'MP') continue;
    // 自分の新駒が玉を狙っていたら false を返す
    if (myPieceMoves(t, r, c, next.board).some(m => m.row === kp.row && m.col === kp.col))
      return false;
  }
  return true;
}
```

`findKingPos` は engine.js からインポートできます。

### 4-3. ⚠️ AI 探索の対応（ai.js の更新）

`ai.js` の `fastGetLegal` 関数内にある `isExtraCheck` は、追加駒種ごとに手書きでチェックを追加しています。

```js
// ai.js の isExtraCheck 関数内
if (t.type === 'MP') {
  const moves = myPieceMoves(t, r, c, state.board);
  if (moves.some(m => m.row === kp.row && m.col === kp.col)) return true;
}
```

**新しい駒種を追加したら、この関数に1ブロック追加してください。**  
（`_Q_DIRS`, `_CK_OFFS` と同様のパターンで）

### 4-4. 駒の表示名の追加

```js
// plugins-extra.js の末尾
export const EXTRA_KANJI = { Q: '女', CK: '跳', MP: '○' };
//                                                ^^^^ 追加
```

盤面エディタのパレットは `EXTRA_KANJI` のキーを自動的に表示します。

---

## 5. プラグイン埋め込み手順（UI への追加）

1. **plugins-extra.js に書く**: プラグインを export する
2. **ui.js に import する**:
   ```js
   import { MyPlugin } from './plugins-extra.js?vN';
   ```
3. **index.html に設定UIを追加**: setup-modal に checkbox を追加
   ```html
   <label class="setup-row">
     <input type="checkbox" id="opt-my-plugin">
     <div class="setup-row-text">
       <span class="setup-row-name">マイプラグイン</span>
       <span class="setup-desc">説明文</span>
     </div>
   </label>
   ```
4. **ui.js の startNewGame() に組み込む**:
   ```js
   const useMyPlugin = document.getElementById('opt-my-plugin')?.checked || false;
   // ...
   if (useMyPlugin) engine.use(MyPlugin);
   ```
5. **キャッシュバスター**: `engine.js?vN` の `N` を全 import で統一してインクリメント

---

## 6. 既知の結合点まとめ

| 結合点 | 場所 | 対処方法 |
|---|---|---|
| 王手検出が 8 駒種固定 | `engine.js の isKingInCheck → getMoves` | 新駒プラグインに `validate_action` を追加 |
| AI の追加駒種チェック | `ai.js の isExtraCheck` | 関数内に駒種ごとの処理を追加 |
| 評価関数の駒価値 | `ai.js の EVAL_VAL` | 新駒種の value を追記 |
| 2文字表示名 | `ui.js の KANJI_2` | 新駒種のエントリを追加 |
| 盤面エディタのパレット | `plugins-extra.js の EXTRA_KANJI` | キーを追加（自動でパレットに表示） |

---

## 7. ゲームループの実行順序

```
1. on_game_init          ← 初期配置（priority 順）
   ↓
2. get_actions           ← 合法手生成
3. validate_action       ← 合法手フィルタ（全プラグインが false にしたら除外）
   ↓ [ユーザー/AIが手を選ぶ]
4. before_action         ← 手の前処理（skip=true で apply_action をスキップ）
5. apply_action          ← 盤面変更（最初の非 null が採用、以降 break）
6. after_action          ← 手の後処理（全プラグインに順番に適用）
7. on_turn_end           ← ターン終了（手番交代前）
   ↓ [手番交代: turn を反転、moveCount++]
8. on_turn_start         ← ターン開始
9. check_end             ← 終局判定（最初の非 null が勝者として採用）
```

---

## 8. 廃止プラグイン

| プラグイン | 理由 |
|---|---|
| NinjaPlugin | 双方が忍者を打つと即時取り合いになり単調。コードは残存（plugins-extra.js） |
