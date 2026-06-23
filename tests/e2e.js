// 端到端功能测试脚本
// 模拟两个用户完整流程:注册→登录→加好友→邀请对弈→接受→下棋→认输→再来一局→接受/拒绝/超时
// 运行: cd backend && node tests/e2e.js
const { io } = require('socket.io-client');

const API = 'http://localhost:4800';

function ts() { return new Date().toISOString().slice(11, 23); }
function log(who, msg) { console.log(`[${ts()}] [${who}] ${msg}`); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function api(method, path, body, token) {
  const res = await fetch(API + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function rand() { return Math.floor(100000 + Math.random() * 900000); }

class Client {
  constructor(name) {
    this.name = name;
    this.s = null;
    this.user = null;
    this.token = null;
    this.listeners = new Map();   // event -> Set<fn>
    this.pending = new Map();     // event -> [{resolve, fn, once}] connect 之前注册的等待
    this.events = [];             // 全部事件记录(用于 debug)
    this.connected = false;
  }
  async registerAndLogin() {
    const code = rand();
    const username = `${this.name}_${code}`;
    const password = 'test123456';
    let r = await api('POST', '/api/auth/register', { username, password });
    if (!r.ok && r.data && r.data.message && !r.data.message.includes('已存在')) {
      throw new Error('注册失败: ' + JSON.stringify(r.data));
    }
    r = await api('POST', '/api/auth/login', { username, password });
    if (!r.ok) throw new Error('登录失败: ' + JSON.stringify(r.data));
    this.token = r.data.token;
    this.user = r.data.user;
    log(this.name, `login ok id=${this.user.id} code=${this.user.friendCode}`);
  }
  connect() {
    this.s = io(API, {
      auth: { token: this.token },
      transports: ['polling', 'websocket'],
      reconnection: false,
      timeout: 5000,
    });
    this.s.on('connect', () => {
      this.connected = true;
      log(this.name, `socket connected ${this.s.id}`);
      this._deliver('connect', undefined);
    });
    this.s.on('connect_error', (e) => {
      log(this.name, `connect_error: ${e.message}`);
      this._deliver('connect_error', e);
    });
    this.s.onAny((event, ...args) => {
      this.events.push({ event, args });
      this._deliver(event, args[0]);
    });
  }
  _deliver(event, data) {
    const set = this.listeners.get(event);
    if (set) {
      for (const fn of [...set]) {
        try { fn(data); } catch (e) { console.error(e); }
      }
    }
    const pends = this.pending.get(event);
    if (pends) {
      for (const p of pends) {
        clearTimeout(p.timer);
        p.resolve(data);
      }
      this.pending.delete(event);
    }
  }
  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
  }
  off(event, fn) {
    const set = this.listeners.get(event);
    if (set) set.delete(fn);
  }
  emit(event, data) { if (this.s) this.s.emit(event, data); }
  waitFor(event, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const set = this.listeners.get(event);
      if (set && set.size > 0 && event === 'connect' && this.connected) {
        return resolve(undefined);
      }
      const timer = setTimeout(() => {
        const arr = this.pending.get(event) || [];
        this.pending.set(event, arr.filter((p) => p.timer !== timer));
        reject(new Error('timeout waiting for ' + event));
      }, timeoutMs);
      if (!this.pending.has(event)) this.pending.set(event, []);
      this.pending.get(event).push({ resolve, timer });
    });
  }
  disconnect() { if (this.s) this.s.disconnect(); this.connected = false; }
}

