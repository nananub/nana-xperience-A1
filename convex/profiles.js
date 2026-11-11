// Decorated profiles with photo posts, likes and comments.
import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import {
  fail, cleanText, currentUser, requireUser, isAdmin, brake, blockedEitherWay, blockedSet, publicUser,
  LIMITS, friendState, claimImages, dropImages,
} from "./lib";

const THEMES = ["sky", "bubblegum", "emo", "watermelon", "duck", "mint", "midnight", "sunset", "lavender", "forest"];
const PATTERNS = ["none", "stars", "hearts", "checker", "dots", "stripes", "sparkle", "grid"];
const FONTS = ["classic", "comic", "pixel", "typewriter", "gothic"];

const short = (s, max) => String(s || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);

async function canSeePosts(ctx, viewer, author) {
  if (!author || author.banned) return false;
  if (viewer && viewer._id === author._id) return true;
  if (viewer && (await blockedEitherWay(ctx, viewer._id, author._id))) return false;
  if ((author.postsFor || "everyone") === "everyone") return true;
  return !!viewer && (await friendState(ctx, viewer._id, author._id)) === "friends";
}

async function friendCount(ctx, userId) {
  const a = await ctx.db.query("friends").withIndex("by_a", (q) => q.eq("a", userId)).collect();
  const b = await ctx.db.query("friends").withIndex("by_b", (q) => q.eq("b", userId)).collect();
  const others = new Set([...a, ...b].filter((r) => r.status === "friends").map((r) => (r.a === userId ? r.b : r.a)));
  const ca = await ctx.db.query("convos").withIndex("by_a", (q) => q.eq("a", userId)).collect();
  const cb = await ctx.db.query("convos").withIndex("by_b", (q) => q.eq("b", userId)).collect();
  const pending = new Set([...a, ...b].map((r) => (r.a === userId ? r.b : r.a)));
  for (const c of [...ca, ...cb]) { const o = c.a === userId ? c.b : c.a; if (!c.unfriended && !pending.has(o)) others.add(o); }
  return others.size;
}

async function postOut(ctx, p, viewer, author) {
  const liked = viewer ? !!(await ctx.db.query("plikes").withIndex("by_post_user", (q) => q.eq("postId", p._id).eq("userId", viewer._id)).first()) : false;
  return {
    id: p._id, image: p.image.url, caption: p.caption, createdAt: p.createdAt, likes: p.likeCount, comments: p.commentCount, liked,
    author: publicUser(author), canDelete: !!viewer && (p.authorId === viewer._id || isAdmin(viewer)),
  };
}

// ---------- profile ----------
export const get = query({
  args: { token: v.optional(v.string()), userId: v.id("users") },
  handler: async (ctx, { token, userId }) => {
    const viewer = await currentUser(ctx, token);
    const u = await ctx.db.get(userId);
    if (!u || u.banned) return null;
    const self = !!viewer && viewer._id === u._id;
    const blocked = !!viewer && !self && (await blockedEitherWay(ctx, viewer._id, u._id));
    const iBlocked = blocked && !!(await ctx.db.query("blocks").withIndex("by_pair", (q) => q.eq("by", viewer._id).eq("who", u._id)).first());
    const base = { ...publicUser(u), self, blocked, iBlocked, admin: isAdmin(viewer) };
    if (blocked) return base;
    const visible = await canSeePosts(ctx, viewer, u);
    let postCount = 0;
    if (visible) postCount = (await ctx.db.query("pposts").withIndex("by_author", (q) => q.eq("authorId", u._id)).collect()).filter((p) => !p.hidden).length;
    return {
      ...base,
      friend: self ? "self" : viewer ? await friendState(ctx, viewer._id, u._id) : "none",
      acceptsRequests: u.dmsFrom !== "nobody",
      banner: u.bannerUrl || null, song: u.song || "", interests: u.interests || "",
      theme: u.theme || "sky", pattern: u.pattern || "none", font: u.font || "classic", stickers: u.stickers || [],
      postsFor: u.postsFor || "everyone", dmsFrom: u.dmsFrom,
      postsVisible: visible, postCount, friendCount: await friendCount(ctx, u._id),
    };
  },
});

