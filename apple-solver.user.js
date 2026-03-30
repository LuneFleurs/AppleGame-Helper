// ==UserScript==
// @name         Apple Game Plus Solver Helper
// @namespace    https://apple.oshizi.com/
// @author       Yettttie
// @version      0.1.2
// @description  Show rectangle hints for the Apple Game Plus and auto-drag the selected move.
// @match        https://apple.oshizi.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const GRID_ROWS = 10;
  const GRID_COLS = 17;
  const TARGET_SUM = 10;
  const ALLOWED_DEPTHS = [1, 2, 3];
  const SEARCH_DEPTH = 3;
  const BRANCH_LIMIT = 12;
  const HINT_COUNT = 5;
  const POLL_MS = 250;
  const PLAN_AUTOPLAY_DELAY_MS = 120;
  const MODE_STORAGE_KEY = 'apple-solver-helper-mode';
  const DEPTH_STORAGE_KEY = 'apple-solver-helper-depth';
  const ENGINE_STORAGE_KEY = 'apple-solver-helper-engine';
  const GUIDANCE_STORAGE_KEY = 'apple-solver-helper-guidance';
  const PREVIEW_CACHE_STORAGE_KEY = 'apple-solver-helper-preview-cache';
  const BEAM_WIDTH = 32;
  const BEAM_BRANCH_LIMIT = 8;
  const ENDGAME_THRESHOLD = 24;
  const PREVIEW_MAX_AUTO_DEPTH = 3;
  const PREVIEW_MAX_STEPS = 80;

  const STYLE_ID = 'apple-solver-helper-style';
  const PANEL_ID = 'apple-solver-helper-panel';
  const OVERLAY_ID = 'apple-solver-helper-overlay';
  const ACTIVE_CLASS = 'apple-solver-active';

  const MODES = {
    balanced: { label: '균형', description: '3수 기준으로 후속 전개까지 같이 봅니다.' },
    greedy: { label: '즉시 최대', description: '당장 많이 지우는 수를 우선합니다.' },
    builder: { label: '길 만들기', description: '작게 지워서 0 통로를 늘리는 쪽입니다.' },
  };

  const ENGINES = {
    heuristic: { label: '휴리스틱', description: '가볍고 빠른 기본 탐색입니다.' },
    beam: { label: '빔 서치', description: '상위 후보 상태를 유지하며 더 안정적으로 깊게 봅니다.' },
    beam_exact: { label: '빔 + 엔드게임', description: '후반에는 가능한 경우 끝까지 완전탐색합니다.' },
  };

  const GUIDANCE = {
    live: { label: '실시간 재계산' },
    planned: { label: '계획 따라가기' },
  };

  let lastBoard = null;
  let hints = [];
  let hintIndex = 0;
  let lastCanvas = null;
  let currentMode = loadMode();
  let currentDepth = loadDepth();
  let currentEngine = loadEngine();
  let currentGuidance = loadGuidance();
  let lastPreviewKey = null;
  let previewRequested = false;
  let plannedRun = null;
  let plannedAutoplayArmed = false;
  let plannedAutoplayTimer = null;
  let plannedAutoplayPendingBoard = null;
  let previewInProgress = false;
  let previewResults = null;
  let previewJobId = 0;
  const previewCache = loadPreviewCache();

  function sanitizeDepth(depth) {
    return ALLOWED_DEPTHS.includes(depth) ? depth : SEARCH_DEPTH;
  }

  function loadMode() {
    try {
      const saved = localStorage.getItem(MODE_STORAGE_KEY);
      return saved && MODES[saved] ? saved : 'balanced';
    } catch {
      return 'balanced';
    }
  }

  function saveMode(mode) {
    currentMode = MODES[mode] ? mode : 'balanced';
    try {
      localStorage.setItem(MODE_STORAGE_KEY, currentMode);
    } catch {}
  }

  function loadDepth() {
    try {
      const saved = Number(localStorage.getItem(DEPTH_STORAGE_KEY));
      return sanitizeDepth(saved);
    } catch {}
    return SEARCH_DEPTH;
  }

  function saveDepth(depth) {
    currentDepth = sanitizeDepth(depth);
    try {
      localStorage.setItem(DEPTH_STORAGE_KEY, String(currentDepth));
    } catch {}
  }

  function loadEngine() {
    try {
      const saved = localStorage.getItem(ENGINE_STORAGE_KEY);
      return saved && ENGINES[saved] ? saved : 'heuristic';
    } catch {
      return 'heuristic';
    }
  }

  function saveEngine(engine) {
    currentEngine = ENGINES[engine] ? engine : 'heuristic';
    try {
      localStorage.setItem(ENGINE_STORAGE_KEY, currentEngine);
    } catch {}
  }

  function loadGuidance() {
    try {
      const saved = localStorage.getItem(GUIDANCE_STORAGE_KEY);
      return saved && GUIDANCE[saved] ? saved : 'live';
    } catch {
      return 'live';
    }
  }

  function saveGuidance(value) {
    currentGuidance = GUIDANCE[value] ? value : 'live';
    try {
      localStorage.setItem(GUIDANCE_STORAGE_KEY, currentGuidance);
    } catch {}
  }

  function loadPreviewCache() {
    try {
      const raw = localStorage.getItem(PREVIEW_CACHE_STORAGE_KEY) || sessionStorage.getItem(PREVIEW_CACHE_STORAGE_KEY);
      if (!raw) return new Map();
      const parsed = JSON.parse(raw);
      return new Map(Array.isArray(parsed) ? parsed : []);
    } catch {
      return new Map();
    }
  }

  function persistPreviewCache() {
    const entries = [...previewCache.entries()].slice(-4);
    try {
      localStorage.setItem(PREVIEW_CACHE_STORAGE_KEY, JSON.stringify(entries));
    } catch {}
    try {
      sessionStorage.setItem(PREVIEW_CACHE_STORAGE_KEY, JSON.stringify(entries));
    } catch {}
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${PANEL_ID} {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147483647;
        width: 280px;
        padding: 12px;
        border: 1px solid rgba(0, 0, 0, 0.12);
        border-radius: 14px;
        background: rgba(255, 252, 240, 0.96);
        box-shadow: 0 10px 35px rgba(0, 0, 0, 0.18);
        color: #1f2937;
        font: 12px/1.45 Pretendard Variable, Pretendard, sans-serif;
        backdrop-filter: blur(10px);
      }
      #${PANEL_ID} button {
        border: 0;
        border-radius: 10px;
        padding: 7px 10px;
        background: #1f7a47;
        color: #fff;
        font: inherit;
        cursor: pointer;
      }
      #${PANEL_ID} button:disabled {
        opacity: 0.45;
        cursor: default;
      }
      #${PANEL_ID} .row {
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
      }
      #${PANEL_ID} .title {
        font-weight: 700;
        font-size: 13px;
      }
      #${PANEL_ID} .muted {
        color: #6b7280;
      }
      #${PANEL_ID} select {
        min-width: 112px;
        border: 1px solid rgba(31, 41, 55, 0.16);
        border-radius: 10px;
        padding: 6px 8px;
        background: rgba(255, 255, 255, 0.9);
        color: inherit;
        font: inherit;
      }
      #${PANEL_ID} .hint {
        margin-top: 8px;
        padding: 9px 10px;
        border-radius: 10px;
        background: rgba(31, 122, 71, 0.08);
      }
      #${PANEL_ID} .preview {
        margin-top: 8px;
        padding: 9px 10px;
        border-radius: 10px;
        background: rgba(17, 24, 39, 0.06);
      }
      #${PANEL_ID} .preview-row {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        margin-top: 4px;
      }
      #${PANEL_ID} .preview-row:first-child {
        margin-top: 0;
      }
      #${PANEL_ID} .preview-row button {
        padding: 0;
        border: 0;
        background: none;
        color: #1f7a47;
        font: inherit;
        cursor: pointer;
      }
      #${OVERLAY_ID} {
        position: fixed;
        left: 0;
        top: 0;
        width: 100vw;
        height: 100vh;
        pointer-events: none;
        z-index: 2147483646;
      }
      #${OVERLAY_ID} .box {
        position: absolute;
        border: 2px solid rgba(255, 99, 71, 0.45);
        background: rgba(255, 99, 71, 0.10);
        border-radius: 10px;
        pointer-events: none;
        cursor: default;
        box-sizing: border-box;
      }
      #${OVERLAY_ID} .box.${ACTIVE_CLASS} {
        border-color: rgba(20, 115, 230, 0.95);
        background: rgba(20, 115, 230, 0.18);
      }
      #${OVERLAY_ID} .box .badge {
        position: absolute;
        top: -10px;
        left: -2px;
        min-width: 22px;
        padding: 2px 6px;
        border-radius: 999px;
        background: rgba(17, 24, 39, 0.92);
        color: #fff;
        font: 11px/1.2 Pretendard Variable, Pretendard, sans-serif;
      }
    `;
    document.head.appendChild(style);
  }

  function getReactProps(node) {
    if (!node) return null;
    const key = Object.getOwnPropertyNames(node).find((name) => name.startsWith('__reactProps$'));
    return key ? node[key] : null;
  }

  function createMouseLikeEvent(type, x, y, target) {
    return {
      type,
      target,
      currentTarget: target,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: type === 'mouseup' ? 0 : 1,
      preventDefault() {},
      stopPropagation() {},
    };
  }

  function normalizeBoard(board) {
    if (typeof board === 'string') return board;
    if (Array.isArray(board)) return board.join('');
    return String(board || '');
  }

  function getGameContext() {
    const candidates = [...document.querySelectorAll('canvas')];
    let canvas = null;
    let boardProps = null;

    for (const candidate of candidates) {
      if (!candidate.parentElement) continue;
      const parentProps = getReactProps(candidate.parentElement);
      const props = parentProps?.children?.find?.(
        (child) =>
          child?.props?.board &&
          typeof child.props.cellSize === 'number' &&
          typeof child.props.onMove === 'function'
      )?.props;
      if (props?.board) {
        canvas = candidate;
        boardProps = props;
        break;
      }
    }

    if (!canvas || !boardProps) {
      for (const candidate of candidates) {
        if (!candidate.parentElement) continue;
        const parentProps = getReactProps(candidate.parentElement);
        const props = parentProps?.children?.find?.(
          (child) => child?.props?.board && typeof child.props.cellSize === 'number'
        )?.props;
        if (props?.board) {
          canvas = candidate;
          boardProps = props;
          break;
        }
      }
    }

    if (!canvas || !boardProps) return null;

    const canvasRect = canvas.getBoundingClientRect();
    const cellSize = boardProps.cellSize;
    const boardWidth = GRID_COLS * cellSize;
    const boardHeight = GRID_ROWS * cellSize;
    const padX = Math.max(0, (canvasRect.width - boardWidth) / 2);
    const padY = Math.max(0, (canvasRect.height - boardHeight) / 2);

    return {
      canvas,
      board: normalizeBoard(boardProps.board),
      onMove: boardProps.onMove,
      cellSize,
      padX,
      padY,
      rect: canvasRect,
    };
  }

  function boardToGrid(board) {
    const grid = [];
    for (let r = 0; r < GRID_ROWS; r += 1) {
      const row = [];
      for (let c = 0; c < GRID_COLS; c += 1) {
        row.push(Number(board[r * GRID_COLS + c]));
      }
      grid.push(row);
    }
    return grid;
  }

  function gridToBoard(grid) {
    return grid.map((row) => row.join('')).join('');
  }

  function countApples(board) {
    let count = 0;
    for (const ch of board) {
      if (ch !== '0') count += 1;
    }
    return count;
  }

  function isReadyState() {
    const readyLabels = new Set(['Start', 'Ready', '시작', '준비']);
    return [...document.querySelectorAll('button')].some((button) => readyLabels.has(button.textContent?.trim()));
  }

  function isRandomPage() {
    return location.pathname.startsWith('/random');
  }

  function isRoomPage() {
    return location.pathname.startsWith('/room/');
  }

  function getPreGamePreviewMessage() {
    if (isRoomPage()) {
      return '멀티플레이 방은 게임이 시작되어 내 보드가 보인 뒤에만 계산할 수 있습니다.';
    }
    return '게임 시작 전 예상치는 아래 버튼으로 계산합니다.';
  }

  function canPreviewCurrentBoard() {
    return isRandomPage() || isRoomPage();
  }

  function getNoBoardHintMessage() {
    if (isRoomPage()) {
      return '멀티플레이 방에서는 게임 시작 후 내 보드가 보이면 읽습니다.';
    }
    return '게임 시작 후 보드를 읽습니다.';
  }

  function staticBoardPotential(board) {
    return listMoves(board).length;
  }

  function listMoves(board) {
    const grid = boardToGrid(board);
    const prefix = Array.from({ length: GRID_ROWS + 1 }, () => Array(GRID_COLS + 1).fill(0));
    const nonZeroPrefix = Array.from({ length: GRID_ROWS + 1 }, () => Array(GRID_COLS + 1).fill(0));
    for (let r = 0; r < GRID_ROWS; r += 1) {
      for (let c = 0; c < GRID_COLS; c += 1) {
        prefix[r + 1][c + 1] =
          grid[r][c] + prefix[r][c + 1] + prefix[r + 1][c] - prefix[r][c];
        nonZeroPrefix[r + 1][c + 1] =
          (grid[r][c] !== 0 ? 1 : 0) + nonZeroPrefix[r][c + 1] + nonZeroPrefix[r + 1][c] - nonZeroPrefix[r][c];
      }
    }

    const moves = [];
    for (let r1 = 0; r1 < GRID_ROWS; r1 += 1) {
      for (let c1 = 0; c1 < GRID_COLS; c1 += 1) {
        for (let r2 = r1; r2 < GRID_ROWS; r2 += 1) {
          for (let c2 = c1; c2 < GRID_COLS; c2 += 1) {
            const sum =
              prefix[r2 + 1][c2 + 1] - prefix[r1][c2 + 1] - prefix[r2 + 1][c1] + prefix[r1][c1];
            if (sum !== TARGET_SUM) continue;
            const removed =
              nonZeroPrefix[r2 + 1][c2 + 1] -
              nonZeroPrefix[r1][c2 + 1] -
              nonZeroPrefix[r2 + 1][c1] +
              nonZeroPrefix[r1][c1];
            if (!removed) continue;
            moves.push({
              r1,
              c1,
              r2,
              c2,
              removed,
              area: (r2 - r1 + 1) * (c2 - c1 + 1),
              shape: `${r2 - r1 + 1}x${c2 - c1 + 1}`,
            });
          }
        }
      }
    }

    return moves;
  }

  function applyMove(board, move) {
    const grid = boardToGrid(board);
    for (let r = move.r1; r <= move.r2; r += 1) {
      for (let c = move.c1; c <= move.c2; c += 1) {
        if (grid[r][c] !== 0) grid[r][c] = 0;
      }
    }
    return gridToBoard(grid);
  }

  function evaluateBoard(board, depth, memo) {
    const key = `${depth}:${board}`;
    if (memo.has(key)) return memo.get(key);

    const moves = listMoves(board);
    if (depth <= 0 || moves.length === 0) {
      const base = { futureGain: 0, futureMoves: 0 };
      memo.set(key, base);
      return base;
    }

    moves.sort((a, b) => {
      if (a.removed !== b.removed) return a.removed - b.removed;
      if (a.area !== b.area) return a.area - b.area;
      return a.r1 - b.r1 || a.c1 - b.c1;
    });

    let best = { futureGain: 0, futureMoves: 0 };
    for (const move of moves.slice(0, BRANCH_LIMIT)) {
      const nextBoard = applyMove(board, move);
      const next = evaluateBoard(nextBoard, depth - 1, memo);
      const candidate = {
        futureGain: move.removed + next.futureGain,
        futureMoves: 1 + next.futureMoves,
      };
      if (
        candidate.futureGain > best.futureGain ||
        (candidate.futureGain === best.futureGain && candidate.futureMoves > best.futureMoves)
      ) {
        best = candidate;
      }
    }

    memo.set(key, best);
    return best;
  }

  function scoreMove(move, follow, mode) {
    const density = move.removed / move.area;
    if (mode === 'greedy') {
      return (
        move.removed * 1000 +
        follow.futureGain * 40 +
        density * 10 -
        move.area * 0.15
      );
    }
    if (mode === 'builder') {
      return (
        follow.futureGain * 120 +
        follow.futureMoves * 25 -
        move.removed * 8 -
        move.area * 0.08 +
        density * 6
      );
    }
    return (
      follow.futureGain * 100 +
      move.removed * 30 +
      density * 15 -
      move.area * 0.25
    );
  }

  function internalMovePriority(move, mode) {
    const density = move.removed / move.area;
    if (mode === 'greedy') {
      return move.removed * 100 + density * 10 - move.area * 0.2;
    }
    if (mode === 'builder') {
      return density * 40 - move.removed * 8 - move.area * 0.12;
    }
    return move.removed * 20 + density * 18 - move.area * 0.18;
  }

  function compareHints(a, b, mode) {
    if (b.score !== a.score) return b.score - a.score;
    if (mode === 'greedy') {
      if (b.removed !== a.removed) return b.removed - a.removed;
      if (b.projectedGain !== a.projectedGain) return b.projectedGain - a.projectedGain;
    } else if (mode === 'builder') {
      if (b.projectedGain !== a.projectedGain) return b.projectedGain - a.projectedGain;
      if (a.removed !== b.removed) return a.removed - b.removed;
      if (a.area !== b.area) return a.area - b.area;
    } else {
      if (b.projectedGain !== a.projectedGain) return b.projectedGain - a.projectedGain;
      if (a.removed !== b.removed) return a.removed - b.removed;
      if (a.area !== b.area) return a.area - b.area;
    }
    return a.r1 - b.r1 || a.c1 - b.c1;
  }

  function sameMove(a, b) {
    return !!a && !!b &&
      a.r1 === b.r1 && a.c1 === b.c1 &&
      a.r2 === b.r2 && a.c2 === b.c2;
  }

  function computeHints(board, mode, depth) {
    const memo = new Map();
    const moves = listMoves(board);
    const applesRemaining = countApples(board);

    return moves
      .map((move) => {
        const nextBoard = applyMove(board, move);
        const follow = evaluateBoard(nextBoard, Math.max(0, depth - 1), memo);
        return {
          ...move,
          projectedGain: move.removed + follow.futureGain,
          projectedRemaining: applesRemaining - (move.removed + follow.futureGain),
          followMoves: follow.futureMoves,
          score: scoreMove(move, follow, mode),
        };
      })
      .sort((a, b) => compareHints(a, b, mode))
      .slice(0, HINT_COUNT);
  }

  function exactSolve(board, memo, mode) {
    const key = `${mode}:${board}`;
    if (memo.has(key)) return memo.get(key);

    const moves = listMoves(board);
    if (moves.length === 0) {
      memo.set(key, { futureGain: 0, futureMoves: 0 });
      return memo.get(key);
    }

    let best = { futureGain: 0, futureMoves: 0 };
    for (const move of moves) {
      const nextBoard = applyMove(board, move);
      const next = exactSolve(nextBoard, memo, mode);
      const candidate = {
        futureGain: move.removed + next.futureGain,
        futureMoves: 1 + next.futureMoves,
      };
      if (
        candidate.futureGain > best.futureGain ||
        (candidate.futureGain === best.futureGain && candidate.futureMoves > best.futureMoves)
      ) {
        best = candidate;
      }
    }

    memo.set(key, best);
    return best;
  }

  function computeBeamHints(board, mode, depth, useExactEndgame) {
    const applesRemaining = countApples(board);
    const initialMoves = listMoves(board);
    const exactMemo = new Map();
    const hintMap = new Map();

    if (initialMoves.length === 0) return [];

    let frontier = [{
      board,
      gain: 0,
      futureMoves: 0,
      firstMove: null,
    }];

    for (let ply = 0; ply < depth; ply += 1) {
      const nextStates = [];

      for (const state of frontier) {
        const moves = listMoves(state.board);
        if (moves.length === 0) {
          nextStates.push(state);
          continue;
        }

        moves.sort((a, b) => internalMovePriority(b, mode) - internalMovePriority(a, mode));
        for (const move of moves.slice(0, BEAM_BRANCH_LIMIT)) {
          const nextBoard = applyMove(state.board, move);
          const nextGain = state.gain + move.removed;
          const firstMove = state.firstMove || move;
          let futureGain = nextGain;
          let futureMoves = state.futureMoves + 1;

          if (useExactEndgame && countApples(nextBoard) <= ENDGAME_THRESHOLD) {
            const exact = exactSolve(nextBoard, exactMemo, mode);
            futureGain = nextGain + exact.futureGain;
            futureMoves = state.futureMoves + 1 + exact.futureMoves;
          }

          nextStates.push({
            board: nextBoard,
            gain: nextGain,
            futureMoves,
            firstMove,
            rankScore:
              futureGain * 100 +
              staticBoardPotential(nextBoard) * 4 -
              countApples(nextBoard) * 0.3,
          });

          const key = `${firstMove.r1},${firstMove.c1},${firstMove.r2},${firstMove.c2}`;
          const existing = hintMap.get(key);
          const projectedGain = futureGain;
          const projectedRemaining = applesRemaining - projectedGain;
          const candidate = {
            ...firstMove,
            projectedGain,
            projectedRemaining,
            followMoves: futureMoves,
            score:
              projectedGain * 100 +
              (firstMove.removed / firstMove.area) * 10 -
              firstMove.area * 0.2,
          };
          if (
            !existing ||
            candidate.projectedGain > existing.projectedGain ||
            (candidate.projectedGain === existing.projectedGain && candidate.score > existing.score)
          ) {
            hintMap.set(key, candidate);
          }
        }
      }

      nextStates.sort((a, b) => b.rankScore - a.rankScore || b.gain - a.gain);
      frontier = nextStates.slice(0, BEAM_WIDTH);
      if (frontier.length === 0) break;
    }

    if (hintMap.size === 0) {
      return initialMoves
        .map((move) => ({
          ...move,
          projectedGain: move.removed,
          projectedRemaining: applesRemaining - move.removed,
          followMoves: 1,
          score: move.removed * 100 - move.area,
        }))
        .sort((a, b) => compareHints(a, b, mode))
        .slice(0, HINT_COUNT);
    }

    return [...hintMap.values()]
      .sort((a, b) => compareHints(a, b, mode))
      .slice(0, HINT_COUNT);
  }

  function computeHintsByEngine(board, mode, depth, engine) {
    depth = sanitizeDepth(depth);
    if (engine === 'beam') return computeBeamHints(board, mode, depth, false);
    if (engine === 'beam_exact') return computeBeamHints(board, mode, depth, true);
    return computeHints(board, mode, depth);
  }

  function getPreviewSettings(depth, engine) {
    depth = sanitizeDepth(depth);
    const previewDepth = Math.min(depth, PREVIEW_MAX_AUTO_DEPTH);
    const previewEngine = engine === 'beam_exact' && depth > PREVIEW_MAX_AUTO_DEPTH ? 'beam' : engine;
    return {
      previewDepth,
      previewEngine,
      capped: previewDepth !== depth || previewEngine !== engine,
    };
  }

  function simulatePolicy(board, mode, depth, engine, maxSteps = 170) {
    board = normalizeBoard(board);
    let currentBoard = board;
    let score = 0;
    let steps = 0;
    let firstMove = null;
    const path = [];

    while (steps < maxSteps) {
      const top = computeHintsByEngine(currentBoard, mode, depth, engine)[0];
      if (!top) break;
      if (!firstMove) firstMove = top;
      path.push({
        boardBefore: currentBoard,
        move: {
          r1: top.r1,
          c1: top.c1,
          r2: top.r2,
          c2: top.c2,
          removed: top.removed,
          shape: top.shape,
        },
      });
      currentBoard = applyMove(currentBoard, top);
      score += top.removed;
      steps += 1;
    }

    return {
      score,
      steps,
      remaining: countApples(currentBoard),
      firstMove,
      path,
    };
  }

  function setPlannedRun(simulation, mode, depth, engine) {
    plannedRun = {
      mode,
      depth,
      engine,
      path: (simulation.path || []).map((step) => ({
        boardBefore: normalizeBoard(step.boardBefore),
        move: step.move,
      })),
      index: 0,
    };
  }

  function resetPlannedRun() {
    plannedRun = null;
  }

  function clearPlannedAutoplay() {
    plannedAutoplayArmed = false;
    plannedAutoplayPendingBoard = null;
    if (plannedAutoplayTimer) {
      clearTimeout(plannedAutoplayTimer);
      plannedAutoplayTimer = null;
    }
  }

  function armPlannedAutoplay() {
    if (currentGuidance !== 'planned' || !plannedRun || !plannedRun.path.length) {
      clearPlannedAutoplay();
      return false;
    }
    plannedAutoplayArmed = true;
    return true;
  }

  function alignPlannedRun(board) {
    board = normalizeBoard(board);
    if (!plannedRun || !plannedRun.path.length) return false;

    for (let index = 0; index < plannedRun.path.length; index += 1) {
      const step = plannedRun.path[index];
      if (step.boardBefore === board) {
        plannedRun.index = index;
        return true;
      }
      const nextExpectedBoard = applyMove(step.boardBefore, step.move);
      if (nextExpectedBoard === board) {
        plannedRun.index = index + 1;
        return true;
      }
    }

    if (plannedRun.index >= plannedRun.path.length) return true;
    return false;
  }

  function syncPlannedRunFromCache(board) {
    if (currentGuidance !== 'planned') {
      resetPlannedRun();
      clearPlannedAutoplay();
      return false;
    }
    const simulation = getActivePreviewResults(board, currentDepth, currentEngine)?.results?.[currentMode];
    if (!simulation) {
      resetPlannedRun();
      clearPlannedAutoplay();
      return false;
    }
    setPlannedRun(simulation, currentMode, currentDepth, currentEngine);
    if (!alignPlannedRun(board)) {
      clearPlannedAutoplay();
      return false;
    }
    return true;
  }

  function getPlannedHint(board) {
    board = normalizeBoard(board);
    if (currentGuidance !== 'planned' || !plannedRun) return null;
    if (!alignPlannedRun(board)) return null;
    const step = plannedRun.path[plannedRun.index];
    if (!step || step.boardBefore !== board) return null;
    return {
      ...step.move,
      projectedGain: step.move.removed,
      projectedRemaining: countApples(board) - step.move.removed,
      followMoves: plannedRun.path.length - plannedRun.index,
      score: Number.MAX_SAFE_INTEGER,
      planned: true,
    };
  }

  function getLiveHints(board) {
    return computeHintsByEngine(board, currentMode, currentDepth, currentEngine);
  }

  function computeDisplayHints(board) {
    const plannedHint = getPlannedHint(board);
    if (plannedHint) return [plannedHint];
    return getLiveHints(board);
  }

  function createPreviewWorker() {
    const source = `
      self.onmessage = (event) => {
        const { board, mode, depth, engine, maxSteps, config } = event.data;
        const GRID_ROWS = config.GRID_ROWS;
        const GRID_COLS = config.GRID_COLS;
        const TARGET_SUM = config.TARGET_SUM;
        const BRANCH_LIMIT = config.BRANCH_LIMIT;
        const BEAM_WIDTH = config.BEAM_WIDTH;
        const BEAM_BRANCH_LIMIT = config.BEAM_BRANCH_LIMIT;
        const ENDGAME_THRESHOLD = config.ENDGAME_THRESHOLD;

        function boardToGrid(value) {
          const grid = [];
          for (let r = 0; r < GRID_ROWS; r += 1) {
            const row = [];
            for (let c = 0; c < GRID_COLS; c += 1) row.push(Number(value[r * GRID_COLS + c]));
            grid.push(row);
          }
          return grid;
        }

        function gridToBoard(grid) {
          return grid.map((row) => row.join('')).join('');
        }

        function countApples(value) {
          let count = 0;
          for (const ch of value) if (ch !== '0') count += 1;
          return count;
        }

        function listMoves(value) {
          const grid = boardToGrid(value);
          const prefix = Array.from({ length: GRID_ROWS + 1 }, () => Array(GRID_COLS + 1).fill(0));
          const nonZeroPrefix = Array.from({ length: GRID_ROWS + 1 }, () => Array(GRID_COLS + 1).fill(0));
          for (let r = 0; r < GRID_ROWS; r += 1) {
            for (let c = 0; c < GRID_COLS; c += 1) {
              prefix[r + 1][c + 1] = grid[r][c] + prefix[r][c + 1] + prefix[r + 1][c] - prefix[r][c];
              nonZeroPrefix[r + 1][c + 1] = (grid[r][c] !== 0 ? 1 : 0) + nonZeroPrefix[r][c + 1] + nonZeroPrefix[r + 1][c] - nonZeroPrefix[r][c];
            }
          }
          const moves = [];
          for (let r1 = 0; r1 < GRID_ROWS; r1 += 1) {
            for (let c1 = 0; c1 < GRID_COLS; c1 += 1) {
              for (let r2 = r1; r2 < GRID_ROWS; r2 += 1) {
                for (let c2 = c1; c2 < GRID_COLS; c2 += 1) {
                  const sum = prefix[r2 + 1][c2 + 1] - prefix[r1][c2 + 1] - prefix[r2 + 1][c1] + prefix[r1][c1];
                  if (sum !== TARGET_SUM) continue;
                  const removed = nonZeroPrefix[r2 + 1][c2 + 1] - nonZeroPrefix[r1][c2 + 1] - nonZeroPrefix[r2 + 1][c1] + nonZeroPrefix[r1][c1];
                  if (!removed) continue;
                  moves.push({ r1, c1, r2, c2, removed, area: (r2 - r1 + 1) * (c2 - c1 + 1), shape: (r2 - r1 + 1) + 'x' + (c2 - c1 + 1) });
                }
              }
            }
          }
          return moves;
        }

        function applyMove(value, move) {
          const grid = boardToGrid(value);
          for (let r = move.r1; r <= move.r2; r += 1) for (let c = move.c1; c <= move.c2; c += 1) if (grid[r][c] !== 0) grid[r][c] = 0;
          return gridToBoard(grid);
        }

        function evaluateBoard(value, remainingDepth, memo) {
          const key = remainingDepth + ':' + value;
          if (memo.has(key)) return memo.get(key);
          const moves = listMoves(value);
          if (remainingDepth <= 0 || moves.length === 0) {
            const base = { futureGain: 0, futureMoves: 0 };
            memo.set(key, base);
            return base;
          }
          moves.sort((a, b) => a.removed - b.removed || a.area - b.area || a.r1 - b.r1 || a.c1 - b.c1);
          let best = { futureGain: 0, futureMoves: 0 };
          for (const move of moves.slice(0, BRANCH_LIMIT)) {
            const next = evaluateBoard(applyMove(value, move), remainingDepth - 1, memo);
            const candidate = { futureGain: move.removed + next.futureGain, futureMoves: 1 + next.futureMoves };
            if (candidate.futureGain > best.futureGain || (candidate.futureGain === best.futureGain && candidate.futureMoves > best.futureMoves)) best = candidate;
          }
          memo.set(key, best);
          return best;
        }

        function exactSolve(value, memo) {
          if (memo.has(value)) return memo.get(value);
          const moves = listMoves(value);
          if (moves.length === 0) {
            const base = { futureGain: 0, futureMoves: 0 };
            memo.set(value, base);
            return base;
          }
          let best = { futureGain: 0, futureMoves: 0 };
          for (const move of moves) {
            const next = exactSolve(applyMove(value, move), memo);
            const candidate = { futureGain: move.removed + next.futureGain, futureMoves: 1 + next.futureMoves };
            if (candidate.futureGain > best.futureGain || (candidate.futureGain === best.futureGain && candidate.futureMoves > best.futureMoves)) best = candidate;
          }
          memo.set(value, best);
          return best;
        }

        function scoreMove(move, follow) {
          const density = move.removed / move.area;
          if (mode === 'greedy') return move.removed * 1000 + follow.futureGain * 40 + density * 10 - move.area * 0.15;
          if (mode === 'builder') return follow.futureGain * 120 + follow.futureMoves * 25 - move.removed * 8 - move.area * 0.08 + density * 6;
          return follow.futureGain * 100 + move.removed * 30 + density * 15 - move.area * 0.25;
        }

        function compareHints(a, b) {
          if (b.score !== a.score) return b.score - a.score;
          if (mode === 'greedy') {
            if (b.removed !== a.removed) return b.removed - a.removed;
            if (b.projectedGain !== a.projectedGain) return b.projectedGain - a.projectedGain;
          } else if (mode === 'builder') {
            if (b.projectedGain !== a.projectedGain) return b.projectedGain - a.projectedGain;
            if (a.removed !== b.removed) return a.removed - b.removed;
            if (a.area !== b.area) return a.area - b.area;
          } else {
            if (b.projectedGain !== a.projectedGain) return b.projectedGain - a.projectedGain;
            if (a.removed !== b.removed) return a.removed - b.removed;
            if (a.area !== b.area) return a.area - b.area;
          }
          return a.r1 - b.r1 || a.c1 - b.c1;
        }

        function internalMovePriority(move) {
          const density = move.removed / move.area;
          if (mode === 'greedy') return move.removed * 100 + density * 10 - move.area * 0.2;
          if (mode === 'builder') return density * 40 - move.removed * 8 - move.area * 0.12;
          return move.removed * 20 + density * 18 - move.area * 0.18;
        }

        function staticBoardPotential(value) {
          return listMoves(value).length;
        }

        function computeHintsByEngine(value) {
          if (engine === 'heuristic') {
            const memo = new Map();
            const moves = listMoves(value);
            const applesRemaining = countApples(value);
            return moves.map((move) => {
              const follow = evaluateBoard(applyMove(value, move), Math.max(0, depth - 1), memo);
              return { ...move, projectedGain: move.removed + follow.futureGain, projectedRemaining: applesRemaining - (move.removed + follow.futureGain), followMoves: follow.futureMoves, score: scoreMove(move, follow) };
            }).sort(compareHints);
          }

          const applesRemaining = countApples(value);
          const initialMoves = listMoves(value);
          const exactMemo = new Map();
          const hintMap = new Map();
          let frontier = [{ board: value, gain: 0, futureMoves: 0, firstMove: null }];
          for (let ply = 0; ply < depth; ply += 1) {
            const nextStates = [];
            for (const state of frontier) {
              const moves = listMoves(state.board);
              if (moves.length === 0) {
                nextStates.push(state);
                continue;
              }
              moves.sort((a, b) => internalMovePriority(b) - internalMovePriority(a));
              for (const move of moves.slice(0, BEAM_BRANCH_LIMIT)) {
                const nextBoard = applyMove(state.board, move);
                const nextGain = state.gain + move.removed;
                const firstMove = state.firstMove || move;
                let futureGain = nextGain;
                let futureMoves = state.futureMoves + 1;
                if (engine === 'beam_exact' && countApples(nextBoard) <= ENDGAME_THRESHOLD) {
                  const exact = exactSolve(nextBoard, exactMemo);
                  futureGain = nextGain + exact.futureGain;
                  futureMoves = state.futureMoves + 1 + exact.futureMoves;
                }
                nextStates.push({ board: nextBoard, gain: nextGain, futureMoves, firstMove, rankScore: futureGain * 100 + staticBoardPotential(nextBoard) * 4 - countApples(nextBoard) * 0.3 });
                const key = firstMove.r1 + ',' + firstMove.c1 + ',' + firstMove.r2 + ',' + firstMove.c2;
                const candidate = { ...firstMove, projectedGain: futureGain, projectedRemaining: applesRemaining - futureGain, followMoves: futureMoves, score: futureGain * 100 + (firstMove.removed / firstMove.area) * 10 - firstMove.area * 0.2 };
                const existing = hintMap.get(key);
                if (!existing || candidate.projectedGain > existing.projectedGain || (candidate.projectedGain === existing.projectedGain && candidate.score > existing.score)) hintMap.set(key, candidate);
              }
            }
            nextStates.sort((a, b) => b.rankScore - a.rankScore || b.gain - a.gain);
            frontier = nextStates.slice(0, BEAM_WIDTH);
            if (frontier.length === 0) break;
          }
          if (hintMap.size === 0) {
            return initialMoves.map((move) => ({ ...move, projectedGain: move.removed, projectedRemaining: applesRemaining - move.removed, followMoves: 1, score: move.removed * 100 - move.area })).sort(compareHints);
          }
          return [...hintMap.values()].sort(compareHints);
        }

        function simulate() {
          let current = board;
          let score = 0;
          let steps = 0;
          let firstMove = null;
          const path = [];
          while (steps < maxSteps) {
            const top = computeHintsByEngine(current)[0];
            if (!top) break;
            if (!firstMove) firstMove = top;
            path.push({ boardBefore: current, move: { r1: top.r1, c1: top.c1, r2: top.r2, c2: top.c2, removed: top.removed, shape: top.shape } });
            current = applyMove(current, top);
            score += top.removed;
            steps += 1;
          }
          return { score, steps, remaining: countApples(current), firstMove, path };
        }

        self.postMessage({ mode, simulation: simulate() });
      };
    `;
    return new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
  }

  function startPreviewComputation(board, depth, engine) {
    depth = sanitizeDepth(depth);
    board = normalizeBoard(board);
    const cacheKey = getPreviewCacheKey(board, depth, engine);
    const cached = previewCache.get(cacheKey);
    lastPreviewKey = cacheKey;
    if (cached) {
      previewRequested = true;
      previewInProgress = false;
      previewResults = cached;
      setPanelPreview(`<div class="muted">cache hit</div><div style="margin-top:4px">저장된 계산 결과를 바로 불러왔습니다.</div>`);
      updateOpeningPreview(board, depth, engine);
      return;
    }

    previewJobId += 1;
    const jobId = previewJobId;
    previewRequested = true;
    previewInProgress = true;
    previewResults = { board, depth, engine, results: {} };
    setPanelPreview(`<div class="muted">계산 중...</div><div style="margin-top:4px">모드 3개를 병렬 계산하고 있습니다. 현재 ${ENGINES[engine].label} · ${depth}수</div>`);

    const config = {
      GRID_ROWS,
      GRID_COLS,
      TARGET_SUM,
      BRANCH_LIMIT,
      BEAM_WIDTH,
      BEAM_BRANCH_LIMIT,
      ENDGAME_THRESHOLD,
    };

    for (const mode of Object.keys(MODES)) {
      const worker = createPreviewWorker();
      worker.onmessage = (event) => {
        worker.terminate();
        if (jobId !== previewJobId) return;
        previewResults.results[event.data.mode] = event.data.simulation;
        if (Object.keys(previewResults.results).length === Object.keys(MODES).length) {
          previewInProgress = false;
          previewCache.set(cacheKey, {
            board,
            depth,
            engine,
            results: { ...previewResults.results },
          });
          persistPreviewCache();
          updateOpeningPreview(board, depth, engine);
        }
      };
      worker.onerror = () => {
        worker.terminate();
        if (jobId !== previewJobId) return;
        previewResults.results[mode] = null;
        if (Object.keys(previewResults.results).length === Object.keys(MODES).length) {
          previewInProgress = false;
          previewCache.set(cacheKey, {
            board,
            depth,
            engine,
            results: { ...previewResults.results },
          });
          persistPreviewCache();
          updateOpeningPreview(board, depth, engine);
        }
      };
      worker.postMessage({ board, mode, depth, engine, maxSteps: 170, config });
    }
  }

  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;

    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="row" style="justify-content:space-between">
        <div class="title">Apple Solver</div>
        <div class="muted" data-role="status">waiting</div>
      </div>
      <div class="row" style="margin-top:8px; justify-content:space-between">
        <label class="muted" for="${PANEL_ID}-mode">추천 모드</label>
        <select id="${PANEL_ID}-mode" data-role="mode">
          <option value="balanced">균형</option>
          <option value="greedy">즉시 최대</option>
          <option value="builder">길 만들기</option>
        </select>
      </div>
      <div class="row" style="margin-top:8px; justify-content:space-between">
        <label class="muted" for="${PANEL_ID}-engine">탐색 엔진</label>
        <select id="${PANEL_ID}-engine" data-role="engine">
          <option value="heuristic">휴리스틱</option>
          <option value="beam">빔 서치</option>
          <option value="beam_exact">빔 + 엔드게임</option>
        </select>
      </div>
      <div class="row" style="margin-top:8px; justify-content:space-between">
        <label class="muted" for="${PANEL_ID}-depth">탐색 깊이</label>
        <select id="${PANEL_ID}-depth" data-role="depth">
          <option value="1">1수</option>
          <option value="2">2수</option>
          <option value="3">3수</option>
        </select>
      </div>
      <div class="row" style="margin-top:8px; justify-content:space-between">
        <label class="muted" for="${PANEL_ID}-guidance">안내 방식</label>
        <select id="${PANEL_ID}-guidance" data-role="guidance">
          <option value="live">실시간 재계산</option>
          <option value="planned">계획 따라가기</option>
        </select>
      </div>
      <div class="hint" data-role="hint">${getNoBoardHintMessage()}</div>
      <div class="preview" data-role="preview">${getPreGamePreviewMessage()}</div>
      <div class="row" style="margin-top:8px">
        <button type="button" data-action="play">Auto Drag</button>
        <button type="button" data-action="refresh">Refresh</button>
        <button type="button" data-action="preview">오프닝 계산</button>
      </div>
      <div class="muted" style="margin-top:8px">
        단축키: <strong>\\</strong> 1순위 자동 실행
      </div>
    `;
    document.body.appendChild(panel);

    const modeSelect = panel.querySelector('[data-role="mode"]');
    if (modeSelect) {
      modeSelect.value = currentMode;
      modeSelect.addEventListener('change', (event) => {
        saveMode(event.target.value);
        const context = getGameContext();
        if (!context || !syncPlannedRunFromCache(context.board)) resetPlannedRun();
        if (!context || currentGuidance !== 'planned') {
          clearPlannedAutoplay();
        } else {
          armPlannedAutoplay();
          schedulePlannedAutoplay();
        }
        refreshHints(true);
      });
    }
    const engineSelect = panel.querySelector('[data-role="engine"]');
    if (engineSelect) {
      engineSelect.value = currentEngine;
      engineSelect.addEventListener('change', (event) => {
        saveEngine(event.target.value);
        const context = getGameContext();
        if (!context || !syncPlannedRunFromCache(context.board)) resetPlannedRun();
        if (!context || currentGuidance !== 'planned') clearPlannedAutoplay();
        refreshHints(true);
      });
    }
    const depthSelect = panel.querySelector('[data-role="depth"]');
    if (depthSelect) {
      depthSelect.value = String(currentDepth);
      depthSelect.addEventListener('change', (event) => {
        saveDepth(Number(event.target.value));
        const context = getGameContext();
        if (!context || !syncPlannedRunFromCache(context.board)) resetPlannedRun();
        if (!context || currentGuidance !== 'planned') clearPlannedAutoplay();
        refreshHints(true);
      });
    }
    const guidanceSelect = panel.querySelector('[data-role="guidance"]');
    if (guidanceSelect) {
      guidanceSelect.value = currentGuidance;
      guidanceSelect.addEventListener('change', (event) => {
        saveGuidance(event.target.value);
        const context = getGameContext();
        if (!context || !syncPlannedRunFromCache(context.board)) resetPlannedRun();
        if (currentGuidance !== 'planned') clearPlannedAutoplay();
        refreshHints(true);
      });
    }

    panel.addEventListener('click', (event) => {
      const action = event.target?.dataset?.action;
      if (!action) return;
      if (action === 'refresh') refreshHints(true);
      if (action === 'play') autoplayActiveHint();
      if (action === 'preview') {
        const context = getGameContext();
        if (context) startPreviewComputation(context.board, currentDepth, currentEngine);
      }
      if (action === 'pick-mode') {
        saveMode(event.target.dataset.mode);
        const modeSelect = panel.querySelector('[data-role="mode"]');
        if (modeSelect) modeSelect.value = currentMode;
        const context = getGameContext();
        if (!context || !syncPlannedRunFromCache(context.board)) resetPlannedRun();
        if (!context || currentGuidance !== 'planned') {
          clearPlannedAutoplay();
        } else {
          armPlannedAutoplay();
          schedulePlannedAutoplay();
        }
        refreshHints(true);
      }
    });

    window.addEventListener('keydown', (event) => {
      if (event.target && ['INPUT', 'TEXTAREA'].includes(event.target.tagName)) return;
      if (event.key === '\\') {
        event.preventDefault();
        autoplayActiveHint();
      }
    });

    return panel;
  }

  function ensureOverlay(canvas) {
    let overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = OVERLAY_ID;
      document.body.appendChild(overlay);
    }
    return overlay;
  }

  function setPanelStatus(text) {
    const panel = ensurePanel();
    const node = panel.querySelector('[data-role="status"]');
    if (node) node.textContent = text;
  }

  function setPanelHint(text) {
    const panel = ensurePanel();
    const node = panel.querySelector('[data-role="hint"]');
    if (node) node.innerHTML = text;
  }

  function setPanelPreview(text) {
    const panel = ensurePanel();
    const node = panel.querySelector('[data-role="preview"]');
    if (node) node.innerHTML = text;
  }

  function renderPreviewIdleMessage() {
    setPanelPreview(
      canPreviewCurrentBoard()
        ? '현재 보드 정책 계산은 `오프닝 계산` 버튼을 눌렀을 때만 계산합니다.'
        : '게임 시작 전 예상치는 `오프닝 계산` 버튼을 눌렀을 때만 계산합니다.'
    );
  }

  function invalidatePreviewResults() {
    previewResults = null;
    previewRequested = false;
    previewInProgress = false;
    lastPreviewKey = null;
  }

  function getPreviewCacheKey(board, depth, engine) {
    return `${normalizeBoard(board)}|${depth}|${engine}`;
  }

  function getActivePreviewResults(board, depth, engine) {
    const normalizedBoard = normalizeBoard(board);
    if (!normalizedBoard) return null;
    if (
      previewResults &&
      normalizeBoard(previewResults.board) === normalizedBoard &&
      previewResults.depth === depth &&
      previewResults.engine === engine
    ) {
      return previewResults;
    }
    return previewCache.get(getPreviewCacheKey(normalizedBoard, depth, engine)) || null;
  }

  function updateButtonState() {
    const panel = ensurePanel();
    const disabled = hints.length === 0;
    for (const button of panel.querySelectorAll('button')) {
      if (button.dataset.action === 'refresh') continue;
      button.disabled = disabled;
    }
  }

  function updateOpeningPreview(board, depth, engine) {
    if (!board) {
      setPanelPreview(getPreGamePreviewMessage());
      return;
    }
    if (!isReadyState() && !canPreviewCurrentBoard()) {
      setPanelPreview('진행 중에는 현재 선택한 모드 기준 힌트만 표시합니다.');
      return;
    }
    const activeResults = getActivePreviewResults(board, depth, engine);
    const hasCachedResults = !!activeResults;
    if (!previewRequested && !hasCachedResults) {
      renderPreviewIdleMessage();
      return;
    }
    if (previewInProgress) {
      setPanelPreview(
        `<div class="muted">계산 중...</div><div style="margin-top:4px">현재 ${ENGINES[engine].label} · ${depth}수 기준 정책 결과를 계산하고 있습니다.</div>`
      );
      return;
    }
    if (!activeResults) {
      renderPreviewIdleMessage();
      return;
    }

    const rows = Object.entries(MODES).map(([mode, meta]) => {
      const simulation = activeResults.results[mode];
      if (!simulation) {
        return `<div class="preview-row"><span>${meta.label}</span><span class="muted">계산 실패</span></div>`;
      }
      const top = simulation.firstMove;
      if (!top || simulation.score === 0) {
        return `<div class="preview-row"><span>${meta.label}</span><span class="muted">계산 실패</span></div>`;
      }
      return [
        '<div class="preview-row">',
        `<button type="button" data-action="pick-mode" data-mode="${mode}">${meta.label}</button>`,
        `<span>첫수 +${top.removed} / 최종 ${simulation.score}점</span>`,
        '</div>',
      ].join('');
    }).join('');

    setPanelPreview(
      [
        `<div class="muted" style="margin-bottom:4px">${canPreviewCurrentBoard() && !isReadyState() ? '현재 보드 정책 계산' : '오프닝 미리보기'} · ${ENGINES[engine].label} · ${depth}수</div>`,
        hasCachedResults && !previewInProgress ? '<div class="muted" style="margin-bottom:4px">저장된 계산 결과를 사용 중입니다.</div>' : '',
        rows,
      ].join('')
    );
  }

  function renderOverlay(context) {
    const overlay = ensureOverlay(context.canvas);
    if (!overlay) return;
    overlay.innerHTML = '';

    hints.forEach((hint, index) => {
      const box = document.createElement('div');
      box.className = `box ${index === hintIndex ? ACTIVE_CLASS : ''}`;
      const left = context.rect.left + context.padX + hint.c1 * context.cellSize;
      const top = context.rect.top + context.padY + hint.r1 * context.cellSize;
      const width = (hint.c2 - hint.c1 + 1) * context.cellSize;
      const height = (hint.r2 - hint.r1 + 1) * context.cellSize;
      Object.assign(box.style, {
        left: `${left}px`,
        top: `${top}px`,
        width: `${width}px`,
        height: `${height}px`,
      });

      const badge = document.createElement('div');
      badge.className = 'badge';
      badge.textContent = `${index + 1}`;
      box.appendChild(badge);

      overlay.appendChild(box);
    });
  }

  function updatePanelHint() {
    updateButtonState();
    if (!hints.length) {
      setPanelHint('가능한 합 10 직사각형이 없습니다.');
      return;
    }
    const hint = hints[hintIndex];
    const modeLabel = MODES[currentMode]?.label || currentMode;
    const engineLabel = ENGINES[currentEngine]?.label || currentEngine;
    setPanelHint(
      [
        `<strong>${modeLabel}</strong> · <strong>${engineLabel}</strong> · <strong>${currentDepth}수 탐색</strong> · <strong>${GUIDANCE[currentGuidance].label}</strong>`,
        `<strong>#${hintIndex + 1}</strong> ${hint.shape}`,
        `즉시 <strong>+${hint.removed}</strong>`,
        `${hint.planned ? '계획 수순' : `${currentDepth}수 예상`} <strong>+${hint.projectedGain}</strong>`,
        `좌표 <strong>(${hint.r1 + 1},${hint.c1 + 1})</strong> → <strong>(${hint.r2 + 1},${hint.c2 + 1})</strong>`,
      ].join(' · ')
    );
  }

  function dispatchMouse(target, type, x, y) {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: type === 'mouseup' ? 0 : 1,
    });
    target.dispatchEvent(event);
  }

  function autoplayHint(context, hint) {
    if (typeof context.onMove === 'function') {
      const nextBoard = applyMove(context.board, hint);
      context.onMove(
        { r1: hint.r1, c1: hint.c1, r2: hint.r2, c2: hint.c2 },
        nextBoard,
        hint.removed
      );
      return;
    }

    const startX = context.rect.left + context.padX + (hint.c1 + 0.5) * context.cellSize;
    const startY = context.rect.top + context.padY + (hint.r1 + 0.5) * context.cellSize;
    const endX = context.rect.left + context.padX + (hint.c2 + 0.5) * context.cellSize;
    const endY = context.rect.top + context.padY + (hint.r2 + 0.5) * context.cellSize;
    const props = getReactProps(context.canvas);

    if (props?.onMouseDown) {
      props.onMouseDown(createMouseLikeEvent('mousedown', startX, startY, context.canvas));
    } else {
      dispatchMouse(context.canvas, 'mousedown', startX, startY);
    }

    const midX = (startX + endX) / 2;
    const midY = (startY + endY) / 2;
    dispatchMouse(document, 'mousemove', midX, midY);
    dispatchMouse(document, 'mousemove', endX, endY);
    dispatchMouse(document, 'mouseup', endX, endY);
  }

  function autoplayActiveHint() {
    const context = getGameContext();
    if (!context) return;
    const latestHints = computeDisplayHints(context.board);
    if (!latestHints.length) return;
    hints = latestHints.slice(0, HINT_COUNT);
    hintIndex = 0;
    updatePanelHint();
    renderOverlay(context);
    autoplayHint(context, latestHints[0]);
  }

  function schedulePlannedAutoplay() {
    if (!plannedAutoplayArmed || currentGuidance !== 'planned' || previewInProgress) {
      clearPlannedAutoplay();
      return;
    }
    const context = getGameContext();
    if (!context) return;
    const plannedHint = getPlannedHint(context.board);
    if (!plannedHint) {
      clearPlannedAutoplay();
      return;
    }
    if (plannedAutoplayTimer && plannedAutoplayPendingBoard === context.board) return;
    if (plannedAutoplayTimer) clearTimeout(plannedAutoplayTimer);
    plannedAutoplayPendingBoard = context.board;
    plannedAutoplayTimer = setTimeout(() => {
      plannedAutoplayTimer = null;
      const nextContext = getGameContext();
      if (!nextContext) return;
      const nextHint = getPlannedHint(nextContext.board);
      if (!nextHint) {
        clearPlannedAutoplay();
        return;
      }
      hints = [nextHint];
      hintIndex = 0;
      updatePanelHint();
      renderOverlay(nextContext);
      autoplayHint(nextContext, nextHint);
      setTimeout(() => refreshHints(true), PLAN_AUTOPLAY_DELAY_MS);
    }, PLAN_AUTOPLAY_DELAY_MS);
  }

  function refreshHints(force = false) {
    const context = getGameContext();
    if (!context) {
      hints = [];
      hintIndex = 0;
      lastBoard = null;
      previewJobId += 1;
      previewResults = null;
      previewInProgress = false;
      clearPlannedAutoplay();
      setPanelStatus('no board');
      setPanelHint(getNoBoardHintMessage());
      setPanelPreview(getPreGamePreviewMessage());
      updateButtonState();
      return;
    }

    if (!force && lastBoard === context.board && lastCanvas === context.canvas) return;

    if (lastBoard !== context.board) {
      previewJobId += 1;
      previewResults = null;
      previewInProgress = false;
    }
    if (currentGuidance === 'planned' && !plannedRun) {
      syncPlannedRunFromCache(context.board);
    }
    if (plannedRun && currentGuidance === 'planned' && !alignPlannedRun(context.board)) {
      resetPlannedRun();
      clearPlannedAutoplay();
    }
    lastBoard = context.board;
    lastCanvas = context.canvas;
    setPanelStatus('thinking');
    hints = computeDisplayHints(context.board);
    hintIndex = 0;
    setPanelStatus(
      `${countApples(context.board)} apples · ${MODES[currentMode].label} · ${ENGINES[currentEngine].label} · ${currentDepth}수 · ${GUIDANCE[currentGuidance].label}`
    );
    updatePanelHint();
    updateOpeningPreview(context.board, currentDepth, currentEngine);
    renderOverlay(context);
    if (currentGuidance === 'planned' && hints[0]?.planned) schedulePlannedAutoplay();
  }

  function boot() {
    injectStyle();
    ensurePanel();
    refreshHints(true);
    setInterval(() => refreshHints(false), POLL_MS);
  }

  boot();
})();
