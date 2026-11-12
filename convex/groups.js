// Group chats. You can start a group with your friends, and any member can add their own friends.
import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { fail, cleanText, currentUser, requireUser, brake, blockedSet, publicUser, LIMITS, friendState } from "./lib";

const MAX_MEMBERS = 30;

const membership = (ctx, groupId, userId) =>
  ctx.db.query("gmembers").withIndex("by_group_user", (q) => q.eq("groupId", groupId).eq("userId", userId)).first();
const membersOf = (ctx, groupId) => ctx.db.query("gmembers").withIndex("by_group", (q) => q.eq("groupId", groupId)).collect();

async function requireMember(ctx, token, groupId) {
  const me = await requireUser(ctx, token);
  const gid = ctx.db.normalizeId("groups", groupId);
  const g = gid && (await ctx.db.get(gid));
  if (!g) fail("That group chat doesn't exist any more.");
  const m = await membership(ctx, g._id, me._id);
  if (!m) fail("You're not in this group chat.");
  return { me, g, m };
}

const groupName = (name) => {
  const n = String(name || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 40);
  return n || "Group chat";
};

async function systemMsg(ctx, g, text) {
  const now = Date.now();
  await ctx.db.insert("gmessages", { groupId: g._id, body: text, createdAt: now, system: true });
  await ctx.db.patch(g._id, { lastAt: now, lastText: text.slice(0, 80), lastFrom: undefined });
}

// check the people I want to add are my friends
async function checkFriends(ctx, me, ids) {
  const out = [];
  for (const id of ids) {
    const uid = ctx.db.normalizeId("users", id);
    const u = uid && (await ctx.db.get(uid));
    if (!u || u.banned) fail("Someone you picked isn't on XPerience Online any more.");
    if ((await friendState(ctx, me._id, u._id)) !== "friends") fail(`You can only add your friends, and ${u.name} isn't your friend yet.`);
    out.push(u);
  }
  return out;
}

export const create = mutation({
  args: { token: v.string(), name: v.optional(v.string()), members: v.array(v.string()) },
  handler: async (ctx, { token, name, members }) => {
    const me = await requireUser(ctx, token);
    const ids = [...new Set(members)].filter((x) => x !== me._id);
    if (ids.length < 1) fail("Pick at least one friend for the group.");
    if (ids.length + 1 > MAX_MEMBERS) fail(`Groups can have up to ${MAX_MEMBERS} people.`);
    const people = await checkFriends(ctx, me, ids);
    await brake(ctx, me);
    const now = Date.now();
    const gid = await ctx.db.insert("groups", { name: groupName(name), ownerId: me._id, createdAt: now, lastAt: now, lastText: "" });
    for (const u of [me, ...people]) await ctx.db.insert("gmembers", { groupId: gid, userId: u._id, joinedAt: now, readAt: u._id === me._id ? now : 0 });
    await systemMsg(ctx, await ctx.db.get(gid), `${me.name} started the group with ${people.map((u) => u.name).join(", ")}`);
    return gid;
  },
});

export const mine = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const me = await currentUser(ctx, token);
    if (!me) return [];
    const ms = await ctx.db.query("gmembers").withIndex("by_user", (q) => q.eq("userId", me._id)).collect();
    const out = [];
    for (const m of ms) {
      const g = await ctx.db.get(m.groupId);
      if (!g) continue;
      const mem = await membersOf(ctx, g._id);
      const faces = [];
      for (const x of mem.slice(0, 4)) { if (x.userId === me._id) continue; const u = await ctx.db.get(x.userId); if (u) faces.push(publicUser(u)); }
      out.push({ id: g._id, name: g.name, count: mem.length, faces: faces.slice(0, 3), lastAt: g.lastAt, lastText: g.lastText,
        unread: g.lastAt > m.readAt && g.lastFrom !== me._id && !!g.lastFrom });
    }
    return out.sort((a, b) => b.lastAt - a.lastAt);
  },
});

export const get = query({
  args: { token: v.string(), groupId: v.string() },
  handler: async (ctx, { token, groupId }) => {
    const me = await currentUser(ctx, token);
    if (!me) return null;
    const gid = ctx.db.normalizeId("groups", groupId);
    const g = gid && (await ctx.db.get(gid));
    if (!g || !(await membership(ctx, g._id, me._id))) return { gone: true };
    const hide = await blockedSet(ctx, me);
    const mem = await membersOf(ctx, g._id), people = new Map(), members = [];
    for (const x of mem) {
      const u = await ctx.db.get(x.userId);
      if (!u) continue;
      people.set(u._id, u);
      members.push({ ...publicUser(u), owner: u._id === g.ownerId, friend: u._id === me._id ? "self" : await friendState(ctx, me._id, u._id) });
    }
    const rows = (await ctx.db.query("gmessages").withIndex("by_group", (q) => q.eq("groupId", g._id)).order("desc").take(150)).reverse();
    const list = [];
    for (const r of rows) {
      if (r.system) { list.push({ id: r._id, system: true, body: r.body, at: r.createdAt }); continue; }
      if (hide.has(r.from)) { list.push({ id: r._id, hidden: true, at: r.createdAt }); continue; }
      const u = people.get(r.from) || (await ctx.db.get(r.from));
      list.push({ id: r._id, mine: r.from === me._id, body: r.body, at: r.createdAt, from: publicUser(u) });
    }
    return { id: g._id, name: g.name, isOwner: g.ownerId === me._id, members, list };
  },
});