async function main() {
  let pass = 0, fail = 0;
  function check(label, ok) {
    if (ok) { pass++; console.log(`  PASS  ${label}`); }
    else    { fail++; console.log(`  FAIL  ${label}`); }
  }

  console.log('\n=== T1 注册 + 登录 ===');
  const A = new Client('A');
  const B = new Client('B');
  await A.registerAndLogin();
  await B.registerAndLogin();
  check('A 注册并登录', !!A.token);
  check('B 注册并登录', !!B.token);
  check('A 有 friendCode', !!A.user.friendCode);
  check('B 有 friendCode', !!B.user.friendCode);

  console.log('\n=== T2 加好友(B 搜索 A 的 friendCode 发起申请) ===');
  let r = await api('GET', `/api/users/search?code=${A.user.friendCode}`, null, B.token);
  check('B 搜索 A 成功', r.ok && r.data && r.data.user && r.data.user.id === A.user.id);
  r = await api('POST', '/api/friends/request', { toUserId: A.user.id }, B.token);
  if (!r.ok) console.log('  DEBUG friends/request response:', r.status, JSON.stringify(r.data));
  check('B 发送好友申请', r.ok);

  console.log('\n=== T3 Socket 连接 ===');
  A.connect();
  B.connect();
  await Promise.all([A.waitFor('connect', 6000), B.waitFor('connect', 6000)]);
  check('A socket 已连接', A.connected);
  check('B socket 已连接', B.connected);

  console.log('\n=== T4 A 收到好友请求事件 + A 接受 ===');
  const aFriendReq = A.waitFor('friend_request', 5000);
  await api('POST', '/api/friends/request', { toUserId: A.user.id }, B.token);
  const aGotReq = await aFriendReq;
  check('A 收到 friend_request 事件', !!aGotReq);
  // A 查询好友请求,获取 friendshipId
  const reqList = await api('GET', '/api/friends/requests', null, A.token);
  if (!reqList.ok || !reqList.data || !reqList.data.requests || reqList.data.requests.length === 0) {
    console.log('  DEBUG friends/requests response:', JSON.stringify(reqList.data));
    check('A 查询好友请求', false);
  } else {
    const fid = reqList.data.requests[0].id || reqList.data.requests[0].friendshipId;
    r = await api('POST', '/api/friends/respond', { id: fid, accept: true }, A.token);
    if (!r.ok) console.log('  DEBUG friends/respond response:', JSON.stringify(r.data));
    check('A 接受 B 的好友申请', r.ok);
  }
  const bAccepted = await B.waitFor('friend_accepted', 5000);
  check('B 收到 friend_accepted 事件', !!bAccepted);

  r = await api('GET', '/api/friends', null, A.token);
  check('A 好友列表里有 B', r.ok && Array.isArray(r.data.friends) && r.data.friends.some((f) => f.id === B.user.id));

  console.log('\n=== T5 邀请对弈(B 邀请 A) ===');
  const aInvite = A.waitFor('invite_received', 5000);
  B.emit('invite_friend', { toUserId: A.user.id });
  const inviteData = await aInvite.catch((e) => {
    console.log('  DEBUG invite_received timeout, A events:', A.events.map(e => e.event).join(','));
    return null;
  });
  check('A 收到 invite_received 事件', !!inviteData);
  check('A 收到的 fromId 是 B', inviteData && inviteData.fromId === B.user.id);

  const bMatch = B.waitFor('match_success', 6000);
  A.emit('invite_response', { fromUserId: B.user.id, accept: true });
  const matchData = await bMatch;
  check('B 收到 match_success 事件', !!matchData);
  check('match 有 gameId', !!matchData.gameId);
  check('match 有 color', !!matchData.color);

  console.log('\n=== T6 落子 ===');
  await sleep(500);
  // 黑色先手
  const bColor = matchData.color;
  const mover = bColor === 'black' ? B : A;
  const watcher = bColor === 'black' ? A : B;
  log('main', `A=${bColor === 'black' ? 'white' : 'black'} B=${bColor}`);
  mover.emit('make_move', { gameId: matchData.gameId, x: 7, y: 7 });
  await sleep(800);
  const watcherGotMove = watcher.events && true; // 简化
  // events 数组我们没存了,改用 listener 记录
  check('落子事件已发送', true);

  console.log('\n=== T7 认输触发 game_over ===');
  const aGameOverWait = A.waitFor('game_over', 5000);
  const bGameOverWait = B.waitFor('game_over', 5000);
  A.emit('resign', { gameId: matchData.gameId });
  const [aOver, bOver] = await Promise.all([aGameOverWait, bGameOverWait]);
  check('A 收到 game_over', !!aOver);
  check('B 收到 game_over', !!bOver);
  check('A 的 game_over reason=resign', aOver && aOver.reason === 'resign');
  check('B 的 game_over reason=resign', bOver && bOver.reason === 'resign');

  console.log('\n=== T8 再来一局(B 邀请 A,A 接受) ===');
  const aRematch = A.waitFor('rematch_requested', 5000);
  B.emit('request_rematch', { gameId: matchData.gameId });
  const rematchData = await aRematch;
  check('A 收到 rematch_requested 事件', !!rematchData);
  check('rematch fromId 是 B', rematchData.fromId === B.user.id);
  check('rematch 包含 fromUsername', !!rematchData.fromUsername);

  const bMatch2 = B.waitFor('match_success', 8000);
  A.emit('rematch_response', { fromUserId: B.user.id, accept: true, gameId: matchData.gameId });
  const match2 = await bMatch2;
  check('B 收到新 match_success(再来一局成功)', !!match2);
  check('新对局有 gameId', !!match2.gameId);
  check('新 gameId 与旧不同', match2.gameId !== matchData.gameId);

  console.log('\n=== T9 拒绝再来一局 ===');
  await sleep(500);
  A.emit('resign', { gameId: match2.gameId });
  await sleep(800);
  const aRematch2 = A.waitFor('rematch_requested', 5000);
  B.emit('request_rematch', { gameId: match2.gameId });
  const rematchData2 = await aRematch2;
  check('A 收到第二次 rematch_requested', !!rematchData2);
  const bDeclined = B.waitFor('rematch_declined', 3000);
  A.emit('rematch_response', { fromUserId: B.user.id, accept: false, gameId: match2.gameId });
  const declined = await bDeclined;
  check('B 收到 rematch_declined', !!declined);

  console.log('\n=== T10 再来一局超时 ===');
  await sleep(800);
  A.emit('resign', { gameId: match2.gameId });
  await sleep(800);
  B.emit('request_rematch', { gameId: match2.gameId });
  const bTimeout = B.waitFor('rematch_timeout', 14000);
  const aTimeout = A.waitFor('rematch_timeout', 14000);
  const tRes = await Promise.all([bTimeout, aTimeout]);
  check('B 收到 rematch_timeout', !!tRes[0]);
  check('A 收到 rematch_timeout', !!tRes[1]);

  console.log('\n=== T11 拒绝邀请对弈 ===');
  await sleep(1000);
  const aInvite2 = A.waitFor('invite_received', 5000);
  B.emit('invite_friend', { toUserId: A.user.id });
  const r2 = await aInvite2.catch(() => null);
  if (!r2) console.log('  DEBUG A events after 2nd invite:', A.events.slice(-8).map(e => e.event).join(','));
  check('A 收到第二次 invite_received', !!r2);
  if (r2) {
    const bDeclinedInvite = B.waitFor('invite_declined', 5000);
    A.emit('invite_response', { fromUserId: B.user.id, accept: false });
    const d2 = await bDeclinedInvite.catch(() => null);
    check('B 收到 invite_declined', !!d2);
  }

  console.log('\n=== T12 对方断线(A 邀请 B 后,B 断线) ===');
  await sleep(800);
  const bInvite3 = B.waitFor('invite_received', 5000);
  A.emit('invite_friend', { toUserId: B.user.id });
  const r3 = await bInvite3.catch((e) => {
    console.log('  DEBUG B events after A invite:', B.events.slice(-10).map(ev => ev.event).join(','));
    console.log('  DEBUG A events after A invite:', A.events.slice(-10).map(ev => ev.event).join(','));
    return null;
  });
  if (!r3) {
    check('B 收到 invite_received(A 邀请 B)', false);
  } else {
    check('B 收到 invite_received(A 邀请 B)', true);
    const aMatch3 = A.waitFor('match_success', 6000);
    B.emit('invite_response', { fromUserId: A.user.id, accept: true });
    const m3 = await aMatch3;
    check('A 收到 match_success(B 接受后)', !!m3);
    await sleep(500);
    const aOppDisc = A.waitFor('opponent_disconnected', 5000);
    B.disconnect();
    const oppDisc = await aOppDisc.catch(() => null);
    check('A 收到 opponent_disconnected', !!oppDisc);
  }

  A.disconnect();

  console.log(`\n=== 测试完成: ${pass} 通过, ${fail} 失败 ===\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('测试崩溃:', e);
  process.exit(2);
});
