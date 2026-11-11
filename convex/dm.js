// Private 1-to-1 messages between online users (Chatzee "Online" tab).
import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { fail, cleanText, currentUser, requireUser, brake, blockedEitherWay, publicUser, LIMITS, pairKey, friendState } from "./lib";

export const myConvos = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const me = await currentUser(ctx, token);
    if (!me) return [];
    const a = await ctx.db.query("convos").withIndex("by_a", (q) => q.eq("a", me._id)).order("desc").take(50);
    const b = await ctx.db.query("convos").withIndex("by_b", (q) => q.eq("b", me._id)).order("desc").take(50);
    const all = [...a, ...b].sort((x, y) => y.lastAt - x.lastAt);
    const out = [];
    for (const c of all) {
      const otherId = c.a === me._id ? c.b : c.a;
      const other = await ctx.db.get(otherId);
      if (!other || other.banned) continue;
      const myRead = c.a === me._id ? c.readA : c.readB;
      out.push({ id: c._id, other: publicUser(other), lastText: c.lastText, lastAt: c.lastAt, unread: c.lastFrom !== me._id && c.lastAt > myRead, blocked: await blockedEitherWay(ctx, me._id, otherId) });
    }
    return out;
  },
});

export const messages = query({
  args: { token: v.string(), userId: v.id("users") },
  handler: async (ctx, { token, userId }) => {
    const me = await currentUser(ctx, token);
    if (!me) return null;
    const c = await ctx.db.query("convos").withIndex("by_key", (q) => q.eq("key", pairKey(me._id, userId))).unique();
    const other = await ctx.db.get(userId);
    const blocked = await blockedEitherWay(ctx, me._id, userId);
    const iBlocked = !!(await ctx.db.query("blocks").withIndex("by_pair", (q) => q.eq("by", me._id).eq("who", userId)).first());
    const friend = await friendState(ctx, me._id, userId);
    const base = { other: publicUser(other), blocked, iBlocked, friend, theyAcceptRequests: !!other && other.dmsFrom !== "nobody" };
    if (!c) return { ...base, convoId: null, list: [] };
    const rows = await ctx.db.query("messages").withIndex("by_convo", (q) => q.eq("convoId", c._id)).order("desc").take(150);
    return { ...base, convoId: c._id, list: rows.reverse().map((m) => ({ id: m._id, mine: m.from === me._id, body: m.body, at: m.createdAt })) };
  },
});

export const send = mutation({
  args: { token: v.string(), to: v.id("users"), body: v.string() },
  handler: async (ctx, { token, to, body }) => {
    const me = await requireUser(ctx, token);
    if (to === me._id) fail("You can't message yourself.");
    const other = await ctx.db.get(to);
    if (!other || other.banned) fail("That person isn't on XPerience Online any more.");
    if (await blockedEitherWay(ctx, me._id, to)) fail("You can't message this person.");
    if ((await friendState(ctx, me._id, to)) !== "friends") fail(`You and ${other.name} need to be friends before you can chat. Send a friend request first!`);
    const text = cleanText(body, LIMITS.message, "message");
    const key = pairKey(me._id, to);
    let c = await ctx.db.query("convos").withIndex("by_key", (q) => q.eq("key", key)).unique();
    await brake(ctx, me);
    const now = Date.now();
    if (!c) {
      const [a, b] = me._id < to ? [me._id, to] : [to, me._id];
      const id = await ctx.db.insert("convos", { a, b, key, lastAt: now, lastText: text.slice(0, 80), lastFrom: me._id, readA: a === me._id ? now : 0, readB: b === me._id ? now : 0 });
      c = await ctx.db.get(id);
    } else {
      await ctx.db.patch(c._id, { lastAt: now, lastText: text.slice(0, 80), lastFrom: me._id, ...(c.a === me._id ? { readA: now } : { readB: now }) });
    }
    await ctx.db.insert("messages", { convoId: c._id, from: me._id, body: text, createdAt: now });
  },
});

export const markRead = mutation({
  args: { token: v.string(), userId: v.id("users") },
  handler: async (ctx, { token, userId }) => {
    const me = await currentUser(ctx, token);
    if (!me) return;
    const c = await ctx.db.query("convos").withIndex("by_key", (q) => q.eq("key", pairKey(me._id, userId))).unique();
    if (!c) return;
    const now = Date.now();
    if (c.a === me._id && c.readA < c.lastAt) await ctx.db.patch(c._id, { readA: now });
    if (c.b === me._id && c.readB < c.lastAt) await ctx.db.patch(c._id, { readB: now });
  },
});
