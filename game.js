// 游戏核心逻辑：匹配、落子、胜负判定、悔棋、认输、好友邀请
const db = require('./db');

const BOARD_SIZE = 15;

// 内存中的等待队列：[{ userId, username, socketId }]
const waitingQueue = [];

// 每局思考计时器：gameId -> { timerHandle, currentColor, timeoutCount: { black, white } }
const turnTimers = new Map();

const TURN_SECONDS = 90;
const MAX_TIMEOUTS = 2;

function clearTurnTimer(gameId) {
  const t = turnTimers.get(gameId);
  if (t && t.timerHandle) {
    clearTimeout(t.timerHandle);
  }
  turnTimers.delete(gameId);
}

function startTurnTimer(gameId) {
  clearTurnTimer(gameId);
  const game = getGameSync(gameId);
  if (!game || game.status !== 'playing') return;
  const color = game.current_turn;
  const state = turnTimers.get(gameId) || { timeoutCount: { black: 0, white: 0 } };
  state.currentColor = color;
  const handle = setTimeout(() => onTurnTimeout(gameId), TURN_SECONDS * 1000);
  state.timerHandle = handle;
  turnTimers.set(gameId, state);
  const blackSock = getSocketByUserId(game.player_black_id);
  const whiteSock = getSocketByUserId(game.player_white_id);
  const payload = { gameId, turnSeconds: TURN_SECONDS, color };
  if (blackSock) blackSock.emit('turn_started', payload);
  if (whiteSock) whiteSock.emit('turn_started', payload);
}

async function onTurnTimeout(gameId) {
  const game = getGameSync(gameId);
  if (!game || game.status !== 'playing') {
    clearTurnTimer(gameId);
    return;
  }
  const state = turnTimers.get(gameId);
  if (!state) return;
  const color = game.current_turn;
  state.timeoutCount[color] = (state.timeoutCount[color] || 0) + 1;
  const count = state.timeoutCount[color];
  if (count >= MAX_TIMEOUTS) {
    clearTurnTimer(gameId);
    const winnerId = color === 'black' ? game.player_white_id : game.player_black_id;
    await db.run(
      `UPDATE games SET status = 'finished', winner_id = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?`,
      winnerId, gameId
    );
    const winnerUser = await db.get('SELECT id, username FROM users WHERE id = ?', winnerId);
    const reason = 'timeout_2x';
    const blackSock = getSocketByUserId(game.player_black_id);
    const whiteSock = getSocketByUserId(game.player_white_id);
    const payload = { winner: winnerId, winnerUsername: winnerUser?.username || '', reason, loser: color };
    if (blackSock) blackSock.emit('game_over', payload);
    if (whiteSock) whiteSock.emit('game_over', payload);
  } else {
    const cur = getSocketByUserId(color === 'black' ? game.player_black_id : game.player_white_id);
    if (cur) {
      cur.emit('turn_timeout', { gameId, color, count, remaining: MAX_TIMEOUTS - count, seconds: TURN_SECONDS });
    }
    startTurnTimer(gameId);
  }
}

// 待响应的邀请
const pendingInvites = new Map();
function inviteKey(a, b) { return a < b ? `${a}:${b}` : `${b}:${a}`; }

// 内存中 socketId -> userId 的映射
const socketUserMap = new Map();
const userSocketMap = new Map();

function registerSocket(socket, user) {
  socketUserMap.set(socket.id, user.id);
  if (!userSocketMap.has(user.id)) userSocketMap.set(user.id, new Set());
  userSocketMap.get(user.id).add(socket.id);
  for (let i = 0; i < waitingQueue.length; i++) {
    if (waitingQueue[i].userId === user.id) {
      waitingQueue[i].socketId = socket.id;
      console.log(`[registerSocket] updated queue socketId for user=${user.id}`);
      break;
    }
  }
}

