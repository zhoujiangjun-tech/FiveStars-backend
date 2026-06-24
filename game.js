// 游戏核心逻辑：匹配、落子、胜负判定、悔棋、认输、好友邀请
const db = require('./db');

const BOARD_SIZE = 15;

// 内存中的等待队列：[{ userId, username, socketId }]
const waitingQueue = [];

// 每局思考计时器：gameId -> { timerHandle, currentColor, timeoutCount: { black, white } }
const turnTimers = new Map();

const TURN_SECONDS = 90;
const MAX_TIMEOUTS = 2; // 超时 2 次则判负

function clearTurnTimer(gameId) {
  const t = turnTimers.get(gameId);
  if (t && t.timerHandle) {
    clearTimeout(t.timerHandle);
  }
  turnTimers.delete(gameId);
}

// 启动(或重置)当前回合的思考计时器
function startTurnTimer(gameId) {
  clearTurnTimer(gameId);
  const game = getGame(gameId);
  if (!game || game.status !== 'playing') return;
  const color = game.current_turn;
  const state = turnTimers.get(gameId) || { timeoutCount: { black: 0, white: 0 } };
  state.currentColor = color;
  const handle = setTimeout(() => onTurnTimeout(gameId), TURN_SECONDS * 1000);
  state.timerHandle = handle;
  turnTimers.set(gameId, state);
  // 推送给双方当前剩余时间，便于前端倒计时
  const blackSock = getSocketByUserId(game.player_black_id);
  const whiteSock = getSocketByUserId(game.player_white_id);
  const payload = { gameId, turnSeconds: TURN_SECONDS, color };
  if (blackSock) blackSock.emit('turn_started', payload);
  if (whiteSock) whiteSock.emit('turn_started', payload);
}

