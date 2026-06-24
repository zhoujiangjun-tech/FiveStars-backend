// 服务端入口：HTTP API + Socket.io
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const db = require('./db');
const friends = require('./friends');
const { register, login, authMiddleware, verifySocketToken } = require('./auth');
const game = require('./game');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

// 简易请求日志
app.use((req, res, next) => {
  console.log(`[http] ${req.method} ${req.url} from ${req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress}`);
  next();
});

// 健康检查
app.get('/', (req, res) => {
  res.json({ ok: true, app: '五星连珠', online: onlineUserIds.size });
});

// 调试接口:看自己 + 队列长度
app.get('/api/debug/match-state', authMiddleware, (req, res) => {
  const me = req.user.id;
  res.json({
    me: { id: me, username: req.user.username },
    onlineCount: onlineUserIds.size,
    waitingQueueSize: game.waitingQueueSize(),
    inQueue: game.isInQueue(me),
    serverTime: Date.now(),
  });
});

// 注册
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const result = await register(username, password);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 登录
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const result = await login(username, password);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 当前用户历史对局
app.get('/api/games/my', authMiddleware, async (req, res) => {
  const uid = req.user.id;
  const rows = await db.all(
    `SELECT g.id, g.player_black_id, g.player_white_id, g.status, g.winner_id, g.created_at, g.finished_at,
            ub.username AS black_username, uw.username AS white_username
       FROM games g
       LEFT JOIN users ub ON ub.id = g.player_black_id
       LEFT JOIN users uw ON uw.id = g.player_white_id
      WHERE g.player_black_id = ? OR g.player_white_id = ?
      ORDER BY g.id DESC
      LIMIT 100`,
    uid, uid
  );

  const list = rows.map((r) => {
    let resultText = '进行中';
    if (r.status === 'finished') {
      if (r.winner_id === uid) resultText = '胜';
      else resultText = '负';
    } else if (r.status === 'draw') {
      resultText = '平';
    }
    return {
      id: r.id,
      black: { id: r.player_black_id, username: r.black_username },
      white: { id: r.player_white_id, username: r.white_username },
      status: r.status,
      winnerId: r.winner_id,
      myResult: resultText,
      createdAt: r.created_at,
      finishedAt: r.finished_at,
    };
  });
  res.json({ games: list });
});

// 单局详情
app.get('/api/games/:id', authMiddleware, async (req, res) => {
  const uid = req.user.id;
  const id = parseInt(req.params.id, 10);
  const g = await game.getGame(id);
  if (!g) return res.status(404).json({ error: '对局不存在' });
  if (g.player_black_id !== uid && g.player_white_id !== uid) {
    return res.status(403).json({ error: '无权查看该对局' });
  }
  const black = await db.get('SELECT id, username FROM users WHERE id = ?', g.player_black_id);
  const white = await db.get('SELECT id, username FROM users WHERE id = ?', g.player_white_id);
  res.json({
    id: g.id,
    black,
    white,
    boardState: g.board_state,
    moveHistory: g.move_history,
    currentTurn: g.current_turn,
    status: g.status,
    winnerId: g.winner_id,
    undoCountBlack: g.undo_count_black,
    undoCountWhite: g.undo_count_white,
    createdAt: g.created_at,
    finishedAt: g.finished_at,
  });
});