async function unregisterSocket(socket) {
  const userId = socketUserMap.get(socket.id);
  socketUserMap.delete(socket.id);
  if (userId) {
    const set = userSocketMap.get(userId);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) userSocketMap.delete(userId);
    }
  }
  if (userId && !isUserOnline(userId)) {
    for (let i = waitingQueue.length - 1; i >= 0; i--) {
      if (waitingQueue[i].userId === userId) {
        console.log(`[unregisterSocket] user=${userId} truly offline, remove from queue`);
        waitingQueue.splice(i, 1);
      }
    }
  }
  if (userId && isUserOnline(userId)) {
    console.log(`[unregisterSocket] user=${userId} still has other connection, skip opponent notify`);
    return;
  }
  for (const [k, v] of pendingInvites.entries()) {
    if (v.toId === userId) {
      pendingInvites.delete(k);
      const fromSock = getSocketByUserId(v.fromId);
      if (fromSock) fromSock.emit('invite_cancelled', { reason: 'offline' });
    }
  }
  for (const [k, v] of pendingRematch.entries()) {
    if (v.toId === userId) {
      pendingRematch.delete(k);
      const fromSock = getSocketByUserId(v.fromId);
      if (fromSock) fromSock.emit('rematch_cancelled', { reason: 'offline' });
    }
  }
  if (userId) {
    try {
      const rows = await db.all(
        `SELECT id, player_black_id, player_white_id, status FROM games
         WHERE status = 'playing' AND (player_black_id = ? OR player_white_id = ?)`,
        userId, userId
      );
      for (const g of rows) {
        if (!hasUserJoinedGame(g.id, userId)) {
          console.log(`[unregisterSocket] user=${userId} never joined game=${g.id}, skip notify`);
          continue;
        }
        const opponentId = g.player_black_id === userId ? g.player_white_id : g.player_black_id;
        const opSock = getSocketByUserId(opponentId);
        if (opSock) {
          opSock.emit('opponent_disconnected', { userId, gameId: g.id });
        }
      }
    } catch (_) {}
  }
}

function getSocketByUserId(userId) {
  const set = userSocketMap.get(userId);
  if (!set || set.size === 0) return null;
  for (const sid of set) {
    const s = global.__io?.sockets.sockets.get(sid);
    if (s) return s;
  }
  return null;
}

function isUserOnline(userId) {
  const set = userSocketMap.get(userId);
  if (!set || set.size === 0) return false;
  for (const sid of set) {
    if (global.__io?.sockets.sockets.get(sid)) return true;
  }
  return false;
}

function checkWin(board, x, y, player) {
  const directions = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (const [dx, dy] of directions) {
    let count = 1;
    let i = 1;
    while (true) {
      const nx = x + dx * i;
      const ny = y + dy * i;
      if (nx < 0 || nx >= BOARD_SIZE || ny < 0 || ny >= BOARD_SIZE) break;
      if (board[nx][ny] !== player) break;
      count++;
      i++;
    }
    i = 1;
    while (true) {
      const nx = x - dx * i;
      const ny = y - dy * i;
      if (nx < 0 || nx >= BOARD_SIZE || ny < 0 || ny >= BOARD_SIZE) break;
      if (board[nx][ny] !== player) break;
      count++;
      i++;
    }
    if (count >= 5) return true;
  }
  return false;
}

function buildBoard(boardState) {
  const board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
  for (const m of boardState) {
    board[m.x][m.y] = m.player;
  }
  return board;
}

// 内存缓存：避免频繁查询数据库
const gameCache = new Map();

async function getGame(gameId) {
  const row = await db.get('SELECT * FROM games WHERE id = ?', gameId);
  if (!row) return null;
  const game = {
    ...row,
    board_state: JSON.parse(row.board_state),
    move_history: JSON.parse(row.move_history),
  };
  gameCache.set(gameId, game);
  return game;
}

// 同步版本：用于内部调用（从缓存获取）
function getGameSync(gameId) {
  return gameCache.get(gameId) || null;
}