function onTurnTimeout(gameId) {
  const game = getGame(gameId);
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
    // 超时 2 次，判当前玩家负
    clearTurnTimer(gameId);
    const winnerId = color === 'black' ? game.player_white_id : game.player_black_id;
    db.prepare(
      `UPDATE games SET status = 'finished', winner_id = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(winnerId, gameId);
    const winnerUser = db.prepare('SELECT id, username FROM users WHERE id = ?').get(winnerId);
    const reason = 'timeout_2x';
    const blackSock = getSocketByUserId(game.player_black_id);
    const whiteSock = getSocketByUserId(game.player_white_id);
    const payload = { winner: winnerId, winnerUsername: winnerUser?.username || '', reason, loser: color };
    if (blackSock) blackSock.emit('game_over', payload);
    if (whiteSock) whiteSock.emit('game_over', payload);
  } else {
    // 第 1 次超时：提示并重新计时
    const cur = getSocketByUserId(color === 'black' ? game.player_black_id : game.player_white_id);
    if (cur) {
      cur.emit('turn_timeout', { gameId, color, count, remaining: MAX_TIMEOUTS - count, seconds: TURN_SECONDS });
    }
    // 重新计时
    startTurnTimer(gameId);
  }
}

// 待响应的邀请：key = "fromId:toId"，value = { fromId, toId, createdAt }
// 双方任意一端离线或响应（accept/decline）后即清理
const pendingInvites = new Map();

function inviteKey(a, b) { return a < b ? `${a}:${b}` : `${b}:${a}`; }

// 内存中 socketId -> userId 的映射
const socketUserMap = new Map();

// 在线 socket 映射：userId -> Set<socketId>（支持多端/多标签登录）
const userSocketMap = new Map();

function registerSocket(socket, user) {
  socketUserMap.set(socket.id, user.id);
  if (!userSocketMap.has(user.id)) userSocketMap.set(user.id, new Set());
  userSocketMap.get(user.id).add(socket.id);
}

function unregisterSocket(socket) {
  const userId = socketUserMap.get(socket.id);
  socketUserMap.delete(socket.id);
  // 优先从 userSocketMap 中移除当前 socket,然后判断用户是否还有别的连接
  if (userId) {
    const set = userSocketMap.get(userId);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) userSocketMap.delete(userId);
    }
  }
  // 从等待队列中移除该 socket(仅这一条,不影响其他连接的用户)
  for (let i = waitingQueue.length - 1; i >= 0; i--) {
    if (waitingQueue[i].socketId === socket.id) {
      waitingQueue.splice(i, 1);
    }
  }
  // 关键:用户还有别的连接(多端/重连中)就视为仍然在线,不要通知对手
  // 也不要清理/取消任何 pending 邀请/悔棋请求,否则会出现误报
  if (userId && isUserOnline(userId)) {
    console.log(`[unregisterSocket] user=${userId} still has other connection, skip opponent notify`);
    return;
  }
  // 用户真正下线时,先清理掉 ta 作为接收方的邀请和再来一局,并通知发起方
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
  // 用户真正下线时,通知对局中的对手(但只通知"已经进入对局"的用户,否则会误报)
  if (userId) {
    try {
      const rows = db.prepare(
        `SELECT id, player_black_id, player_white_id, status FROM games
         WHERE status = 'playing' AND (player_black_id = ? OR player_white_id = ?)`
      ).all(userId, userId);
      for (const g of rows) {
        // 关键:断线用户必须自己已经进入过对局,才会去通知对手
        // 否则会出现"对手收到 match_success 但根本没进棋盘 -> 短时断线 -> 自己被通知'对手已离开'"的 bug
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
  // 取任意一个有效的 socket
  for (const sid of set) {
    const s = global.__io?.sockets.sockets.get(sid);
    if (s) return s;
  }
  return null;
}

// 用户当前是否至少有一个有效连接
function isUserOnline(userId) {
  const set = userSocketMap.get(userId);
  if (!set || set.size === 0) return false;
  for (const sid of set) {
    if (global.__io?.sockets.sockets.get(sid)) return true;
  }
  return false;
}

// 落子后判断是否五连
function checkWin(board, x, y, player) {
  const directions = [
    [1, 0],   // 垂直
    [0, 1],   // 水平
    [1, 1],   // 正斜
    [1, -1],  // 反斜
  ];
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

// 从 board_state（move 列表）重建棋盘二维数组
function buildBoard(boardState) {
  const board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
  for (const m of boardState) {
    board[m.x][m.y] = m.player;
  }
  return board;
}

function getGame(gameId) {
  const row = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
  if (!row) return null;
  return {
    ...row,
    board_state: JSON.parse(row.board_state),
    move_history: JSON.parse(row.move_history),
  };
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

// 创建新对局
function createGame(playerBlackId, playerWhiteId) {
  const result = db
    .prepare(
      `INSERT INTO games (player_black_id, player_white_id, board_state, move_history, current_turn, status)
       VALUES (?, ?, '[]', '[]', 'black', 'playing')`
    )
    .run(playerBlackId, playerWhiteId);
  return result.lastInsertRowid;
}

// 匹配：把请求者加入队列，若有等待者则配对
function tryMatch(socket, user) {
  // 如果已经在队列里，忽略
  const inQueue = waitingQueue.find((p) => p.userId === user.id);
  if (inQueue) {
    socket.emit('match_waiting', { message: '已在等待队列中' });
    return;
  }

  // 找一个不是自己的等待者，且其 socket 仍然有效
  for (let i = 0; i < waitingQueue.length; i++) {
    const w = waitingQueue[i];
    if (w.userId === user.id) continue;
    // 关键:等待者可能已经断线,跳过陈旧条目
    const wSock = global.__io?.sockets.sockets.get(w.socketId);
    if (!wSock) {
      waitingQueue.splice(i, 1);
      i--; // 索引前移
      continue;
    }
    // 配对成功
    waitingQueue.splice(i, 1);
    // 随机分配黑白
    let blackId, whiteId;
    if (Math.random() < 0.5) {
      blackId = user.id;
      whiteId = w.userId;
    } else {
      blackId = w.userId;
      whiteId = user.id;
    }
    const gameId = createGame(blackId, whiteId);

    const blackUser = db.prepare('SELECT id, username FROM users WHERE id = ?').get(blackId);
    const whiteUser = db.prepare('SELECT id, username FROM users WHERE id = ?').get(whiteId);

    // 再次确认两边 socket 都还在(配对过程中可能刚断)
    const s1 = getSocketByUserId(blackId);
    const s2 = getSocketByUserId(whiteId);
    if (!s1 || !s2) {
      console.log(`[tryMatch] socket missing after pair: black=${!!s1} white=${!!s2}, abort game=${gameId}`);
      // 撤销刚创建的对局（标记为取消）
      try {
        db.prepare(`UPDATE games SET status = 'finished', finished_at = CURRENT_TIMESTAMP WHERE id = ?`).run(gameId);
      } catch (_) {}
      // 找到仍然在线的那位，重新放回队列
      const survivorId = s1 ? blackId : s2 ? whiteId : null;
      if (survivorId) {
        const survivorUser = db.prepare('SELECT id, username FROM users WHERE id = ?').get(survivorId);
        const survivorSock = getSocketByUserId(survivorId);
        if (survivorUser && survivorSock) {
          waitingQueue.push({ userId: survivorUser.id, username: survivorUser.username, socketId: survivorSock.id });
          survivorSock.emit('match_waiting');
        }
      }
      return;
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
    // 启动黑方思考计时器
    setTimeout(() => startTurnTimer(gameId), 200);
    return;
  }

  // 没有等待者，加入队列
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

// 进入对局确认:防止"对手收到 match_success 但根本没进棋盘"导致 unregisterSocket 误判对手离线
// 用一个 Set 记录"已经进入对局屏幕"的用户,只有当 userId 真正进入过对局,
// 后续这个 user 断线才会被算作"比赛中离线"去通知对手
const joinedGames = new Set(); // 元素为 `${gameId}:${userId}`

function markUserJoinedGame(gameId, userId) {
  joinedGames.add(`${gameId}:${userId}`);
  // 双方都进入 -> 真正开始计时
  const game = getGame(gameId);
  if (game && joinedGames.has(`${gameId}:${game.player_black_id}`) && joinedGames.has(`${gameId}:${game.player_white_id}`)) {
    const black = getSocketByUserId(game.player_black_id);
    const white = getSocketByUserId(game.player_white_id);
    const payload = { gameId, bothReady: true };
    if (black) black.emit('game_ready', payload);
    if (white) white.emit('game_ready', payload);
    // 启动第一个回合计时器
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

// 落子
function makeMove(socket, user, { gameId, x, y }) {
  const game = getGame(gameId);
  if (!game) {
    socket.emit('error', { message: '对局不存在' });
    return;
  }
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

  // 构造新的 board_state
  const newBoardState = [...game.board_state, { x, y, player: color }];
  const newMoveHistory = [
    ...game.move_history,
    { player: color, x, y, timestamp: new Date().toISOString() },
  ];
  const nextTurn = color === 'black' ? 'white' : 'black';

  // 胜负判定
  const board2d = buildBoard(newBoardState);
  const isWin = checkWin(board2d, x, y, color);

  if (isWin) {
    db.prepare(
      `UPDATE games SET board_state = ?, move_history = ?, current_turn = ?, status = 'finished', winner_id = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(JSON.stringify(newBoardState), JSON.stringify(newMoveHistory), nextTurn, user.id, gameId);
  } else {
    db.prepare(
      `UPDATE games SET board_state = ?, move_history = ?, current_turn = ? WHERE id = ?`
    ).run(JSON.stringify(newBoardState), JSON.stringify(newMoveHistory), nextTurn, gameId);
  }

  // 通知双方
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
    // 切换到下一回合，启动新计时器
    setTimeout(() => startTurnTimer(gameId), 100);
  }
}