export const update = mutation({
  args: {
    token: v.string(),
    bio: v.optional(v.string()), mood: v.optional(v.string()), song: v.optional(v.string()), interests: v.optional(v.string()),
    theme: v.optional(v.string()), pattern: v.optional(v.string()), font: v.optional(v.string()),
    stickers: v.optional(v.array(v.string())), avatar: v.optional(v.number()),
    postsFor: v.optional(v.string()), dmsFrom: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const me = await requireUser(ctx, a.token);
    const p = {};
    if (a.bio !== undefined) { const b = String(a.bio).trim(); if (b.length > LIMITS.bio) fail(`Your bio can be up to ${LIMITS.bio} characters.`); p.bio = b; }
    if (a.mood !== undefined) p.mood = short(a.mood, LIMITS.mood);
    if (a.song !== undefined) p.song = short(a.song, LIMITS.song);
    if (a.interests !== undefined) p.interests = short(a.interests, LIMITS.interests);
    if (a.theme !== undefined) p.theme = THEMES.includes(a.theme) ? a.theme : "sky";
    if (a.pattern !== undefined) p.pattern = PATTERNS.includes(a.pattern) ? a.pattern : "none";
    if (a.font !== undefined) p.font = FONTS.includes(a.font) ? a.font : "classic";
    if (a.stickers !== undefined) p.stickers = a.stickers.slice(0, 8).map((s) => short(s, 8)).filter(Boolean);
    if (a.avatar !== undefined) p.avatar = Math.max(0, Math.min(99, Math.floor(a.avatar)));
    if (a.postsFor !== undefined) p.postsFor = a.postsFor === "friends" ? "friends" : "everyone";
    if (a.dmsFrom !== undefined) p.dmsFrom = a.dmsFrom === "nobody" ? "nobody" : "everyone";
    await ctx.db.patch(me._id, p);
  },
});

// set or remove my profile picture / cover picture (image = null removes it)
export const setPicture = mutation({
  args: { token: v.string(), kind: v.union(v.literal("photo"), v.literal("banner")), image: v.union(v.id("_storage"), v.null()) },
  handler: async (ctx, { token, kind, image }) => {
    const me = await requireUser(ctx, token);
    const old = kind === "photo" ? me.photoId : me.bannerId;
    const pic = image ? (await claimImages(ctx, me, [image], 1))[0] : null;
    await ctx.db.patch(me._id, kind === "photo"
      ? { photoId: pic ? pic.id : undefined, photoUrl: pic ? pic.url : undefined }
      : { bannerId: pic ? pic.id : undefined, bannerUrl: pic ? pic.url : undefined });
    if (old) await dropImages(ctx, [old]);
  },
});

// ---------- photo posts ----------
export const posts = query({
  args: { token: v.optional(v.string()), userId: v.id("users") },
  handler: async (ctx, { token, userId }) => {
    const viewer = await currentUser(ctx, token);
    const u = await ctx.db.get(userId);
    if (!(await canSeePosts(ctx, viewer, u))) return [];
    const rows = await ctx.db.query("pposts").withIndex("by_author", (q) => q.eq("authorId", userId)).order("desc").take(90);
    const out = [];
    for (const p of rows) if (!p.hidden) out.push(await postOut(ctx, p, viewer, u));
    return out;
  },
});

// the scrolling feed: "friends" (me + my friends) or "everyone"
export const feed = query({
  args: { token: v.string(), scope: v.optional(v.string()) },
  handler: async (ctx, { token, scope }) => {
    const me = await currentUser(ctx, token);
    if (!me) return null;
    const hide = await blockedSet(ctx, me);
    const rows = await ctx.db.query("pposts").withIndex("by_created").order("desc").take(200);
    const authors = new Map(), friendOk = new Map(), out = [];
    for (const p of rows) {
      if (out.length >= 40) break;
      if (p.hidden || hide.has(p.authorId)) continue;
      if (!authors.has(p.authorId)) authors.set(p.authorId, await ctx.db.get(p.authorId));
      const a = authors.get(p.authorId);
      if (!a || a.banned) continue;
      if (!friendOk.has(p.authorId)) friendOk.set(p.authorId, p.authorId === me._id || (await friendState(ctx, me._id, p.authorId)) === "friends");
      const isFriend = friendOk.get(p.authorId);
      if (scope === "friends" && !isFriend) continue;
      if (!isFriend && (a.postsFor || "everyone") === "friends") continue;
      if (await blockedEitherWay(ctx, me._id, p.authorId)) continue;
      out.push(await postOut(ctx, p, me, a));
    }
    return out;
  },
});