function getPlayerColor(game, userId) {
  if (game.player_black_id === userId) return 'black';
  if (game.player_white_id === userId) return 'white';
  return null;
}

function getOpponentId(game, userId) {
  if (game.player_black_id === userId) return game.player_white_id;
  if (game.player_white_id === userId) return game.player_black_id;
  return null;
}

async function createGame(playerBlackId, playerWhiteId) {
  const result = await db.run(
    `INSERT INTO games (player_black_id, player_white_id, board_state, move_history, current_turn, status)
     VALUES (?, ?, '[]', '[]', 'black', 'playing')`,
    playerBlackId, playerWhiteId
  );
  return result.lastInsertRowid;
}

async function doPair(userA, userB, sockA, sockB) {
  let blackId, whiteId;
  if (Math.random() < 0.5) {
    blackId = userA.userId || userA.id;
    whiteId = userB.userId || userB.id;
  } else {
    blackId = userB.userId || userB.id;
    whiteId = userA.userId || userA.id;
  }
  const gameId = await createGame(blackId, whiteId);

  const blackUser = await db.get('SELECT id, username FROM users WHERE id = ?', blackId);
  const whiteUser = await db.get('SELECT id, username FROM users WHERE id = ?', whiteId);

  const s1 = getSocketByUserId(blackId);
  const s2 = getSocketByUserId(whiteId);
  if (!s1 || !s2) {
    console.log(`[doPair] socket missing after pair: black=${!!s1} white=${!!s2}, abort game=${gameId}`);
    try {
      await db.run(`UPDATE games SET status = 'finished', finished_at = CURRENT_TIMESTAMP WHERE id = ?`, gameId);
    } catch (_) {}
    const survivorId = s1 ? blackId : s2 ? whiteId : null;
    if (survivorId) {
      const survivorUser = await db.get('SELECT id, username FROM users WHERE id = ?', survivorId);
      const survivorSock = getSocketByUserId(survivorId);
      if (survivorUser && survivorSock) {
        waitingQueue.push({ userId: survivorUser.id, username: survivorUser.username, socketId: survivorSock.id });
        survivorSock.emit('match_waiting');
      }
    }
    return false;
  }
  s1.emit('match_success', {
    gameId,
    color: 'black',
    opponent: { id: whiteUser.id, username: whiteUser.username },
  });
  s2.emit('match_success', {
    gameId,
    color: 'white',
    opponent: { id: blackUser.id, username: blackUser.username },
  });
  console.log(`[doPair] matched: black=${blackId}(${blackUser.username}) white=${whiteId}(${whiteUser.username}) game=${gameId}`);
  return true;
}

async function tryMatch(socket, user) {
  const existing = waitingQueue.find((p) => p.userId === user.id);
  if (existing) {
    existing.socketId = socket.id;
    existing.username = user.username;
    console.log(`[tryMatch] user=${user.id} already in queue, updated socketId`);
    for (let i = 0; i < waitingQueue.length; i++) {
      const w = waitingQueue[i];
      if (w.userId === user.id) continue;
      const wSock = global.__io?.sockets.sockets.get(w.socketId);
      if (!wSock) {
        waitingQueue.splice(i, 1);
        i--;
        continue;
      }
      waitingQueue.splice(i, 1);
      const myIdx = waitingQueue.findIndex((p) => p.userId === user.id);
      if (myIdx >= 0) waitingQueue.splice(myIdx, 1);
      await doPair(user, w, socket, wSock);
      return;
    }
    socket.emit('match_waiting', { message: '已在等待队列中' });
    return;
  }

  for (let i = 0; i < waitingQueue.length; i++) {
    const w = waitingQueue[i];
    if (w.userId === user.id) continue;
    const wSock = global.__io?.sockets.sockets.get(w.socketId);
    if (!wSock) {
      waitingQueue.splice(i, 1);
      i--;
      continue;
    }
    waitingQueue.splice(i, 1);
    await doPair(user, w, socket, wSock);
    return;
  }

  waitingQueue.push({ userId: user.id, username: user.username, socketId: socket.id });
  socket.emit('match_waiting');
}