// 悔棋请求
function requestUndo(socket, user, { gameId }) {
  const game = getGame(gameId);
  if (!game) {
    socket.emit('error', { message: '对局不存在' });
    return;
  }
  if (game.status !== 'playing') {
    socket.emit('error', { message: '对局已结束' });
    return;
  }
  const color = getPlayerColor(game, user.id);
  if (!color) {
    socket.emit('error', { message: '你不是本局玩家' });
    return;
  }
  // 悔棋次数检查
  const remaining =
    color === 'black' ? game.undo_count_black : game.undo_count_white;
  if (remaining <= 0) {
    socket.emit('error', { message: '悔棋次数已用完' });
    return;
  }
  if (game.board_state.length === 0) {
    socket.emit('error', { message: '当前没有可悔棋的步骤' });
    return;
  }
  // 只能悔自己最后一步，或者请求对方同意由对方撤回最后一步
  // 按需求："请求方必须还有悔棋次数，对手同意后回退一步，扣除次数"
  // 简化：撤回最后一步（无论是谁的），把回合切回最后一步的落子者
  const opponentId = getOpponentId(game, user.id);
  const s2 = getSocketByUserId(opponentId);
  if (s2) {
    s2.emit('undo_requested', { gameId, from: user.id, fromUsername: user.username });
  } else {
    socket.emit('error', { message: '对手不在线，无法悔棋' });
  }
}

