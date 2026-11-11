// Shared helpers for the online functions (not callable from the website on their own).
import { ConvexError } from "convex/values";

export const LIMITS = { name: [3, 20], password: 6, title: 120, post: 3000, reply: 2000, message: 1000, bio: 200, reason: 300, caption: 500, comment: 500, mood: 40, song: 80, interests: 160 };
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
  return { id: u._id, name: u.name, avatar: u.avatar, photo: u.photoUrl || null, mood: u.mood || "", bio: u.bio, createdAt: u.createdAt };
}

// ---- friends ----
export const pairKey = (x, y) => (x < y ? `${x}|${y}` : `${y}|${x}`);

// "none" | "sent" (I asked them) | "received" (they asked me) | "friends"
// People who already had a chat before friend requests existed count as friends.
export async function friendState(ctx, meId, otherId) {
  if (!meId || !otherId || meId === otherId) return "none";
  const key = pairKey(meId, otherId);
  const f = await ctx.db.query("friends").withIndex("by_key", (q) => q.eq("key", key)).unique();
  if (f) return f.status === "friends" ? "friends" : f.from === meId ? "sent" : "received";
  const c = await ctx.db.query("convos").withIndex("by_key", (q) => q.eq("key", key)).unique();
  return c && !c.unfriended ? "friends" : "none";
}

// remove a friendship or request (both directions); old chats stop counting as friends too
export async function unfriend(ctx, x, y) {
  const key = pairKey(x, y);
  const row = await ctx.db.query("friends").withIndex("by_key", (q) => q.eq("key", key)).unique();
  if (row) await ctx.db.delete(row._id);
  const c = await ctx.db.query("convos").withIndex("by_key", (q) => q.eq("key", key)).unique();
  if (c && !c.unfriended) await ctx.db.patch(c._id, { unfriended: true });
}

// ---- pictures (stored in Convex file storage) ----
const MAX_IMG = 5 * 1024 * 1024;
// check that each uploaded file is a picture, is not too big, and was not already used somewhere else
export async function claimImages(ctx, me, ids, max) {
  ids = ids || [];
  if (ids.length > max) fail(`You can add up to ${max} picture${max === 1 ? "" : "s"}.`);
  if (new Set(ids).size !== ids.length) fail("The same picture was added twice.");
  const out = [];
  for (const id of ids) {
    const f = await ctx.db.system.get("_storage", id);
    if (!f) fail("A picture did not upload properly. Please add it again.");
    if (!/^image\/(png|jpeg|gif|webp)$/.test(f.contentType || "")) fail("Only pictures (PNG, JPG, GIF or WebP) can be added.");
    if (f.size > MAX_IMG) fail("That picture is too big (max 5 MB).");
    const used = await ctx.db.query("uploads").withIndex("by_storage", (q) => q.eq("storageId", id)).first();
    if (used) fail("That picture was already used. Please add it again.");
    await ctx.db.insert("uploads", { storageId: id, by: me._id, createdAt: Date.now() });
    out.push({ id, url: await ctx.storage.getUrl(id) });
  }
  return out;
}
export async function dropImages(ctx, ids) {
  for (const id of ids || []) if (await ctx.db.system.get("_storage", id)) await ctx.storage.delete(id);
}