function cancelMatch(userId) {
  for (let i = waitingQueue.length - 1; i >= 0; i--) {
    if (waitingQueue[i].userId === userId) {
      waitingQueue.splice(i, 1);
    }
  }
}

function waitingQueueSize() {
  return waitingQueue.length;
}

function isInQueue(userId) {
  return waitingQueue.some((p) => p.userId === userId);
}

const joinedGames = new Set();

async function markUserJoinedGame(gameId, userId) {
  joinedGames.add(`${gameId}:${userId}`);
  const game = await getGame(gameId);
  if (game) gameCache.set(gameId, game);
  if (game && joinedGames.has(`${gameId}:${game.player_black_id}`) && joinedGames.has(`${gameId}:${game.player_white_id}`)) {
    const black = getSocketByUserId(game.player_black_id);
    const white = getSocketByUserId(game.player_white_id);
    const payload = { gameId, bothReady: true };
    if (black) black.emit('game_ready', payload);
    if (white) white.emit('game_ready', payload);
    setTimeout(() => startTurnTimer(gameId), 100);
  }
}

function hasUserJoinedGame(gameId, userId) {
  return joinedGames.has(`${gameId}:${userId}`);
}

function cleanupJoinedGame(gameId) {
  for (const k of Array.from(joinedGames.keys())) {
    if (k.startsWith(`${gameId}:`)) joinedGames.delete(k);
  }
}

async function makeMove(socket, user, { gameId, x, y }) {
  const game = await getGame(gameId);
  if (!game) {
    socket.emit('error', { message: '对局不存在' });
    return;
  }
  gameCache.set(gameId, game);
  if (game.status !== 'playing') {
    socket.emit('error', { message: '对局已结束' });
    return;
  }
  const color = getPlayerColor(game, user.id);
  if (!color) {
    socket.emit('error', { message: '你不是本局玩家' });
    return;
  }
  if (game.current_turn !== color) {
    socket.emit('error', { message: '还没轮到你' });
    return;
  }
  if (typeof x !== 'number' || typeof y !== 'number') {
    socket.emit('error', { message: '坐标无效' });
    return;
  }
  if (x < 0 || x >= BOARD_SIZE || y < 0 || y >= BOARD_SIZE) {
    socket.emit('error', { message: '坐标超出范围' });
    return;
  }
  if (game.board_state.some((m) => m.x === x && m.y === y)) {
    socket.emit('error', { message: '该位置已有棋子' });
    return;
  }

  const newBoardState = [...game.board_state, { x, y, player: color }];
  const newMoveHistory = [
    ...game.move_history,
    { player: color, x, y, timestamp: new Date().toISOString() },
  ];
  const nextTurn = color === 'black' ? 'white' : 'black';

  const board2d = buildBoard(newBoardState);
  const isWin = checkWin(board2d, x, y, color);

  if (isWin) {
    await db.run(
      `UPDATE games SET board_state = ?, move_history = ?, current_turn = ?, status = 'finished', winner_id = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?`,
      JSON.stringify(newBoardState), JSON.stringify(newMoveHistory), nextTurn, user.id, gameId
    );
  } else {
    await db.run(
      `UPDATE games SET board_state = ?, move_history = ?, current_turn = ? WHERE id = ?`,
      JSON.stringify(newBoardState), JSON.stringify(newMoveHistory), nextTurn, gameId
    );
  }

  const opponentId = getOpponentId(game, user.id);
  const s1 = getSocketByUserId(user.id);
  const s2 = getSocketByUserId(opponentId);

  const movePayload = { x, y, player: color };
  if (s1) s1.emit('opponent_move', { ...movePayload, byMe: true });
  if (s2) s2.emit('opponent_move', { ...movePayload, byMe: false });

  if (isWin) {
    clearTurnTimer(gameId);
    const reason = 'five_in_row';
    if (s1) s1.emit('game_over', { winner: user.id, winnerUsername: user.username, reason });
    if (s2) s2.emit('game_over', { winner: user.id, winnerUsername: user.username, reason });
  } else {
    setTimeout(() => startTurnTimer(gameId), 100);
  }
}

