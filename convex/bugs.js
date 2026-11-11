// Report a Bug: anyone can send a bug report (with up to 3 screenshots); only the admin can read them.
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { fail, cleanText, currentUser, requireUser, isAdmin, brake } from "./lib";

const MAX_IMAGES = 3;
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB per picture
const STATUSES = ["new", "seen", "fixed"];

// step 1: the website asks for a one-time upload address, then sends the picture straight to Convex storage
export const uploadUrl = mutation({
  args: {},
  handler: async (ctx) => await ctx.storage.generateUploadUrl(),
});

// step 1b: throw away pictures that were uploaded but never sent (e.g. the person removed them)
export const discard = mutation({
  args: { images: v.array(v.id("_storage")) },
  handler: async (ctx, { images }) => {
    for (const id of images.slice(0, MAX_IMAGES)) {
      // only delete files that are not attached to a report yet
      const used = await ctx.db.query("bugs").withIndex("by_created").collect();
      if (used.some((b) => (b.images || []).includes(id))) continue;
      if (await ctx.db.system.get("_storage", id)) await ctx.storage.delete(id);
    }
  },
});

// step 2: send the report
export const submit = mutation({
  args: {
    token: v.optional(v.string()),
    guestName: v.optional(v.string()),
    title: v.string(),
    details: v.string(),
    where: v.optional(v.string()),
    images: v.optional(v.array(v.id("_storage"))),
    device: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const me = await currentUser(ctx, a.token);
    const images = a.images || [];
    // (if this fails, the website calls "discard" to remove the uploaded pictures, because a failed
    //  mutation undoes everything it did, including deleting files)
    const title = cleanText(a.title, 120, "short title");
    const details = cleanText(a.details, 3000, "description of the bug");
    if (images.length > MAX_IMAGES) fail(`You can attach up to ${MAX_IMAGES} pictures.`);
    for (const id of images) {
      const f = await ctx.db.system.get("_storage", id);
      if (!f) fail("One of the pictures did not upload. Please attach it again.");
      if (!/^image\//.test(f.contentType || "")) fail("Only pictures (PNG, JPG, GIF, WebP) can be attached.");
      if (f.size > MAX_BYTES) fail("One of the pictures is too big (max 5 MB each).");
    }
    // spam brakes: per account, and for everyone together
    if (me) await brake(ctx, me);
    const lastMinute = await ctx.db.query("bugs").withIndex("by_created", (q) => q.gt("createdAt", Date.now() - 60000)).collect();
    if (lastMinute.length >= 10) fail("Lots of reports are coming in right now. Please try again in a minute.");
    const guest = String(a.guestName || "").trim().slice(0, 30);
    return await ctx.db.insert("bugs", {
      ...(me ? { byId: me._id } : {}),
      byName: me ? me.name : guest || "Guest",
      title,
      details,
      where: String(a.where || "").slice(0, 40),
      images,
      device: String(a.device || "").slice(0, 200),
      status: "new",
      createdAt: Date.now(),
    });
  },
});

// ---- admin only ----
async function requireAdmin(ctx, token) {
  const me = await requireUser(ctx, token);
  if (!isAdmin(me)) fail("Only the admin can see bug reports.");
  return me;
}

export const list = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireAdmin(ctx, token);
    const rows = await ctx.db.query("bugs").withIndex("by_created").order("desc").take(200);
    return await Promise.all(rows.map(async (b) => ({
      id: b._id, byName: b.byName, signedIn: !!b.byId, title: b.title, details: b.details, where: b.where,
      device: b.device, status: b.status, createdAt: b.createdAt,
      images: (await Promise.all((b.images || []).map((id) => ctx.storage.getUrl(id)))).filter(Boolean),
    })));
  },
});

// how many unread reports (for the admin's notification); returns 0 for everyone else
export const newCount = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const me = await currentUser(ctx, token);
    if (!isAdmin(me)) return 0;
    const rows = await ctx.db.query("bugs").withIndex("by_created").order("desc").take(200);
    return rows.filter((b) => b.status === "new").length;
  },
});

export const setStatus = mutation({
  args: { token: v.string(), id: v.string(), status: v.string() },
  handler: async (ctx, { token, id, status }) => {
    await requireAdmin(ctx, token);
    const bid = ctx.db.normalizeId("bugs", id);
    if (!bid || !(await ctx.db.get(bid))) fail("That report no longer exists.");
    if (!STATUSES.includes(status)) fail("Unknown status.");
    await ctx.db.patch(bid, { status });
  },
});

export const remove = mutation({
  args: { token: v.string(), id: v.string() },
  handler: async (ctx, { token, id }) => {
    await requireAdmin(ctx, token);
    const bid = ctx.db.normalizeId("bugs", id);
    const b = bid && (await ctx.db.get(bid));
    if (!b) return;
    for (const img of b.images || []) if (await ctx.db.system.get("_storage", img)) await ctx.storage.delete(img);
    await ctx.db.delete(bid);
  },
});
