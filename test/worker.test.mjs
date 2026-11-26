import assert from "node:assert/strict";
import test from "node:test";
import { createHandler, parseOrcaBotShareId } from "../src/index.js";

// Lightweight in-memory D1 SQLite mock tailored to schema.sql queries
function createMockDb() {
  const bots = new Map();
  const likes = new Set();
  const hires = new Set();
  const reports = new Set();
  const limits = new Map();

  return {
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...v) { args = v; return stmt; },
        async first() {
          if (sql.includes("FROM rate_limits")) {
            return limits.get(args[0]) || null;
          }
          if (sql.includes("FROM bots WHERE share_id")) {
            return [...bots.values()].find((b) => b.share_id === args[0]) || null;
          }
          if (sql.includes("FROM bots WHERE id = ? AND status = 'active'")) {
            const b = bots.get(args[0]);
            return b && b.status === "active" ? b : null;
          }
          if (sql.includes("FROM bots WHERE id = ?")) {
            return bots.get(args[0]) || null;
          }
          if (sql.includes("FROM likes WHERE")) {
            return likes.has(`${args[0]}::${args[1]}`) ? { 1: 1 } : null;
          }
          if (sql.includes("FROM hires WHERE")) {
            return hires.has(`${args[0]}::${args[1]}::${args[2]}`) ? { 1: 1 } : null;
          }
          if (sql.includes("FROM reports WHERE")) {
            return reports.has(`${args[0]}::${args[1]}`) ? { 1: 1 } : null;
          }
          return null;
        },
        async all() {
          if (sql.includes("FROM bots WHERE status = 'active'")) {
            return { results: [...bots.values()].filter((b) => b.status === "active") };
          }
          if (sql.includes("SELECT bot_id FROM likes")) {
            const out = [];
            for (const k of likes) {
              const [bid, ch] = k.split("::");
              if (ch === args[0]) out.push({ bot_id: bid });
            }
            return { results: out };
          }
          return { results: [] };
        },
        async run() {
          if (sql.startsWith("INSERT INTO rate_limits")) {
            limits.set(args[0], { hits: 1, reset_at: args[1] });
          } else if (sql.startsWith("UPDATE rate_limits SET hits")) {
            const cur = limits.get(args[0]);
            if (cur) cur.hits += 1;
          } else if (sql.startsWith("INSERT INTO bots")) {
            bots.set(args[0], {
              id: args[0], share_id: args[1], name: args[2], purpose: args[3], description: args[4],
              category: args[5], tags_json: args[6], agent_hint: args[7], avatar_type: args[8],
              avatar_value: args[9], avatar_color: args[10], author_name: args[11], author_handle: args[12],
              trust: "community", featured: 0, status: "active", likes_count: 0, hires_count: 0,
              reports_count: 0, submitter_hash: args[13], created_at: args[14], updated_at: args[15],
            });
          } else if (sql.startsWith("INSERT OR IGNORE INTO likes")) {
            likes.add(`${args[0]}::${args[1]}`);
          } else if (sql.startsWith("DELETE FROM likes")) {
            likes.delete(`${args[0]}::${args[1]}`);
          } else if (sql.includes("likes_count = likes_count + 1")) {
            const b = bots.get(args[1]);
            if (b) { b.likes_count += 1; b.updated_at = args[0]; }
          } else if (sql.includes("likes_count = MAX(0, likes_count - 1)")) {
            const b = bots.get(args[1]);
            if (b) { b.likes_count = Math.max(0, b.likes_count - 1); b.updated_at = args[0]; }
          } else if (sql.startsWith("INSERT OR IGNORE INTO hires")) {
            hires.add(`${args[0]}::${args[1]}::${args[2]}`);
          } else if (sql.includes("hires_count = hires_count + 1")) {
            const b = bots.get(args[1]);
            if (b) { b.hires_count += 1; b.updated_at = args[0]; }
          } else if (sql.startsWith("INSERT OR IGNORE INTO reports")) {
            reports.add(`${args[0]}::${args[1]}`);
          } else if (sql.includes("SET reports_count = ?")) {
            const b = bots.get(args[3]);
            if (b) { b.reports_count = args[0]; b.status = args[1]; b.updated_at = args[2]; }
          } else if (sql.includes("SET trust = ?, status = ?, featured = ?")) {
            const b = bots.get(args[4]);
            if (b) { b.trust = args[0]; b.status = args[1]; b.featured = args[2]; b.updated_at = args[3]; }
          }
          return { success: true };
        },
      };
      return stmt;
    },
  };
}