// 用户战绩
app.get('/api/user/stats', authMiddleware, async (req, res) => {
  const uid = req.user.id;
  const totalRow = await db.get(
    `SELECT COUNT(*) AS c FROM games WHERE player_black_id = ? OR player_white_id = ?`,
    uid, uid
  );
  const winsRow = await db.get(
    `SELECT COUNT(*) AS c FROM games WHERE winner_id = ?`,
    uid
  );
  const lossesRow = await db.get(
    `SELECT COUNT(*) AS c FROM games
      WHERE status = 'finished' AND winner_id IS NOT NULL AND winner_id != ?
        AND (player_black_id = ? OR player_white_id = ?)`,
    uid, uid, uid
  );
  const drawsRow = await db.get(
    `SELECT COUNT(*) AS c FROM games
      WHERE status = 'draw' AND (player_black_id = ? OR player_white_id = ?)`,
    uid, uid
  );

  const user = await db.get('SELECT id, username, friend_code, created_at FROM users WHERE id = ?', uid);
  res.json({
    user: user ? {
      id: user.id,
      username: user.username,
      friendCode: user.friend_code,
      createdAt: user.created_at,
    } : null,
    total: totalRow?.c || 0,
    wins: winsRow?.c || 0,
    losses: lossesRow?.c || 0,
    draws: drawsRow?.c || 0,
  });
});

// ============ 好友系统 REST API ============