async function requestUndo(socket, user, { gameId }) {
  const game = await getGame(gameId);
  if (!game) { socket.emit('error', { message: '对局不存在' }); return; }
  gameCache.set(gameId, game);
  if (game.status !== 'playing') { socket.emit('error', { message: '对局已结束' }); return; }
  const color = getPlayerColor(game, user.id);
  if (!color) { socket.emit('error', { message: '你不是本局玩家' }); return; }
  const remaining = color === 'black' ? game.undo_count_black : game.undo_count_white;
  if (remaining <= 0) { socket.emit('error', { message: '悔棋次数已用完' }); return; }
  if (game.board_state.length === 0) { socket.emit('error', { message: '当前没有可悔棋的步骤' }); return; }
  const opponentId = getOpponentId(game, user.id);
  const s2 = getSocketByUserId(opponentId);
  if (s2) {
    s2.emit('undo_requested', { gameId, from: user.id, fromUsername: user.username });
  } else {
    socket.emit('error', { message: '对手不在线，无法悔棋' });
  }
}

async function undoResponse(socket, user, { gameId, accepted }) {
  const game = await getGame(gameId);
  if (!game) { socket.emit('error', { message: '对局不存在' }); return; }
  gameCache.set(gameId, game);
  if (game.status !== 'playing') { socket.emit('error', { message: '对局已结束' }); return; }
  const color = getPlayerColor(game, user.id);
  if (!color) { socket.emit('error', { message: '你不是本局玩家' }); return; }
  const opponentId = getOpponentId(game, user.id);
  const requesterId = opponentId;

  const requester = await db.get('SELECT * FROM users WHERE id = ?', requesterId);
  if (!requester) { socket.emit('error', { message: '请求方不存在' }); return; }
  const requesterColor = getPlayerColor(game, requesterId);
  if (!requesterColor) { socket.emit('error', { message: '请求方非本局玩家' }); return; }
  const remaining = requesterColor === 'black' ? game.undo_count_black : game.undo_count_white;
  if (remaining <= 0) { socket.emit('error', { message: '请求方悔棋次数已用完' }); return; }
  if (game.board_state.length === 0) { socket.emit('error', { message: '没有可悔棋步骤' }); return; }

  const lastMove = game.board_state[game.board_state.length - 1];
  const lastMovePlayer = lastMove.player;

  if (accepted) {
    const newBoardState = game.board_state.slice(0, -1);
    const newMoveHistory = game.move_history.slice(0, -1);
    const newTurn = lastMovePlayer;
    const newRemaining = remaining - 1;

    if (requesterColor === 'black') {
      await db.run(
        `UPDATE games SET board_state = ?, move_history = ?, current_turn = ?, undo_count_black = ? WHERE id = ?`,
        JSON.stringify(newBoardState), JSON.stringify(newMoveHistory), newTurn, newRemaining, gameId
      );
    } else {
      await db.run(
        `UPDATE games SET board_state = ?, move_history = ?, current_turn = ?, undo_count_white = ? WHERE id = ?`,
        JSON.stringify(newBoardState), JSON.stringify(newMoveHistory), newTurn, newRemaining, gameId
      );
    }

    const s1 = getSocketByUserId(requesterId);
    const s2 = socket;
    const removed = lastMove;
    if (s1) s1.emit('undo_result', { accepted: true, moveRemoved: removed });
    if (s2) s2.emit('undo_result', { accepted: true, moveRemoved: removed });
  } else {
    const s1 = getSocketByUserId(requesterId);
    const s2 = socket;
    if (s1) s1.emit('undo_result', { accepted: false, moveRemoved: null });
    if (s2) s2.emit('undo_result', { accepted: false, moveRemoved: null });
  }
}

