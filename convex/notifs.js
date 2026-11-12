// Notifications: tags, replies, comments and likes.
import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { currentUser, publicUser, blockedSet } from "./lib";

async function rows(ctx, me, n) {
  const hide = await blockedSet(ctx, me);
  const list = await ctx.db.query("notifs").withIndex("by_user", (q) => q.eq("userId", me._id)).order("desc").take(n);
  const out = [];
  for (const x of list) {
    if (hide.has(x.fromId)) continue;
    const f = await ctx.db.get(x.fromId);
    if (!f || f.banned) continue;
    out.push({ id: x._id, kind: x.kind, text: x.text, target: x.target, at: x.createdAt, read: x.read, from: publicUser(f) });
  }
  return out;
}

export const list = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const me = await currentUser(ctx, token);
    return me ? rows(ctx, me, 50) : null;
  },
});

// newest unread ones (for pop-ups and the 🔔 count)
export const unread = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const me = await currentUser(ctx, token);
    if (!me) return null;
    return (await rows(ctx, me, 40)).filter((x) => !x.read);
  },
});

export const markAllRead = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const me = await currentUser(ctx, token);
    if (!me) return;
    const list = await ctx.db.query("notifs").withIndex("by_user", (q) => q.eq("userId", me._id)).order("desc").take(100);
    for (const x of list) if (!x.read) await ctx.db.patch(x._id, { read: true });
  },
});