export const getPost = query({
  args: { token: v.optional(v.string()), postId: v.string() },
  handler: async (ctx, { token, postId }) => {
    const viewer = await currentUser(ctx, token);
    const id = ctx.db.normalizeId("pposts", postId);
    const p = id && (await ctx.db.get(id));
    if (!p || p.hidden) return null;
    const author = await ctx.db.get(p.authorId);
    if (!(await canSeePosts(ctx, viewer, author))) return null;
    const hide = await blockedSet(ctx, viewer);
    const admin = isAdmin(viewer);
    const rows = await ctx.db.query("pcomments").withIndex("by_post", (q) => q.eq("postId", p._id)).take(300);
    const comments = [];
    for (const c of rows) {
      if (c.hidden || hide.has(c.authorId)) continue;
      const a = await ctx.db.get(c.authorId);
      if (!a || a.banned) continue;
      comments.push({ id: c._id, body: c.body, createdAt: c.createdAt, author: publicUser(a), canDelete: !!viewer && (c.authorId === viewer._id || p.authorId === viewer._id || admin) });
    }
    return { ...(await postOut(ctx, p, viewer, author)), commentList: comments, signedIn: !!viewer };
  },
});

export const createPost = mutation({
  args: { token: v.string(), image: v.id("_storage"), caption: v.string() },
  handler: async (ctx, { token, image, caption }) => {
    const me = await requireUser(ctx, token);
    const cap = String(caption || "").trim();
    if (cap.length > LIMITS.caption) fail(`Captions can be up to ${LIMITS.caption} characters.`);
    await brake(ctx, me);
    const [pic] = await claimImages(ctx, me, [image], 1);
    return ctx.db.insert("pposts", { authorId: me._id, image: pic, caption: cap, createdAt: Date.now(), likeCount: 0, commentCount: 0 });
  },
});

async function viewablePost(ctx, me, postId) {
  const p = await ctx.db.get(postId);
  if (!p || p.hidden) fail("That post isn't there any more.");
  if (!(await canSeePosts(ctx, me, await ctx.db.get(p.authorId)))) fail("You can't see this post.");
  return p;
}

// like / unlike; returns true when it is now liked
export const like = mutation({
  args: { token: v.string(), postId: v.id("pposts") },
  handler: async (ctx, { token, postId }) => {
    const me = await requireUser(ctx, token);
    const p = await viewablePost(ctx, me, postId);
    const has = await ctx.db.query("plikes").withIndex("by_post_user", (q) => q.eq("postId", postId).eq("userId", me._id)).first();
    if (has) { await ctx.db.delete(has._id); await ctx.db.patch(postId, { likeCount: Math.max(0, p.likeCount - 1) }); return false; }
    await ctx.db.insert("plikes", { postId, userId: me._id });
    await ctx.db.patch(postId, { likeCount: p.likeCount + 1 });
    return true;
  },
});

export const comment = mutation({
  args: { token: v.string(), postId: v.id("pposts"), body: v.string() },
  handler: async (ctx, { token, postId, body }) => {
    const me = await requireUser(ctx, token);
    const p = await viewablePost(ctx, me, postId);
    const b = cleanText(body, LIMITS.comment, "comment");
    await brake(ctx, me);
    await ctx.db.insert("pcomments", { postId, authorId: me._id, body: b, createdAt: Date.now() });
    await ctx.db.patch(postId, { commentCount: p.commentCount + 1 });
  },
});

export const removePost = mutation({
  args: { token: v.string(), postId: v.string() },
  handler: async (ctx, { token, postId }) => {
    const me = await requireUser(ctx, token);
    const id = ctx.db.normalizeId("pposts", postId);
    const p = id && (await ctx.db.get(id));
    if (!p || p.hidden) return;
    if (p.authorId !== me._id && !isAdmin(me)) fail("You can only delete your own posts.");
    await ctx.db.patch(p._id, { hidden: true });
    await dropImages(ctx, [p.image.id]);
  },
});

export const removeComment = mutation({
  args: { token: v.string(), commentId: v.string() },
  handler: async (ctx, { token, commentId }) => {
    const me = await requireUser(ctx, token);
    const id = ctx.db.normalizeId("pcomments", commentId);
    const c = id && (await ctx.db.get(id));
    if (!c || c.hidden) return;
    const p = await ctx.db.get(c.postId);
    if (c.authorId !== me._id && (!p || p.authorId !== me._id) && !isAdmin(me)) fail("You can't delete this comment.");
    await ctx.db.patch(c._id, { hidden: true });
    if (p) await ctx.db.patch(p._id, { commentCount: Math.max(0, p.commentCount - 1) });
  },
});
