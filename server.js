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

// 启动时确保旧用户有 friend_code
db.ensureCodes();

// ============ HTTP API ============

// 简易请求日志
app.use((req, res, next) => {
  console.log(`[http] ${req.method} ${req.url} from ${req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress}`);
  next();
});

// 健康检查
app.get('/', (req, res) => {
  res.json({ ok: true, app: '五星连珠' });
});

// 注册
app.post('/api/auth/register', (req, res) => {
  try {
    const { username, password } = req.body || {};
    const result = register(username, password);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 登录
app.post('/api/auth/login', (req, res) => {
  try {
    const { username, password } = req.body || {};
    const result = login(username, password);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 当前用户历史对局
app.get('/api/games/my', authMiddleware, (req, res) => {
  const uid = req.user.id;
  const rows = db
    .prepare(
      `SELECT g.id, g.player_black_id, g.player_white_id, g.status, g.winner_id, g.created_at, g.finished_at,
              ub.username AS black_username, uw.username AS white_username
         FROM games g
         LEFT JOIN users ub ON ub.id = g.player_black_id
         LEFT JOIN users uw ON uw.id = g.player_white_id
        WHERE g.player_black_id = ? OR g.player_white_id = ?
        ORDER BY g.id DESC
        LIMIT 100`
    )
    .all(uid, uid);

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
app.get('/api/games/:id', authMiddleware, (req, res) => {
  const uid = req.user.id;
  const id = parseInt(req.params.id, 10);
  const g = game.getGame(id);
  if (!g) return res.status(404).json({ error: '对局不存在' });
  if (g.player_black_id !== uid && g.player_white_id !== uid) {
    return res.status(403).json({ error: '无权查看该对局' });
  }
  const black = db.prepare('SELECT id, username FROM users WHERE id = ?').get(g.player_black_id);
  const white = db.prepare('SELECT id, username FROM users WHERE id = ?').get(g.player_white_id);
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
app.get('/api/user/stats', authMiddleware, (req, res) => {
  const uid = req.user.id;
  const total = db
    .prepare(
      `SELECT COUNT(*) AS c FROM games WHERE player_black_id = ? OR player_white_id = ?`
    )
    .get(uid, uid).c;

  const wins = db
    .prepare(
      `SELECT COUNT(*) AS c FROM games WHERE winner_id = ?`
    )
    .get(uid).c;

  const losses = db
    .prepare(
      `SELECT COUNT(*) AS c FROM games
        WHERE status = 'finished' AND winner_id IS NOT NULL AND winner_id != ?
          AND (player_black_id = ? OR player_white_id = ?)`
    )
    .get(uid, uid, uid).c;

  const draws = db
    .prepare(
      `SELECT COUNT(*) AS c FROM games
        WHERE status = 'draw' AND (player_black_id = ? OR player_white_id = ?)`
    )
    .get(uid, uid).c;

  const user = db.prepare('SELECT id, username, friend_code, created_at FROM users WHERE id = ?').get(uid);
  res.json({
    user: user ? {
      id: user.id,
      username: user.username,
      friendCode: user.friend_code,
      createdAt: user.created_at,
    } : null,
    total,
    wins,
    losses,
    draws
  });
});

// ============ 好友系统 REST API ============

// 搜索用户（按好友码）
app.get('/api/users/search', authMiddleware, (req, res) => {
  try {
    const code = req.query.code;
    const me = req.user.id;
    const u = friends.searchByCode(code, me);
    if (!u) return res.json({ user: null });
    const isFriend = friends.isFriend(me, u.id);
    res.json({ user: u, isFriend });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 发送好友请求
app.post('/api/friends/request', (req, res, next) => {
  authMiddleware(req, res, () => handleSendFriendRequest(req, res));
});

function handleSendFriendRequest(req, res) {
  try {
    const { code, toUserId } = req.body || {};
    let targetId = toUserId;
    if (!targetId && code) {
      const u = friends.searchByCode(code, req.user.id);
      if (!u) return res.status(404).json({ error: '用户不存在' });
      targetId = u.id;
    }
    if (!targetId) return res.status(400).json({ error: '缺少 code 或 toUserId' });
    const result = friends.sendRequest(req.user.id, targetId);
    // 异步通知对方（不阻塞响应）
    if (global.__io) {
      const targetIdNum = targetId;
      const fromCode = db.prepare('SELECT friend_code FROM users WHERE id = ?').get(req.user.id)?.friend_code;
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
    } else {
      console.log('[friend_request] global.__io not set');
    }
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}

// 收到的好友请求
app.get('/api/friends/requests', authMiddleware, (req, res) => {
  const list = friends.getIncomingRequests(req.user.id);
  res.json({ requests: list });
});

// 响应好友请求
app.post('/api/friends/respond', authMiddleware, (req, res) => {
  try {
    const { id, accept } = req.body || {};
    if (!id) return res.status(400).json({ error: '缺少 id' });
    const result = friends.respondRequest(req.user.id, parseInt(id, 10), !!accept);
    // 通知请求方
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
app.get('/api/friends', authMiddleware, (req, res) => {
  const list = friends.listFriends(req.user.id);
  // 是否在线
  const ids = new Set(list.map((f) => f.id));
  let onlineIds = new Set();
  if (global.__io) {
    global.__io.fetchSockets().then((sockets) => {
      const next = new Set(sockets.map((s) => s.user?.id).filter(Boolean));
      // 同步响应里附上
    }).catch(() => {});
  }
  res.json({ friends: list });
});

// 删除好友
app.delete('/api/friends/:id', authMiddleware, (req, res) => {
  try {
    const fid = parseInt(req.params.id, 10);
    const r = friends.removeFriend(req.user.id, fid);
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 我的资料（含好友码）
app.get('/api/user/me', authMiddleware, (req, res) => {
  const row = db
    .prepare('SELECT id, username, friend_code, created_at FROM users WHERE id = ?')
    .get(req.user.id);
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

  socket.on('join_match', () => {
    game.tryMatch(socket, user);
  });

  socket.on('cancel_match', () => {
    game.cancelMatch(user.id);
  });

  socket.on('make_move', (data) => {
    game.makeMove(socket, user, data || {});
  });

  socket.on('request_undo', (data) => {
    game.requestUndo(socket, user, data || {});
  });

  socket.on('undo_response', (data) => {
    game.undoResponse(socket, user, data || {});
  });

  socket.on('resign', (data) => {
    game.resign(socket, user, data || {});
  });

  // 退出对局（对局中）
  socket.on('exit_game', (data) => {
    game.exitGame(socket, user, data || {});
  });

  // 再来一局
  socket.on('request_rematch', (data) => {
    game.requestRematch(socket, user, data || {});
  });
  socket.on('rematch_response', (data) => {
    game.respondRematch(socket, user, data || {});
  });

  // 邀请好友对弈
  socket.on('invite_friend', (data) => {
    game.inviteToGame(socket, user, data || {});
  });
  socket.on('cancel_invite', (data) => {
    game.cancelInvite(socket, user, data || {});
  });
  socket.on('invite_response', (data) => {
    game.respondInvite(socket, user, data || {});
  });

  socket.on('disconnect', () => {
    console.log(`[disconnect] user=${user.id} ${user.username} sid=${socket.id}`);
    game.unregisterSocket(socket);
    // 稍等一拍再移除，避免同一账号其它连接被误减
    setTimeout(() => removeOnline(user), 100);
  });
});

// === 实时在线人数广播 ===
const onlineUserIds = new Set();
const onlineUserCounts = new Map(); // userId -> 已连接 socket 数（多端/多标签登录计数）

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
    return; // 同一账号还有别的连接，账号仍在线
  }
  broadcastOnlineCount();
}
function broadcastOnlineCount() {
  io.emit('online_count', { count: onlineUserIds.size });
}

// === 鉴权中间件：未登录拒绝连接 ===


// 默认使用 4800 端口（避开 3000/5173 已被占用的项目），可通过环境变量 PORT 自定义
const PORT = process.env.PORT || 4800;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`五星连珠后端已启动，监听端口 ${PORT}`);
});