export const send = mutation({
  args: { token: v.string(), groupId: v.string(), body: v.string() },
  handler: async (ctx, { token, groupId, body }) => {
    const { me, g, m } = await requireMember(ctx, token, groupId);
    const text = cleanText(body, LIMITS.message, "message");
    await brake(ctx, me);
    const now = Date.now();
    await ctx.db.insert("gmessages", { groupId: g._id, from: me._id, body: text, createdAt: now });
    await ctx.db.patch(g._id, { lastAt: now, lastText: `${me.name}: ${text}`.slice(0, 80), lastFrom: me._id });
    await ctx.db.patch(m._id, { readAt: now });
  },
});

export const markRead = mutation({
  args: { token: v.string(), groupId: v.string() },
  handler: async (ctx, { token, groupId }) => {
    const me = await currentUser(ctx, token);
    const gid = ctx.db.normalizeId("groups", groupId);
    if (!me || !gid) return;
    const g = await ctx.db.get(gid);
    const m = g && (await membership(ctx, g._id, me._id));
    if (m && m.readAt < g.lastAt) await ctx.db.patch(m._id, { readAt: Date.now() });
  },
});

export const rename = mutation({
  args: { token: v.string(), groupId: v.string(), name: v.string() },
  handler: async (ctx, { token, groupId, name }) => {
    const { me, g } = await requireMember(ctx, token, groupId);
    const n = groupName(name);
    if (n === g.name) return;
    await brake(ctx, me);
    await ctx.db.patch(g._id, { name: n });
    await systemMsg(ctx, g, `${me.name} renamed the group to "${n}"`);
  },
});

export const add = mutation({
  args: { token: v.string(), groupId: v.string(), members: v.array(v.string()) },
  handler: async (ctx, { token, groupId, members }) => {
    const { me, g } = await requireMember(ctx, token, groupId);
    const current = await membersOf(ctx, g._id), have = new Set(current.map((x) => String(x.userId)));
    const ids = [...new Set(members)].filter((x) => !have.has(String(x)));
    if (!ids.length) return;
    if (current.length + ids.length > MAX_MEMBERS) fail(`Groups can have up to ${MAX_MEMBERS} people.`);
    const people = await checkFriends(ctx, me, ids);
    await brake(ctx, me);
    const now = Date.now();
    for (const u of people) await ctx.db.insert("gmembers", { groupId: g._id, userId: u._id, joinedAt: now, readAt: 0 });
    await systemMsg(ctx, g, `${me.name} added ${people.map((u) => u.name).join(", ")}`);
  },
});

export const leave = mutation({
  args: { token: v.string(), groupId: v.string() },
  handler: async (ctx, { token, groupId }) => {
    const { me, g, m } = await requireMember(ctx, token, groupId);
    await ctx.db.delete(m._id);
    const rest = (await membersOf(ctx, g._id)).sort((a, b) => a.joinedAt - b.joinedAt);
    if (!rest.length) {
      for (const r of await ctx.db.query("gmessages").withIndex("by_group", (q) => q.eq("groupId", g._id)).collect()) await ctx.db.delete(r._id);
      await ctx.db.delete(g._id);
      return;
    }
    if (g.ownerId === me._id) await ctx.db.patch(g._id, { ownerId: rest[0].userId });
    await systemMsg(ctx, g, `${me.name} left the group`);
  },
});

// the person who started the group can remove someone
export const kick = mutation({
  args: { token: v.string(), groupId: v.string(), userId: v.string() },
  handler: async (ctx, { token, groupId, userId }) => {
    const { me, g } = await requireMember(ctx, token, groupId);
    if (g.ownerId !== me._id) fail("Only the person who runs the group can remove people.");
    if (userId === me._id) fail("Use Leave group instead.");
    const uid = ctx.db.normalizeId("users", userId);
    const m = uid && (await membership(ctx, g._id, uid));
    if (!m) return;
    await ctx.db.delete(m._id);
    const u = await ctx.db.get(uid);
    await systemMsg(ctx, g, `${me.name} removed ${u ? u.name : "someone"}`);
  },
});