test("parseOrcaBotShareId accepts canonical links and rejects arbitrary URLs", () => {
  assert.equal(parseOrcaBotShareId("https://app.orca.dev/bots/share/abc_123-XYZ"), "abc_123-XYZ");
  assert.equal(parseOrcaBotShareId("https://share.orca.dev/bots/share/myBot99/"), "myBot99");
  assert.equal(parseOrcaBotShareId("orca://bots/share/deep_id_42"), "deep_id_42");
  assert.equal(parseOrcaBotShareId("bare_share_id"), "bare_share_id");
  assert.equal(parseOrcaBotShareId("https://evil.example.com/bots/share/abc"), null);
  assert.equal(parseOrcaBotShareId("javascript:alert(1)"), null);
});

test("full lifecycle: publish, liveness reject, deduped like/hire, 3-report auto-hide, admin verify", async () => {
  const fakeFetch = async (url) => ({ status: url.includes("dead_link") ? 404 : 200 });
  const handler = createHandler(fakeFetch);
  const env = {
    DB: createMockDb(),
    ADMIN_TOKEN: "secret-admin",
    AUTO_HIDE_REPORT_THRESHOLD: "3",
    PUBLISH_LIMIT_PER_HOUR: "5",
  };

  // Reject dead share link
  const rDead = await handler.fetch(new Request("https://market.test/api/bots", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Client-Id": "u1" },
    body: JSON.stringify({ shareUrl: "https://app.orca.dev/bots/share/dead_link", name: "DeadBot", purpose: "Should fail liveness" }),
  }), env);
  assert.equal(rDead.status, 400);

  // Publish valid bot
  const rPub = await handler.fetch(new Request("https://market.test/api/bots", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Client-Id": "u1" },
    body: JSON.stringify({
      shareUrl: "https://app.orca.dev/bots/share/live_bot_01",
      name: "PR Reviewer Pro",
      purpose: "Automated strict PR review & CI triage",
      category: "dev",
      tags: ["pr", "review", "ci"],
      agentHint: "claude",
      avatarType: "mascot",
      avatarValue: "B1",
      avatarColor: "#1f2126",
      authorName: "Alice",
    }),
  }), env);
  assert.equal(rPub.status, 201);
  const pubData = await rPub.json();
  const botId = pubData.bot.id;
  assert.equal(pubData.bot.deepLink, "orca://bots/share/live_bot_01");
  assert.equal(pubData.bot.trust, "community");

  // Duplicate shareId rejected
  const rDup = await handler.fetch(new Request("https://market.test/api/bots", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Client-Id": "u2" },
    body: JSON.stringify({ shareUrl: "orca://bots/share/live_bot_01", name: "Dup", purpose: "Duplicate link" }),
  }), env);
  assert.equal(rDup.status, 409);

  // Toggle like on & off
  const rLike1 = await handler.fetch(new Request(`https://market.test/api/bots/${botId}/like`, {
    method: "POST", headers: { "X-Client-Id": "u2" },
  }), env);
  assert.deepEqual(await rLike1.json(), { ok: true, id: botId, liked: true, likesCount: 1 });

  const rLike2 = await handler.fetch(new Request(`https://market.test/api/bots/${botId}/like`, {
    method: "POST", headers: { "X-Client-Id": "u2" },
  }), env);
  assert.deepEqual(await rLike2.json(), { ok: true, id: botId, liked: false, likesCount: 0 });

  // Deduped daily hire counter
  const rHire1 = await handler.fetch(new Request(`https://market.test/api/bots/${botId}/hire`, {
    method: "POST", headers: { "X-Client-Id": "u2" },
  }), env);
  assert.equal((await rHire1.json()).hiresCount, 1);
  const rHireDup = await handler.fetch(new Request(`https://market.test/api/bots/${botId}/hire`, {
    method: "POST", headers: { "X-Client-Id": "u2" },
  }), env);
  assert.equal((await rHireDup.json()).hiresCount, 1);

  // Admin verify + feature
  const rUnauth = await handler.fetch(new Request(`https://market.test/api/admin/bots/${botId}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trust: "verified" }),
  }), env);
  assert.equal(rUnauth.status, 401);

  const rAdm = await handler.fetch(new Request(`https://market.test/api/admin/bots/${botId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer secret-admin" },
    body: JSON.stringify({ trust: "verified", featured: true }),
  }), env);
  assert.equal(rAdm.status, 200);
  const admBot = (await rAdm.json()).bot;
  assert.equal(admBot.trust, "verified");
  assert.equal(admBot.featured, true);

  // 3 distinct reports auto-hide the listing
  for (const cid of ["rep1", "rep2", "rep3"]) {
    await handler.fetch(new Request(`https://market.test/api/bots/${botId}/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Client-Id": cid },
      body: JSON.stringify({ reason: "Link stopped working" }),
    }), env);
  }
  const rList = await handler.fetch(new Request("https://market.test/api/bots"), env);
  assert.equal((await rList.json()).bots.length, 0);
});
