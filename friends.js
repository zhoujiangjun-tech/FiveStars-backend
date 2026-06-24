// 好友系统：搜索、请求、接受、列表、删除
const db = require('./db');

// 工具：把 (a, b) 规范为 (smaller, larger) 以保证唯一约束
function orderedPair(a, b) {
  return a < b ? [a, b] : [b, a];
}

// 根据 friend_code 搜索用户
async function searchByCode(code, currentUserId) {
  if (!code || !/^\d{6}$/.test(String(code).trim())) {
    throw new Error('请输入 6 位数字好友码');
  }
  const row = await db.get(
    'SELECT id, username, friend_code FROM users WHERE friend_code = ?',
    String(code).trim()
  );
  if (!row) return null;
  if (row.id === currentUserId) return null;
  return { id: row.id, username: row.username, friendCode: row.friend_code };
}

// 根据用户名模糊搜(兜底:好友码记不住也能找到)
async function searchByUsername(keyword, currentUserId) {
  const k = String(keyword || '').trim();
  if (!k) return null;
  const rows = await db.all(
    'SELECT id, username, friend_code FROM users WHERE username LIKE ? AND id != ? LIMIT 10',
    `%${k}%`, currentUserId
  );
  if (rows.length === 0) return null;
  rows.sort((a, b) => {
    const al = a.username.toLowerCase();
    const bl = b.username.toLowerCase();
    const kk = k.toLowerCase();
    const aExact = al === kk ? 0 : al.startsWith(kk) ? 1 : 2;
    const bExact = bl === kk ? 0 : bl.startsWith(kk) ? 1 : 2;
    return aExact - bExact;
  });
  const r = rows[0];
  return { id: r.id, username: r.username, friendCode: r.friend_code };
}

// 发送好友请求
async function sendRequest(fromUserId, toUserId) {
  if (fromUserId === toUserId) throw new Error('不能添加自己为好友');
  const target = await db.get('SELECT id, username FROM users WHERE id = ?', toUserId);
  if (!target) throw new Error('用户不存在');

  const [a, b] = orderedPair(fromUserId, toUserId);
  const existing = await db.get(
    'SELECT * FROM friendships WHERE user_id = ? AND friend_id = ?',
    a, b
  );

  if (existing) {
    if (existing.status === 'accepted') return { status: 'already_friend' };
    if (existing.status === 'pending' && existing.requester_id === fromUserId) {
      return { status: 'already_requested' };
    }
    // 对方之前向你发过请求：直接互加
    if (existing.status === 'pending' && existing.requester_id === toUserId) {
      await db.run(
        "UPDATE friendships SET status = 'accepted', requester_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        fromUserId, existing.id
      );
      return { status: 'accepted', fromUserId, toUserId };
    }
  }

  await db.run(
    `INSERT INTO friendships (user_id, friend_id, status, requester_id)
     VALUES (?, ?, 'pending', ?)`,
    a, b, fromUserId
  );

  return { status: 'requested', fromUserId, toUserId };
}

// 我收到的好友请求
async function getIncomingRequests(userId) {
  const rows = await db.all(
    `SELECT f.id, f.requester_id, f.created_at,
            u.username AS requester_username, u.friend_code AS requester_code
       FROM friendships f
       JOIN users u ON u.id = f.requester_id
      WHERE (f.user_id = ? OR f.friend_id = ?)
        AND f.requester_id != ?
        AND f.status = 'pending'`,
    userId, userId, userId
  );

  return rows.map((r) => ({
    id: r.id,
    fromId: r.requester_id,
    fromUsername: r.requester_username,
    fromCode: r.requester_code,
    createdAt: r.created_at,
  }));
}

// 响应好友请求：accept=true 通过；false 拒绝
async function respondRequest(userId, friendshipId, accept) {
  const row = await db.get('SELECT * FROM friendships WHERE id = ?', friendshipId);
  if (!row) throw new Error('请求不存在');
  if (row.user_id !== userId && row.friend_id !== userId) {
    throw new Error('无权处理该请求');
  }
  if (row.status !== 'pending') throw new Error('该请求已处理');
  if (row.requester_id === userId) throw new Error('不能响应自己发起的请求');

  const newStatus = accept ? 'accepted' : 'rejected';
  await db.run(
    "UPDATE friendships SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    newStatus, friendshipId
  );
  return { status: newStatus, requesterId: row.requester_id };
}

// 好友列表（已 accepted 状态）
async function listFriends(userId) {
  const rows = await db.all(
    `SELECT u.id, u.username, u.friend_code, f.created_at
       FROM friendships f
       JOIN users u
         ON (u.id = f.friend_id AND f.user_id = ?)
          OR (u.id = f.user_id AND f.friend_id = ?)
      WHERE f.status = 'accepted' AND u.id != ?
      ORDER BY f.updated_at DESC`,
    userId, userId, userId
  );
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    friendCode: r.friend_code,
    since: r.created_at,
  }));
}

// 判断是否好友
async function isFriend(a, b) {
  const [u1, u2] = orderedPair(a, b);
  const row = await db.get(
    "SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ? AND status = 'accepted'",
    u1, u2
  );
  return !!row;
}

// 删除好友
async function removeFriend(userId, friendId) {
  const [a, b] = orderedPair(userId, friendId);
  const result = await db.run(
    "DELETE FROM friendships WHERE user_id = ? AND friend_id = ? AND status = 'accepted'",
    a, b
  );
  if (result.changes === 0) throw new Error('对方不是你的好友');
  return { ok: true };
}

module.exports = {
  searchByCode,
  searchByUsername,
  sendRequest,
  getIncomingRequests,
  respondRequest,
  listFriends,
  isFriend,
  removeFriend,
};