async function resign(socket, user, { gameId }) {
  const game = await getGame(gameId);
  if (!game) { socket.emit('error', { message: '对局不存在' }); return; }
  if (game.status !== 'playing') { socket.emit('error', { message: '对局已结束' }); return; }
  const color = getPlayerColor(game, user.id);
  if (!color) { socket.emit('error', { message: '你不是本局玩家' }); return; }
  const opponentId = getOpponentId(game, user.id);

  await db.run(
    `UPDATE games SET status = 'finished', winner_id = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?`,
    opponentId, gameId
  );

  const s1 = socket;
  const s2 = getSocketByUserId(opponentId);
  clearTurnTimer(gameId);
  if (s1) s1.emit('game_over', { winner: opponentId, reason: 'resign' });
  if (s2) s2.emit('game_over', { winner: opponentId, reason: 'resign' });
}

async function exitGame(socket, user, { gameId }) {
  const game = await getGame(gameId);
  if (!game) { socket.emit('error', { message: '对局不存在' }); return; }
  if (game.status !== 'playing') { socket.emit('error', { message: '对局已结束' }); return; }
  const color = getPlayerColor(game, user.id);
  if (!color) { socket.emit('error', { message: '你不是本局玩家' }); return; }
  const opponentId = getOpponentId(game, user.id);
  if (!opponentId) { socket.emit('error', { message: '未找到对手' }); return; }
  await db.run(
    `UPDATE games SET status = 'finished', winner_id = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?`,
    opponentId, gameId
  );
  const s1 = socket;
  const s2 = getSocketByUserId(opponentId);
  clearTurnTimer(gameId);
  if (s1) s1.emit('game_over', { winner: opponentId, reason: 'exit' });
  if (s2) s2.emit('game_over', { winner: opponentId, reason: 'exit', exitBy: user.id, exitByUsername: user.username });
}

// ===== 再来一局 =====
const pendingRematch = new Map();
const REMATCH_TIMEOUT_MS = 10 * 1000;
function rematchKey(a, b) { return a < b ? `${a}:${b}` : `${b}:${a}`; }

async function requestRematch(socket, user, { gameId }) {
  const game = await getGame(gameId);
  if (!game) { socket.emit('error', { message: '对局不存在' }); return; }
  gameCache.set(gameId, game);
  if (game.status !== 'finished') { socket.emit('error', { message: '对局尚未结束' }); return; }
  if (game.player_black_id !== user.id && game.player_white_id !== user.id) {
    socket.emit('error', { message: '你不是本局玩家' });
    return;
  }
  const opponentId = getOpponentId(game, user.id);
  if (!opponentId) { socket.emit('error', { message: '未找到对手' }); return; }
  const key = rematchKey(user.id, opponentId);
  if (pendingRematch.has(key)) { socket.emit('error', { message: '已有再来一局请求进行中' }); return; }

  const timer = setTimeout(() => {
    const v = pendingRematch.get(key);
    if (!v) return;
    pendingRematch.delete(key);
    const fromSock = getSocketByUserId(v.fromId);
    const toSock = getSocketByUserId(v.toId);
    if (fromSock) fromSock.emit('rematch_timeout', { byUserId: v.toId, byUsername: '对方', seconds: REMATCH_TIMEOUT_MS / 1000 });
    if (toSock) toSock.emit('rematch_timeout', { byUserId: v.toId, byUsername: '对方', seconds: REMATCH_TIMEOUT_MS / 1000 });
    console.log(`[rematch] timeout from=${v.fromId} to=${v.toId}`);
  }, REMATCH_TIMEOUT_MS);

  pendingRematch.set(key, { fromId: user.id, toId: opponentId, gameId, createdAt: Date.now(), timer });

  const target = getSocketByUserId(opponentId);
  console.log(`[rematch] request from=${user.id} to=${opponentId} target=${!!target} gameStatus=${game.status}`);
  if (target) {
    target.emit('rematch_requested', { fromId: user.id, fromUsername: user.username, gameId, timeoutSeconds: REMATCH_TIMEOUT_MS / 1000 });
    console.log(`[rematch] sent rematch_requested to user=${opponentId}`);
  } else {
    console.log(`[rematch] target offline, user=${opponentId}`);
    socket.emit('error', { message: '对方不在线，无法发起再来一局' });
    clearTimeout(timer);
    pendingRematch.delete(key);
    return;
  }
  socket.emit('rematch_sent', { toId: opponentId, gameId, timeoutSeconds: REMATCH_TIMEOUT_MS / 1000 });
}

