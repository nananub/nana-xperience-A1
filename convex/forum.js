// The public message board.
import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { fail, cleanText, currentUser, requireUser, isAdmin, brake, blockedSet, publicUser, LIMITS, BOARDS, claimImages, dropImages, notify, notifyMentions, toggleCommentLike, likedByMe } from "./lib";

export const listPosts = query({
  args: { token: v.optional(v.string()), board: v.optional(v.string()) },
  handler: async (ctx, { token, board }) => {
    const me = await currentUser(ctx, token);
    const hide = await blockedSet(ctx, me);
    const rows = board && BOARDS.includes(board)
      ? await ctx.db.query("posts").withIndex("by_board_last", (q) => q.eq("board", board)).order("desc").take(60)
      : await ctx.db.query("posts").withIndex("by_last").order("desc").take(60);
    const out = [];
    for (const p of rows) {
      if (p.hidden || hide.has(p.authorId)) continue;
      const a = await ctx.db.get(p.authorId);
      if (!a || a.banned) continue;
      out.push({ id: p._id, board: p.board, title: p.title, preview: p.body.slice(0, 140), createdAt: p.createdAt, lastAt: p.lastAt, replyCount: p.replyCount, author: publicUser(a), mine: !!me && p.authorId === me._id, thumb: p.images && p.images.length ? p.images[0].url : null, pics: (p.images || []).length });
    }
    return out;
  },
});

export const getPost = query({
  args: { token: v.optional(v.string()), postId: v.id("posts") },
  handler: async (ctx, { token, postId }) => {
    const me = await currentUser(ctx, token);
    const p = await ctx.db.get(postId);
    if (!p || p.hidden) return null;
    const hide = await blockedSet(ctx, me);
    const admin = isAdmin(me);
    const reps = await ctx.db.query("replies").withIndex("by_post", (q) => q.eq("postId", postId)).take(300);
    const replies = [];
    for (const r of reps) {
      if (r.hidden || hide.has(r.authorId)) continue;
      const a = await ctx.db.get(r.authorId);
      if (!a || a.banned) continue;
      replies.push({ id: r._id, parentId: r.parentId || null, likes: r.likeCount || 0, liked: await likedByMe(ctx, me, r._id), body: r.body, images: (r.images || []).map((i) => i.url), createdAt: r.createdAt, author: publicUser(a), canDelete: !!me && (r.authorId === me._id || admin) });
    }
    const author = await ctx.db.get(p.authorId);
    return { id: p._id, board: p.board, title: p.title, body: p.body, images: (p.images || []).map((i) => i.url), createdAt: p.createdAt, author: publicUser(author), canDelete: !!me && (p.authorId === me._id || admin), replies, admin };
  },
});

export const createPost = mutation({
  args: { token: v.string(), board: v.string(), title: v.string(), body: v.string(), images: v.optional(v.array(v.id("_storage"))) },
  handler: async (ctx, { token, board, title, body, images }) => {
    const me = await requireUser(ctx, token);
    if (!BOARDS.includes(board)) fail("Please pick a board.");
    const hasPics = images && images.length;
    const t = cleanText(title, LIMITS.title, "title"), b = hasPics && !String(body || "").trim() ? "" : cleanText(body, LIMITS.post, "post");
    await brake(ctx, me);
    const pics = await claimImages(ctx, me, images, 4);
    const now = Date.now();
    const id = await ctx.db.insert("posts", { authorId: me._id, board, title: t, body: b, createdAt: now, lastAt: now, replyCount: 0, images: pics });
    await notifyMentions(ctx, me, t + " " + b, { type: "fpost", id });
    return id;
  },
});

export const reply = mutation({
  args: { token: v.string(), postId: v.id("posts"), body: v.string(), images: v.optional(v.array(v.id("_storage"))), parentId: v.optional(v.string()) },
  handler: async (ctx, { token, postId, body, images, parentId }) => {
    const me = await requireUser(ctx, token);
    const p = await ctx.db.get(postId);
    if (!p || p.hidden) fail("That post is gone.");
    const b = images && images.length && !String(body || "").trim() ? "" : cleanText(body, LIMITS.reply, "reply");
    await brake(ctx, me);
    let parent = null;
    if (parentId) {
      const pid = ctx.db.normalizeId("replies", parentId);
      parent = pid && (await ctx.db.get(pid));
      if (!parent || parent.hidden || parent.postId !== postId) fail("The reply you're answering was deleted.");
    }
    const pics = await claimImages(ctx, me, images, 2);
    const now = Date.now();
    const top = parent && parent.parentId ? parent.parentId : parent && parent._id;
    await ctx.db.insert("replies", { postId, authorId: me._id, body: b, createdAt: now, images: pics, ...(top ? { parentId: top } : {}) });
    await ctx.db.patch(postId, { lastAt: now, replyCount: p.replyCount + 1 });
    const target = { type: "fpost", id: postId }, done = [me._id];
    if (await notify(ctx, p.authorId, me, "freply", b || "(picture)", target)) done.push(p.authorId);
    if (parent && !done.includes(parent.authorId) && (await notify(ctx, parent.authorId, me, "reply", b || "(picture)", target))) done.push(parent.authorId);
    await notifyMentions(ctx, me, b, target, done);
  },
});

// remove your own post/reply (the admin can remove anyone's)
export const remove = mutation({
  args: { token: v.string(), kind: v.union(v.literal("post"), v.literal("reply")), id: v.string() },
  handler: async (ctx, { token, kind, id }) => {
    const me = await requireUser(ctx, token);
    const nid = ctx.db.normalizeId(kind === "post" ? "posts" : "replies", id);
    const row = nid && (await ctx.db.get(nid));
    if (!row) fail("It's already gone.");
    if (row.authorId !== me._id && !isAdmin(me)) fail("You can only delete your own posts.");
    await ctx.db.patch(row._id, { hidden: true, images: [] });
    await dropImages(ctx, (row.images || []).map((i) => i.id));
    if (kind === "reply") { const p = await ctx.db.get(row.postId); if (p) await ctx.db.patch(p._id, { replyCount: Math.max(0, p.replyCount - 1) }); }
  },
});

// like / unlike a reply
export const likeReply = mutation({
  args: { token: v.string(), replyId: v.string() },
  handler: async (ctx, { token, replyId }) => {
    const me = await requireUser(ctx, token);
    const id = ctx.db.normalizeId("replies", replyId);
    const r = id && (await ctx.db.get(id));
    if (!r || r.hidden) fail("That reply was deleted.");
    const on = await toggleCommentLike(ctx, me, r);
    if (on) await notify(ctx, r.authorId, me, "clike", r.body || "(picture)", { type: "fpost", id: r.postId });
    return on;
  },
});
