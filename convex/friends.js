// Friend requests. You can only send private messages to friends.
import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { fail, currentUser, requireUser, brake, blockedEitherWay, publicUser, pairKey, friendState, unfriend } from "./lib";

const rowFor = (ctx, x, y) => ctx.db.query("friends").withIndex("by_key", (q) => q.eq("key", pairKey(x, y))).unique();
const convoFor = (ctx, x, y) => ctx.db.query("convos").withIndex("by_key", (q) => q.eq("key", pairKey(x, y))).unique();

// my friends, requests I received, requests I sent
export const list = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const me = await currentUser(ctx, token);
    if (!me) return null;
    const rows = [
      ...(await ctx.db.query("friends").withIndex("by_a", (q) => q.eq("a", me._id)).collect()),
      ...(await ctx.db.query("friends").withIndex("by_b", (q) => q.eq("b", me._id)).collect()),
    ];
    const friends = [], incoming = [], outgoing = [], seen = new Set();
    for (const r of rows) {
      const otherId = r.a === me._id ? r.b : r.a;
      seen.add(otherId);
      const o = await ctx.db.get(otherId);
      if (!o || o.banned || (await blockedEitherWay(ctx, me._id, otherId))) continue;
      const item = { ...publicUser(o), since: r.acceptedAt || r.createdAt };
      if (r.status === "friends") friends.push(item);
      else (r.from === me._id ? outgoing : incoming).push(item);
    }
    // people I already chatted with before friend requests existed
    const convos = [
      ...(await ctx.db.query("convos").withIndex("by_a", (q) => q.eq("a", me._id)).collect()),
      ...(await ctx.db.query("convos").withIndex("by_b", (q) => q.eq("b", me._id)).collect()),
    ];
    for (const c of convos) {
      const otherId = c.a === me._id ? c.b : c.a;
      if (c.unfriended || seen.has(otherId)) continue;
      seen.add(otherId);
      const o = await ctx.db.get(otherId);
      if (!o || o.banned || (await blockedEitherWay(ctx, me._id, otherId))) continue;
      friends.push({ ...publicUser(o), since: c._creationTime });
    }
    friends.sort((x, y) => x.name.localeCompare(y.name));
    incoming.sort((x, y) => y.since - x.since);
    return { friends, incoming, outgoing };
  },
});

export const status = query({
  args: { token: v.string(), userId: v.id("users") },
  handler: async (ctx, { token, userId }) => {
    const me = await currentUser(ctx, token);
    if (!me) return "none";
    if (me._id === userId) return "self";
    return friendState(ctx, me._id, userId);
  },
});

export const request = mutation({
  args: { token: v.string(), userId: v.id("users") },
  handler: async (ctx, { token, userId }) => {
    const me = await requireUser(ctx, token);
    if (userId === me._id) fail("You can't add yourself as a friend.");
    const other = await ctx.db.get(userId);
    if (!other || other.banned) fail("That person isn't on XPerience Online any more.");
    if (await blockedEitherWay(ctx, me._id, userId)) fail("You can't add this person.");
    const state = await friendState(ctx, me._id, userId);
    if (state === "friends" || state === "sent") return state;
    const row = await rowFor(ctx, me._id, userId);
    if (state === "received" && row) {
      // they already asked me, so this just accepts
      await ctx.db.patch(row._id, { status: "friends", acceptedAt: Date.now() });
      return "friends";
    }
    if (other.dmsFrom === "nobody") fail(`${other.name} isn't accepting friend requests right now.`);
    await brake(ctx, me);
    const [a, b] = me._id < userId ? [me._id, userId] : [userId, me._id];
    await ctx.db.insert("friends", { a, b, key: pairKey(a, b), from: me._id, status: "pending", createdAt: Date.now() });
    return "sent";
  },
});

export const accept = mutation({
  args: { token: v.string(), userId: v.id("users") },
  handler: async (ctx, { token, userId }) => {
    const me = await requireUser(ctx, token);
    const row = await rowFor(ctx, me._id, userId);
    if (!row || row.status !== "pending" || row.from !== userId) fail("That friend request isn't there any more.");
    if (await blockedEitherWay(ctx, me._id, userId)) fail("You can't add this person.");
    await ctx.db.patch(row._id, { status: "friends", acceptedAt: Date.now() });
    const c = await convoFor(ctx, me._id, userId);
    if (c && c.unfriended) await ctx.db.patch(c._id, { unfriended: false });
  },
});

// decline a request I got, cancel one I sent, or unfriend
export const remove = mutation({
  args: { token: v.string(), userId: v.id("users") },
  handler: async (ctx, { token, userId }) => {
    const me = await requireUser(ctx, token);
    await unfriend(ctx, me._id, userId);
  },
});

