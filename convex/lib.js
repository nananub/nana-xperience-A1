// Shared helpers for the online functions (not callable from the website on their own).
import { ConvexError } from "convex/values";

export const LIMITS = { name: [3, 20], password: 6, title: 120, post: 3000, reply: 2000, message: 1000, bio: 200, reason: 300 };
export const BOARDS = ["general", "music", "art", "games", "help"];

export function fail(msg) { throw new ConvexError(msg); }

export function cleanText(s, max, what) {
  const t = String(s || "").replace(/\r\n/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
  if (!t) fail(`Please write a ${what} first.`);
  if (t.length > max) fail(`That ${what} is too long (max ${max} characters).`);
  return t;
}

export function isAdmin(user) {
  const list = String(process.env.ADMIN_USERS || "").toLowerCase().split(",").map((x) => x.trim()).filter(Boolean);
  return !!user && list.includes(user.nameLower);
}

// who is signed in? (token comes from the website after logging in)
export async function currentUser(ctx, token) {
  if (!token || typeof token !== "string") return null;
  const s = await ctx.db.query("sessions").withIndex("by_token", (q) => q.eq("token", token)).unique();
  if (!s) return null;
  const u = await ctx.db.get(s.userId);
  if (!u || u.banned) return null;
  return u;
}
export async function requireUser(ctx, token) {
  const u = await currentUser(ctx, token);
  if (!u) fail("Please sign in to XPerience Online again.");
  return u;
}

// simple spam brake: at most 8 posts/replies/messages in 30 seconds
export async function brake(ctx, user) {
  const now = Date.now();
  const recent = (user.recent || []).filter((t) => now - t < 30000);
  if (recent.length >= 8) fail("Whoa, slow down a little! Try again in a few seconds.");
  recent.push(now);
  await ctx.db.patch(user._id, { recent });
}

export async function blockedEitherWay(ctx, a, b) {
  const x = await ctx.db.query("blocks").withIndex("by_pair", (q) => q.eq("by", a).eq("who", b)).first();
  if (x) return true;
  const y = await ctx.db.query("blocks").withIndex("by_pair", (q) => q.eq("by", b).eq("who", a)).first();
  return !!y;
}

export async function blockedSet(ctx, me) {
  if (!me) return new Set();
  const rows = await ctx.db.query("blocks").withIndex("by_by", (q) => q.eq("by", me._id)).collect();
  return new Set(rows.map((r) => r.who));
}

export function publicUser(u) {
  if (!u) return { id: null, name: "[deleted]", avatar: 0, bio: "" };
  return { id: u._id, name: u.name, avatar: u.avatar, bio: u.bio, createdAt: u.createdAt };
}
