// XPerience Online: what the online database stores.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // one row per online account (separate from the local "log on" profiles)
  users: defineTable({
    name: v.string(),            // how it is shown, e.g. "Kael_2006"
    nameLower: v.string(),       // for finding people and keeping names unique
    passHash: v.string(),        // scrypt hash, never the password itself
    salt: v.string(),
    avatar: v.number(),
    bio: v.string(),
    dmsFrom: v.union(v.literal("everyone"), v.literal("nobody")),
    createdAt: v.number(),
    banned: v.optional(v.boolean()),
    recent: v.optional(v.array(v.number())), // times of the last few posts/messages (spam brake)
  }).index("by_name", ["nameLower"]),

  sessions: defineTable({ userId: v.id("users"), token: v.string(), createdAt: v.number() })
    .index("by_token", ["token"])
    .index("by_user", ["userId"]),

  posts: defineTable({
    authorId: v.id("users"),
    board: v.string(),
    title: v.string(),
    body: v.string(),
    createdAt: v.number(),
    lastAt: v.number(),
    replyCount: v.number(),
    hidden: v.optional(v.boolean()),
  }).index("by_last", ["lastAt"]).index("by_board_last", ["board", "lastAt"]),

  replies: defineTable({
    postId: v.id("posts"),
    authorId: v.id("users"),
    body: v.string(),
    createdAt: v.number(),
    hidden: v.optional(v.boolean()),
  }).index("by_post", ["postId", "createdAt"]),

  // a private conversation between two people (a = smaller id, b = bigger id)
  convos: defineTable({
    a: v.id("users"),
    b: v.id("users"),
    key: v.string(),
    lastAt: v.number(),
    lastText: v.string(),
    lastFrom: v.id("users"),
    readA: v.number(),
    readB: v.number(),
  }).index("by_key", ["key"]).index("by_a", ["a", "lastAt"]).index("by_b", ["b", "lastAt"]),

  messages: defineTable({ convoId: v.id("convos"), from: v.id("users"), body: v.string(), createdAt: v.number() })
    .index("by_convo", ["convoId", "createdAt"]),

  blocks: defineTable({ by: v.id("users"), who: v.id("users") }).index("by_by", ["by"]).index("by_pair", ["by", "who"]),

  reports: defineTable({
    by: v.id("users"),
    kind: v.string(),          // "post" | "reply" | "user" | "message"
    targetId: v.string(),
    reason: v.string(),
    createdAt: v.number(),
    done: v.optional(v.boolean()),
  }).index("by_created", ["createdAt"]),

  // bug reports sent through "Report a Bug" (guests can send them too)
  bugs: defineTable({
    byId: v.optional(v.id("users")),
    byName: v.string(),
    title: v.string(),
    details: v.string(),
    where: v.string(),             // which app the bug is in
    images: v.array(v.id("_storage")),
    device: v.string(),            // browser + screen size, to help reproduce it
    status: v.string(),            // "new" | "seen" | "fixed"
    createdAt: v.number(),
  }).index("by_created", ["createdAt"]),
});
