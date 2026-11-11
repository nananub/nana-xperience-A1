// Accounts, profiles, finding people, blocking and reporting.
import { query, mutation, internalQuery, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { fail, cleanText, currentUser, requireUser, isAdmin, publicUser, LIMITS } from "./lib";

// ---- used only by accounts.js (not reachable from the website) ----
export const create = internalMutation({
  args: { name: v.string(), nameLower: v.string(), passHash: v.string(), salt: v.string(), avatar: v.number(), token: v.string() },
  handler: async (ctx, a) => {
    const taken = await ctx.db.query("users").withIndex("by_name", (q) => q.eq("nameLower", a.nameLower)).unique();
    if (taken) fail("Sorry, that username is taken. Try another one!");
    const userId = await ctx.db.insert("users", {
      name: a.name, nameLower: a.nameLower, passHash: a.passHash, salt: a.salt, avatar: a.avatar,
      bio: "", dmsFrom: "everyone", createdAt: Date.now(), recent: [],
    });
    await ctx.db.insert("sessions", { userId, token: a.token, createdAt: Date.now() });
    return userId;
  },
});
export const forLogin = internalQuery({
  args: { nameLower: v.string() },
  handler: async (ctx, { nameLower }) => ctx.db.query("users").withIndex("by_name", (q) => q.eq("nameLower", nameLower)).unique(),
});
export const newSession = internalMutation({
  args: { userId: v.id("users"), token: v.string() },
  handler: async (ctx, { userId, token }) => { await ctx.db.insert("sessions", { userId, token, createdAt: Date.now() }); },
});

// ---- called from the website ----
export const me = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const u = await currentUser(ctx, token);
    if (!u) return null;
    return { ...publicUser(u), dmsFrom: u.dmsFrom, admin: isAdmin(u) };
  },
});

export const logout = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const s = await ctx.db.query("sessions").withIndex("by_token", (q) => q.eq("token", token)).unique();
    if (s) await ctx.db.delete(s._id);
  },
});

export const updateProfile = mutation({
  args: { token: v.string(), bio: v.optional(v.string()), avatar: v.optional(v.number()), dmsFrom: v.optional(v.union(v.literal("everyone"), v.literal("nobody"))) },
  handler: async (ctx, { token, bio, avatar, dmsFrom }) => {
    const u = await requireUser(ctx, token);
    const patch = {};
    if (bio !== undefined) { const b = String(bio).trim(); if (b.length > LIMITS.bio) fail(`Your bio can be up to ${LIMITS.bio} characters.`); patch.bio = b; }
    if (avatar !== undefined) patch.avatar = Math.max(0, Math.min(99, Math.floor(avatar)));
    if (dmsFrom !== undefined) patch.dmsFrom = dmsFrom;
    await ctx.db.patch(u._id, patch);
  },
});

// find people by the start of their username
export const search = query({
  args: { token: v.string(), q: v.string() },
  handler: async (ctx, { token, q }) => {
    const me = await requireUser(ctx, token);
    const p = q.trim().toLowerCase();
    if (p.length < 1) return [];
    const rows = await ctx.db.query("users").withIndex("by_name", (x) => x.gte("nameLower", p).lt("nameLower", p + "￿")).take(15);
    return rows.filter((u) => u._id !== me._id && !u.banned).map(publicUser);
  },
});

export const profile = query({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const u = await ctx.db.get(userId);
    if (!u || u.banned) return null;
    return publicUser(u);
  },
});

export const block = mutation({
  args: { token: v.string(), userId: v.id("users") },
  handler: async (ctx, { token, userId }) => {
    const me = await requireUser(ctx, token);
    if (userId === me._id) fail("You can't block yourself.");
    const has = await ctx.db.query("blocks").withIndex("by_pair", (q) => q.eq("by", me._id).eq("who", userId)).first();
    if (!has) await ctx.db.insert("blocks", { by: me._id, who: userId });
  },
});
export const unblock = mutation({
  args: { token: v.string(), userId: v.id("users") },
  handler: async (ctx, { token, userId }) => {
    const me = await requireUser(ctx, token);
    const has = await ctx.db.query("blocks").withIndex("by_pair", (q) => q.eq("by", me._id).eq("who", userId)).first();
    if (has) await ctx.db.delete(has._id);
  },
});
export const myBlocks = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const me = await currentUser(ctx, token);
    if (!me) return [];
    const rows = await ctx.db.query("blocks").withIndex("by_by", (q) => q.eq("by", me._id)).collect();
    return Promise.all(rows.map(async (r) => publicUser(await ctx.db.get(r.who))));
  },
});

export const report = mutation({
  args: { token: v.string(), kind: v.union(v.literal("post"), v.literal("reply"), v.literal("user"), v.literal("message")), targetId: v.string(), reason: v.string() },
  handler: async (ctx, { token, kind, targetId, reason }) => {
    const me = await requireUser(ctx, token);
    await ctx.db.insert("reports", { by: me._id, kind, targetId, reason: cleanText(reason, LIMITS.reason, "reason"), createdAt: Date.now() });
  },
});

// ---- admin only (usernames listed in the ADMIN_USERS setting on Convex) ----
export const reports = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const me = await currentUser(ctx, token);
    if (!isAdmin(me)) return [];
    const rows = await ctx.db.query("reports").withIndex("by_created").order("desc").take(50);
    return Promise.all(rows.filter((r) => !r.done).map(async (r) => ({ ...r, byName: publicUser(await ctx.db.get(r.by)).name })));
  },
});
export const closeReport = mutation({
  args: { token: v.string(), reportId: v.id("reports") },
  handler: async (ctx, { token, reportId }) => {
    const me = await requireUser(ctx, token);
    if (!isAdmin(me)) fail("Only the admin can do that.");
    await ctx.db.patch(reportId, { done: true });
  },
});
export const ban = mutation({
  args: { token: v.string(), userId: v.id("users") },
  handler: async (ctx, { token, userId }) => {
    const me = await requireUser(ctx, token);
    if (!isAdmin(me)) fail("Only the admin can do that.");
    if (userId === me._id) fail("You can't ban yourself.");
    await ctx.db.patch(userId, { banned: true });
    const ss = await ctx.db.query("sessions").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
    for (const s of ss) await ctx.db.delete(s._id);
  },
});