async function respondRematch(socket, user, { fromUserId, accept, gameId }) {
  const fromId = parseInt(fromUserId, 10);
  if (!fromId) return;
  const key = rematchKey(fromId, user.id);
  const v = pendingRematch.get(key);
  if (!v) { socket.emit('error', { message: '再来一局请求已失效' }); return; }
  pendingRematch.delete(key);
  if (v.timer) clearTimeout(v.timer);

  const fromSock = getSocketByUserId(fromId);
  if (!accept) {
    if (fromSock) fromSock.emit('rematch_declined', { byUserId: user.id, byUsername: user.username });
    return;
  }
  cancelMatch(fromId);
  cancelMatch(user.id);
  if (!fromSock) { socket.emit('error', { message: '对方已离线，无法开始新对局' }); return; }
  if (!socket) { if (fromSock) fromSock.emit('error', { message: '对方已离线，无法开始新对局' }); return; }

  let blackId, whiteId;
  if (Math.random() < 0.5) { blackId = fromId; whiteId = user.id; }
  else { blackId = user.id; whiteId = fromId; }
  const newGameId = await createGame(blackId, whiteId);
  const blackUser = await db.get('SELECT id, username FROM users WHERE id = ?', blackId);
  const whiteUser = await db.get('SELECT id, username FROM users WHERE id = ?', whiteId);
  fromSock.emit('match_success', {
    gameId: newGameId,
    color: blackId === fromId ? 'black' : 'white',
    opponent: { id: user.id, username: user.username },
    via: 'rematch',
  });
  socket.emit('match_success', {
    gameId: newGameId,
    color: blackId === user.id ? 'black' : 'white',
    opponent: { id: fromId, username: blackId === fromId ? blackUser.username : whiteUser.username },
    via: 'rematch',
  });
}

// ========== 好友邀请对弈 ==========

async function inviteToGame(socket, user, { toUserId }) {
  const toId = parseInt(toUserId, 10);
  if (!toId || toId === user.id) { socket.emit('error', { message: '邀请对象无效' }); return; }
  cancelMatch(user.id);
  const key = inviteKey(user.id, toId);
  pendingInvites.set(key, { fromId: user.id, toId, createdAt: Date.now() });

  const targetSock = getSocketByUserId(toId);
  if (!targetSock) {
    socket.emit('error', { message: '对方不在线，邀请已发送，待对方上线后可接受' });
    return;
  }
  const fromCodeRow = await db.get('SELECT friend_code FROM users WHERE id = ?', user.id);
  targetSock.emit('invite_received', {
    fromId: user.id,
    fromUsername: user.username,
    fromCode: fromCodeRow?.friend_code,
  });
  socket.emit('invite_sent', { toId });
}

function cancelInvite(socket, user, { toUserId }) {
  const toId = parseInt(toUserId, 10);
  const key = inviteKey(user.id, toId);
  const v = pendingInvites.get(key);
  if (v && v.fromId === user.id) {
    pendingInvites.delete(key);
    const target = getSocketByUserId(toId);
    if (target) target.emit('invite_cancelled', { reason: 'cancelled' });
  }
}