// 悔棋响应
function undoResponse(socket, user, { gameId, accepted }) {
  const game = getGame(gameId);
  if (!game) {
    socket.emit('error', { message: '对局不存在' });
    return;
  }
  if (game.status !== 'playing') {
    socket.emit('error', { message: '对局已结束' });
    return;
  }
  const color = getPlayerColor(game, user.id);
  if (!color) {
    socket.emit('error', { message: '你不是本局玩家' });
    return;
  }
  // 找到请求方（另一位）
  const opponentId = getOpponentId(game, user.id);
  const requesterId = opponentId;

  const requester = db.prepare('SELECT * FROM users WHERE id = ?').get(requesterId);
  if (!requester) {
    socket.emit('error', { message: '请求方不存在' });
    return;
  }
  const requesterColor = getPlayerColor(game, requesterId);
  if (!requesterColor) {
    socket.emit('error', { message: '请求方非本局玩家' });
    return;
  }
  const remaining =
    requesterColor === 'black' ? game.undo_count_black : game.undo_count_white;
  if (remaining <= 0) {
    socket.emit('error', { message: '请求方悔棋次数已用完' });
    return;
  }
  if (game.board_state.length === 0) {
    socket.emit('error', { message: '没有可悔棋步骤' });
    return;
  }

  const lastMove = game.board_state[game.board_state.length - 1];
  const lastMovePlayer = lastMove.player;

  if (accepted) {
    // 移除最后一步，恢复回合
    const newBoardState = game.board_state.slice(0, -1);
    const newMoveHistory = game.move_history.slice(0, -1);
    const newTurn = lastMovePlayer; // 回合切回最后一步的落子者
    const newRemaining = remaining - 1;

    if (requesterColor === 'black') {
      db.prepare(
        `UPDATE games SET board_state = ?, move_history = ?, current_turn = ?, undo_count_black = ? WHERE id = ?`
      ).run(JSON.stringify(newBoardState), JSON.stringify(newMoveHistory), newTurn, newRemaining, gameId);
    } else {
      db.prepare(
        `UPDATE games SET board_state = ?, move_history = ?, current_turn = ?, undo_count_white = ? WHERE id = ?`
      ).run(JSON.stringify(newBoardState), JSON.stringify(newMoveHistory), newTurn, newRemaining, gameId);
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

// 认输
function resign(socket, user, { gameId }) {
  const game = getGame(gameId);
  if (!game) {
    socket.emit('error', { message: '对局不存在' });
    return;
  }
  if (game.status !== 'playing') {
    socket.emit('error', { message: '对局已结束' });
    return;
  }
  const color = getPlayerColor(game, user.id);
  if (!color) {
    socket.emit('error', { message: '你不是本局玩家' });
    return;
  }
  const opponentId = getOpponentId(game, user.id);

  db.prepare(
    `UPDATE games SET status = 'finished', winner_id = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(opponentId, gameId);

  const s1 = socket;
  const s2 = getSocketByUserId(opponentId);
  clearTurnTimer(gameId);
  if (s1) s1.emit('game_over', { winner: opponentId, reason: 'resign' });
  if (s2) s2.emit('game_over', { winner: opponentId, reason: 'resign' });
}

// 退出对局（对局中）：等同于认输
function exitGame(socket, user, { gameId }) {
  const game = getGame(gameId);
  if (!game) {
    socket.emit('error', { message: '对局不存在' });
    return;
  }
  if (game.status !== 'playing') {
    socket.emit('error', { message: '对局已结束' });
    return;
  }
  const color = getPlayerColor(game, user.id);
  if (!color) {
    socket.emit('error', { message: '你不是本局玩家' });
    return;
  }
  const opponentId = getOpponentId(game, user.id);
  if (!opponentId) {
    socket.emit('error', { message: '未找到对手' });
    return;
  }
  db.prepare(
    `UPDATE games SET status = 'finished', winner_id = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(opponentId, gameId);
  const s1 = socket;
  const s2 = getSocketByUserId(opponentId);
  clearTurnTimer(gameId);
  if (s1) s1.emit('game_over', { winner: opponentId, reason: 'exit' });
  if (s2) s2.emit('game_over', { winner: opponentId, reason: 'exit', exitBy: user.id, exitByUsername: user.username });
}

// ===== 再来一局 =====
// pending rematch: key = "a:b" (a<b), value = { fromId, toId, gameId, createdAt, timer }
const pendingRematch = new Map();
const REMATCH_TIMEOUT_MS = 10 * 1000; // 10 秒未响应自动拒绝
function rematchKey(a, b) { return a < b ? `${a}:${b}` : `${b}:${a}`; }

// 发起再来一局
function requestRematch(socket, user, { gameId }) {
  const game = getGame(gameId);
  if (!game) {
    socket.emit('error', { message: '对局不存在' });
    return;
  }
  if (game.status !== 'finished') {
    socket.emit('error', { message: '对局尚未结束' });
    return;
  }
  if (game.player_black_id !== user.id && game.player_white_id !== user.id) {
    socket.emit('error', { message: '你不是本局玩家' });
    return;
  }
  const opponentId = getOpponentId(game, user.id);
  if (!opponentId) {
    socket.emit('error', { message: '未找到对手' });
    return;
  }
  const key = rematchKey(user.id, opponentId);
  if (pendingRematch.has(key)) {
    socket.emit('error', { message: '已有再来一局请求进行中' });
    return;
  }

  // 启动 10 秒超时定时器
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

  // 通知对手
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
  // 回执
  socket.emit('rematch_sent', { toId: opponentId, gameId, timeoutSeconds: REMATCH_TIMEOUT_MS / 1000 });
}

// 响应再来一局
function respondRematch(socket, user, { fromUserId, accept, gameId }) {
  const fromId = parseInt(fromUserId, 10);
  if (!fromId) return;
  const key = rematchKey(fromId, user.id);
  const v = pendingRematch.get(key);
  if (!v) {
    socket.emit('error', { message: '再来一局请求已失效' });
    return;
  }
  pendingRematch.delete(key);
  if (v.timer) clearTimeout(v.timer);

  const fromSock = getSocketByUserId(fromId);
  if (!accept) {
    if (fromSock) fromSock.emit('rematch_declined', { byUserId: user.id, byUsername: user.username });
    return;
  }
  // 同意：先让双方退出可能存在的等待队列
  cancelMatch(fromId);
  cancelMatch(user.id);
  // 双方只要有一个人不在线就不能开新局
  if (!fromSock) {
    socket.emit('error', { message: '对方已离线，无法开始新对局' });
    return;
  }
  // 关键:自己也必须在线(响应者就是 socket,理论上在线,但保险起见再确认)
  if (!socket) {
    if (fromSock) fromSock.emit('error', { message: '对方已离线，无法开始新对局' });
    return;
  }
  // 随机分配黑白（与上局相反增加趣味）
  let blackId, whiteId;
  if (Math.random() < 0.5) {
    blackId = fromId; whiteId = user.id;
  } else {
    blackId = user.id; whiteId = fromId;
  }
  const newGameId = createGame(blackId, whiteId);
  const blackUser = db.prepare('SELECT id, username FROM users WHERE id = ?').get(blackId);
  const whiteUser = db.prepare('SELECT id, username FROM users WHERE id = ?').get(whiteId);
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

// 邀请好友对弈
function inviteToGame(socket, user, { toUserId }) {
  const toId = parseInt(toUserId, 10);
  if (!toId || toId === user.id) {
    socket.emit('error', { message: '邀请对象无效' });
    return;
  }
  // 必须在等待队列中移除（如果本人正在匹配）
  cancelMatch(user.id);
  // 同一对只保留一个 pending 邀请
  const key = inviteKey(user.id, toId);
  pendingInvites.set(key, { fromId: user.id, toId, createdAt: Date.now() });

  const targetSock = getSocketByUserId(toId);
  if (!targetSock) {
    socket.emit('error', { message: '对方不在线，邀请已发送，待对方上线后可接受' });
    return;
  }
  // 通知接收方
  targetSock.emit('invite_received', {
    fromId: user.id,
    fromUsername: user.username,
    fromCode: db.prepare('SELECT friend_code FROM users WHERE id = ?').get(user.id)?.friend_code,
  });
  // 给发起方一个状态回执
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

// 响应邀请
function respondInvite(socket, user, { fromUserId, accept }) {
  const fromId = parseInt(fromUserId, 10);
  if (!fromId) return;
  const key = inviteKey(fromId, user.id);
  const v = pendingInvites.get(key);
  if (!v) {
    socket.emit('error', { message: '邀请已失效' });
    return;
  }
  pendingInvites.delete(key);

  const fromSock = getSocketByUserId(fromId);
  if (accept) {
    // 双方先退出各自等待队列
    cancelMatch(fromId);
    cancelMatch(user.id);
    // 双方必须都还在线
    if (!fromSock) {
      socket.emit('error', { message: '对方已离线，无法开始新对局' });
      return;
    }
    // 随机分配黑白
    let blackId, whiteId;
    if (Math.random() < 0.5) {
      blackId = fromId; whiteId = user.id;
    } else {
      blackId = user.id; whiteId = fromId;
    }
    const gameId = createGame(blackId, whiteId);
    const blackUser = db.prepare('SELECT id, username FROM users WHERE id = ?').get(blackId);
    const whiteUser = db.prepare('SELECT id, username FROM users WHERE id = ?').get(whiteId);
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

module.exports = {
  BOARD_SIZE,
  registerSocket,
  unregisterSocket,
  tryMatch,
  cancelMatch,
  markUserJoinedGame,
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
};
