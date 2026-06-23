// 好友系统：搜索、请求、接受、列表、删除
const db = require('./db');

// 工具：把 (a, b) 规范为 (smaller, larger) 以保证唯一约束
function orderedPair(a, b) {
  return a < b ? [a, b] : [b, a];
}

// 根据 friend_code 搜索用户
function searchByCode(code, currentUserId) {
  if (!code || !/^\d{6}$/.test(String(code).trim())) {
    throw new Error('请输入 6 位数字好友码');
  }
  const row = db
    .prepare('SELECT id, username, friend_code FROM users WHERE friend_code = ?')
    .get(String(code).trim());
  if (!row) return null;
  if (row.id === currentUserId) return null;
  return { id: row.id, username: row.username, friendCode: row.friend_code };
}

// 发送好友请求
// 行为：
//  - 已存在 accepted 记录：返回已是好友
//  - 已存在 pending 记录：返回已在请求中
//  - 对方曾向你发过 pending 请求：直接把它置为 accepted（互加）
//  - 否则：插入新 pending 记录
function sendRequest(fromUserId, toUserId) {
  if (fromUserId === toUserId) throw new Error('不能添加自己为好友');
  const target = db.prepare('SELECT id, username FROM users WHERE id = ?').get(toUserId);
  if (!target) throw new Error('用户不存在');

  const [a, b] = orderedPair(fromUserId, toUserId);
  const existing = db
    .prepare('SELECT * FROM friendships WHERE user_id = ? AND friend_id = ?')
    .get(a, b);

  if (existing) {
    if (existing.status === 'accepted') return { status: 'already_friend' };
    if (existing.status === 'pending' && existing.requester_id === fromUserId) {
      return { status: 'already_requested' };
    }
    // 对方之前向你发过请求：直接互加
    if (existing.status === 'pending' && existing.requester_id === toUserId) {
      db.prepare(
        "UPDATE friendships SET status = 'accepted', requester_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).run(fromUserId, existing.id);
      return { status: 'accepted', fromUserId, toUserId };
    }
  }

  db.prepare(
    `INSERT INTO friendships (user_id, friend_id, status, requester_id)
     VALUES (?, ?, 'pending', ?)`
  ).run(a, b, fromUserId);

  return { status: 'requested', fromUserId, toUserId };
}

// 我收到的好友请求
function getIncomingRequests(userId) {
  // row 存的是 (user_id=min, friend_id=max)
  // 所以要查 userId 在 (user_id, friend_id) 中任一位置
  const rows = db
    .prepare(
      `SELECT f.id, f.requester_id, f.created_at,
              u.username AS requester_username, u.friend_code AS requester_code
         FROM friendships f
         JOIN users u ON u.id = f.requester_id
        WHERE (f.user_id = ? OR f.friend_id = ?)
          AND f.requester_id != ?
          AND f.status = 'pending'`
    )
    .all(userId, userId, userId);

  return rows.map((r) => ({
    id: r.id,
    fromId: r.requester_id,
    fromUsername: r.requester_username,
    fromCode: r.requester_code,
    createdAt: r.created_at,
  }));
}

// 响应好友请求：accept=true 通过；false 拒绝
function respondRequest(userId, friendshipId, accept) {
  const row = db.prepare('SELECT * FROM friendships WHERE id = ?').get(friendshipId);
  if (!row) throw new Error('请求不存在');
  // 必须是请求接收方（即 user_id 和 friend_id 中等于 userId 之一，且 requester_id != userId）
  if (row.user_id !== userId && row.friend_id !== userId) {
    throw new Error('无权处理该请求');
  }
  if (row.status !== 'pending') throw new Error('该请求已处理');
  if (row.requester_id === userId) throw new Error('不能响应自己发起的请求');

  const newStatus = accept ? 'accepted' : 'rejected';
  db.prepare(
    "UPDATE friendships SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(newStatus, friendshipId);
  return { status: newStatus, requesterId: row.requester_id };
}

// 好友列表（已 accepted 状态）
function listFriends(userId) {
  const rows = db
    .prepare(
      `SELECT u.id, u.username, u.friend_code, f.created_at
         FROM friendships f
         JOIN users u
           ON (u.id = f.friend_id AND f.user_id = ?)
            OR (u.id = f.user_id AND f.friend_id = ?)
        WHERE f.status = 'accepted' AND u.id != ?
        ORDER BY f.updated_at DESC`
    )
    .all(userId, userId, userId);
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    friendCode: r.friend_code,
    since: r.created_at,
  }));
}

// 判断是否好友
function isFriend(a, b) {
  const [u1, u2] = orderedPair(a, b);
  const row = db
    .prepare("SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ? AND status = 'accepted'")
    .get(u1, u2);
  return !!row;
}

// 删除好友
function removeFriend(userId, friendId) {
  const [a, b] = orderedPair(userId, friendId);
  const result = db
    .prepare("DELETE FROM friendships WHERE user_id = ? AND friend_id = ? AND status = 'accepted'")
    .run(a, b);
  if (result.changes === 0) throw new Error('对方不是你的好友');
  return { ok: true };
}

module.exports = {
  searchByCode,
  sendRequest,
  getIncomingRequests,
  respondRequest,
  listFriends,
  isFriend,
  removeFriend,
};