async function respondInvite(socket, user, { fromUserId, accept }) {
  const fromId = parseInt(fromUserId, 10);
  if (!fromId) return;
  const key = inviteKey(fromId, user.id);
  const v = pendingInvites.get(key);
  if (!v) { socket.emit('error', { message: '邀请已失效' }); return; }
  pendingInvites.delete(key);

  const fromSock = getSocketByUserId(fromId);
  if (accept) {
    cancelMatch(fromId);
    cancelMatch(user.id);
    if (!fromSock) { socket.emit('error', { message: '对方已离线，无法开始新对局' }); return; }
    let blackId, whiteId;
    if (Math.random() < 0.5) { blackId = fromId; whiteId = user.id; }
    else { blackId = user.id; whiteId = fromId; }
    const gameId = await createGame(blackId, whiteId);
    const blackUser = await db.get('SELECT id, username FROM users WHERE id = ?', blackId);
    const whiteUser = await db.get('SELECT id, username FROM users WHERE id = ?', whiteId);
    fromSock.emit('match_success', {
      gameId,
      color: blackId === fromId ? 'black' : 'white',
      opponent: { id: user.id, username: user.username },
      via: 'invite',
    });
    socket.emit('match_success', {
      gameId,
      color: blackId === user.id ? 'black' : 'white',
      opponent: { id: fromId, username: blackId === fromId ? blackUser.username : whiteUser.username },
      via: 'invite',
    });
  } else {
    if (fromSock) fromSock.emit('invite_declined', { byUserId: user.id, byUsername: user.username });
  }
}

// === 聊天与表情 ===
async function getUserActiveGame(userId) {
  const row = await db.get(
    `SELECT id FROM games WHERE (player_black_id = ? OR player_white_id = ?) AND status = 'playing'`,
    userId, userId
  );
  return row || null;
}

async function sendChatMessage(socket, user, { gameId, text }) {
  if (!text || typeof text !== 'string' || !text.trim()) {
    socket.emit('error', { message: '消息不能为空' });
    return;
  }
  const g = await getGame(gameId || 0);
  if (!g) { socket.emit('error', { message: '对局不存在' }); return; }
  if (g.status !== 'playing') { socket.emit('error', { message: '对局已结束' }); return; }
  const oppId = getOpponentId(g, user.id);
  if (!oppId) { socket.emit('error', { message: '未找到对手' }); return; }
  const msg = {
    fromId: user.id,
    fromUsername: user.username,
    text: text.trim().slice(0, 200),
    time: Date.now(),
  };
  // 发送给自己
  socket.emit('chat_message', msg);
  // 发送给对手
  const oppSock = getSocketByUserId(oppId);
  if (oppSock) oppSock.emit('chat_message', msg);
}

async function sendEmojiReaction(socket, user, { gameId, emoji }) {
  if (!emoji || typeof emoji !== 'string') {
    socket.emit('error', { message: '表情无效' });
    return;
  }
  const g = await getGame(gameId || 0);
  if (!g) { socket.emit('error', { message: '对局不存在' }); return; }
  if (g.status !== 'playing') { socket.emit('error', { message: '对局已结束' }); return; }
  const oppId = getOpponentId(g, user.id);
  if (!oppId) { socket.emit('error', { message: '未找到对手' }); return; }
  const payload = {
    fromId: user.id,
    fromUsername: user.username,
    emoji: emoji.slice(0, 10),
    time: Date.now(),
  };
  socket.emit('emoji_reaction', payload);
  const oppSock = getSocketByUserId(oppId);
  if (oppSock) oppSock.emit('emoji_reaction', payload);
}

module.exports = {
  BOARD_SIZE,
  registerSocket,
  unregisterSocket,
  tryMatch,
  cancelMatch,
  waitingQueueSize,
  isInQueue,
  markUserJoinedGame,
  hasUserJoinedGame,
  cleanupJoinedGame,
  makeMove,
  requestUndo,
  undoResponse,
  resign,
  exitGame,
  requestRematch,
  respondRematch,
  inviteToGame,
  cancelInvite,
  respondInvite,
  getGame,
  buildBoard,
  checkWin,
  sendChatMessage,
  sendEmojiReaction,
};