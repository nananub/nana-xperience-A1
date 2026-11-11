// Picture uploads for signed-in people (forum posts, profile posts, profile pictures).
import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireUser, fail } from "./lib";

// the website asks for a one-time upload address, then sends the picture straight to Convex storage
export const uploadUrl = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const me = await requireUser(ctx, token);
    const now = Date.now(), recent = (me.upl || []).filter((t) => now - t < 60000);
    if (recent.length >= 20) fail("That's a lot of pictures! Wait a minute and try again.");
    await ctx.db.patch(me._id, { upl: [...recent, now] });
    return await ctx.storage.generateUploadUrl();
  },
});
