"use node";
// Sign up and log in. Runs in Convex's Node runtime so passwords can be hashed with scrypt.
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

const NAME_OK = /^[A-Za-z0-9_.]{3,20}$/;
const hash = (pw, salt) => scryptSync(pw, salt, 32).toString("hex");
const newToken = () => randomBytes(24).toString("hex");

export const signup = action({
  args: { name: v.string(), password: v.string(), avatar: v.number() },
  handler: async (ctx, { name, password, avatar }) => {
    name = name.trim();
    if (!NAME_OK.test(name)) throw new ConvexError("Usernames are 3 to 20 characters: letters, numbers, _ and . only.");
    if (password.length < 6) throw new ConvexError("Please use a password with at least 6 characters.");
    if (password.length > 200) throw new ConvexError("That password is too long.");
    const salt = randomBytes(16).toString("hex");
    const token = newToken();
    const userId = await ctx.runMutation(internal.users.create, {
      name, nameLower: name.toLowerCase(), passHash: hash(password, salt), salt, avatar: Math.max(0, Math.min(99, Math.floor(avatar))), token,
    });
    return { token, userId };
  },
});

export const login = action({
  args: { name: v.string(), password: v.string() },
  handler: async (ctx, { name, password }) => {
    const u = await ctx.runQuery(internal.users.forLogin, { nameLower: name.trim().toLowerCase() });
    const ok = u && timingSafeEqual(Buffer.from(hash(password, u.salt), "hex"), Buffer.from(u.passHash, "hex"));
    if (!ok) throw new ConvexError("That username and password don't match.");
    if (u.banned) throw new ConvexError("This account has been switched off by the admin.");
    const token = newToken();
    await ctx.runMutation(internal.users.newSession, { userId: u._id, token });
    return { token, userId: u._id };
  },
});