// 搜索用户
app.get('/api/users/search', authMiddleware, async (req, res) => {
  try {
    const code = String(req.query.code || '').trim();
    const me = req.user.id;
    let u = null;
    if (/^\d{6}$/.test(code)) {
      u = await friends.searchByCode(code, me);
    } else if (code.length > 0) {
      u = await friends.searchByUsername(code, me);
    } else {
      return res.status(400).json({ error: '请输入 6 位好友码或用户名' });
    }
    if (!u) return res.json({ user: null });
    const isFriend = await friends.isFriend(me, u.id);
    res.json({ user: u, isFriend });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 发送好友请求
app.post('/api/friends/request', authMiddleware, async (req, res) => {
  try {
    const { code, toUserId } = req.body || {};
    let targetId = toUserId;
    if (!targetId && code) {
      const u = await friends.searchByCode(code, req.user.id);
      if (!u) return res.status(404).json({ error: '用户不存在' });
      targetId = u.id;
    }
    if (!targetId) return res.status(400).json({ error: '缺少 code 或 toUserId' });
    const result = await friends.sendRequest(req.user.id, targetId);
    if (global.__io) {
      const targetIdNum = targetId;
      const fromCode = (await db.get('SELECT friend_code FROM users WHERE id = ?', req.user.id))?.friend_code;
      global.__io.fetchSockets().then((sockets) => {
        let delivered = false;
        for (const s of sockets) {
          if (s.user && s.user.id === targetIdNum) {
            s.emit('friend_request', {
              fromId: req.user.id,
              fromUsername: req.user.username,
              fromCode,
            });
            delivered = true;
          }
        }
        console.log(`[friend_request] from=${req.user.id} -> to=${targetIdNum} delivered=${delivered} totalSockets=${sockets.length}`);
      }).catch((e) => {
        console.log('[friend_request] emit error:', e.message);
      });
    }
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 收到的好友请求
app.get('/api/friends/requests', authMiddleware, async (req, res) => {
  const list = await friends.getIncomingRequests(req.user.id);
  res.json({ requests: list });
});

// 响应好友请求
app.post('/api/friends/respond', authMiddleware, async (req, res) => {
  try {
    const { id, accept } = req.body || {};
    if (!id) return res.status(400).json({ error: '缺少 id' });
    const result = await friends.respondRequest(req.user.id, parseInt(id, 10), !!accept);
    if (global.__io) {
      global.__io.fetchSockets().then((sockets) => {
        for (const s of sockets) {
          if (s.user && s.user.id === result.requesterId) {
            s.emit('friend_accepted', {
              byUserId: req.user.id,
              byUsername: req.user.username,
              accepted: result.status === 'accepted',
            });
          }
        }
      }).catch(() => {});
    }
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 好友列表
app.get('/api/friends', authMiddleware, async (req, res) => {
  const list = await friends.listFriends(req.user.id);
  res.json({ friends: list });
});

// 删除好友
app.delete('/api/friends/:id', authMiddleware, async (req, res) => {
  try {
    const fid = parseInt(req.params.id, 10);
    const r = await friends.removeFriend(req.user.id, fid);
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 我的资料
app.get('/api/user/me', authMiddleware, async (req, res) => {
  const row = await db.get('SELECT id, username, friend_code, created_at FROM users WHERE id = ?', req.user.id);
  if (!row) return res.status(404).json({ error: '用户不存在' });
  res.json({
    user: {
      id: row.id,
      username: row.username,
      friendCode: row.friend_code,
      createdAt: row.created_at,
    },
  });
});

// ============ Socket.io ============

const io = new Server(server, {
  cors: { origin: '*' },
});
global.__io = io;

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  const user = verifySocketToken(token);
  if (!user) {
    return next(new Error('未授权'));
  }
  socket.user = user;
  next();
});

io.on('connection', (socket) => {
  const user = socket.user;
  game.registerSocket(socket, user);

  console.log(`[connect] user=${user.id} ${user.username} sid=${socket.id}`);
  addOnline(user);
  socket.emit('online_count', { count: onlineUserIds.size });

  socket.on('join_match', async () => {
    await game.tryMatch(socket, user);
  });

  socket.on('join_game', async ({ gameId } = {}) => {
    if (typeof gameId !== 'number') return;
    try {
      const g = await game.getGame(gameId);
      if (!g) return;
      if (g.player_black_id !== user.id && g.player_white_id !== user.id) return;
      game.markUserJoinedGame(gameId, user.id);
      const opponentId = g.player_black_id === user.id ? g.player_white_id : g.player_black_id;
      const opReady = game.hasUserJoinedGame(gameId, opponentId);
      socket.emit('join_game_ack', { gameId, bothReady: opReady && game.hasUserJoinedGame(gameId, user.id) });
    } catch (_) {}
  });

  socket.on('cancel_match', () => {
    game.cancelMatch(user.id);
  });

  socket.on('make_move', async (data) => {
    await game.makeMove(socket, user, data || {});
  });

  socket.on('request_undo', async (data) => {
    await game.requestUndo(socket, user, data || {});
  });

  socket.on('undo_response', async (data) => {
    await game.undoResponse(socket, user, data || {});
  });

  socket.on('resign', async (data) => {
    await game.resign(socket, user, data || {});
  });

  socket.on('exit_game', async (data) => {
    await game.exitGame(socket, user, data || {});
  });

  socket.on('request_rematch', async (data) => {
    await game.requestRematch(socket, user, data || {});
  });

  socket.on('rematch_response', async (data) => {
    await game.respondRematch(socket, user, data || {});
  });

  socket.on('invite_friend', async (data) => {
    await game.inviteToGame(socket, user, data || {});
  });

  socket.on('cancel_invite', (data) => {
    game.cancelInvite(socket, user, data || {});
  });

  socket.on('invite_response', async (data) => {
    await game.respondInvite(socket, user, data || {});
  });

  socket.on('disconnect', async () => {
    console.log(`[disconnect] user=${user.id} ${user.username} sid=${socket.id}`);
    await game.unregisterSocket(socket);
    setTimeout(() => removeOnline(user), 100);
  });
});

// === 实时在线人数广播 ===
const onlineUserIds = new Set();
const onlineUserCounts = new Map();

function addOnline(user) {
  const before = onlineUserCounts.get(user.id) || 0;
  onlineUserCounts.set(user.id, before + 1);
  if (!onlineUserIds.has(user.id)) {
    onlineUserIds.add(user.id);
    broadcastOnlineCount();
  }
}
function removeOnline(user) {
  const before = onlineUserCounts.get(user.id) || 0;
  if (before <= 1) {
    onlineUserCounts.delete(user.id);
    onlineUserIds.delete(user.id);
  } else {
    onlineUserCounts.set(user.id, before - 1);
    return;
  }
  broadcastOnlineCount();
}
function broadcastOnlineCount() {
  io.emit('online_count', { count: onlineUserIds.size });
}

// 启动服务器
const PORT = process.env.PORT || 4800;

(async () => {
  await db.initTables();
  await db.ensureCodes();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`五星连珠后端已启动，监听端口 ${PORT}`);
  });
})();