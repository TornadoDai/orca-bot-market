import assert from "node:assert/strict";
import test from "node:test";
import { createHandler, parseOrcaBotShareId, serverSanitizeText } from "../src/index.js";

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
          if (sql.includes("FROM rate_limits")) return limits.get(args[0]) || null;
          if (sql.includes("FROM bots WHERE share_id")) return [...bots.values()].find((b) => b.share_id === args[0]) || null;
          if (sql.includes("WHERE (share_code = ? OR id = ?)")) {
            return [...bots.values()].find((b) => (b.share_code === args[0] || b.id === args[1]) && b.status === "active") || null;
          }
          if (sql.includes("FROM bots WHERE id = ? AND status = 'active'")) {
            const b = bots.get(args[0]);
            return b && b.status === "active" ? b : null;
          }
          if (sql.includes("FROM bots WHERE id = ?")) return bots.get(args[0]) || null;
          if (sql.includes("FROM likes WHERE")) return likes.has(`${args[0]}::${args[1]}`) ? { 1: 1 } : null;
          if (sql.includes("FROM hires WHERE")) return hires.has(`${args[0]}::${args[1]}::${args[2]}`) ? { 1: 1 } : null;
          if (sql.includes("FROM reports WHERE")) return reports.has(`${args[0]}::${args[1]}`) ? { 1: 1 } : null;
          return null;
        },
        async all() {
          if (sql.includes("FROM bots WHERE status = 'active'")) return { results: [...bots.values()].filter((b) => b.status === "active") };
          if (sql.includes("SELECT bot_id FROM likes")) {
            const out = [];
            for (const k of likes) { const [bid, ch] = k.split("::"); if (ch === args[0]) out.push({ bot_id: bid }); }
            return { results: out };
          }
          return { results: [] };
        },
        async run() {
          if (sql.startsWith("INSERT INTO rate_limits")) limits.set(args[0], { hits: 1, reset_at: args[1] });
          else if (sql.startsWith("UPDATE rate_limits SET hits")) { const cur = limits.get(args[0]); if (cur) cur.hits += 1; }
          else if (sql.startsWith("INSERT INTO bots")) {
            bots.set(args[0], {
              id: args[0], share_id: args[1], share_code: args[2], share_mode: args[3], name: args[4],
              purpose: args[5], description: args[6], soul_md: args[7], skills_json: args[8],
              watches: args[9], does_text: args[10], reports: args[11], category: args[12], tags_json: args[13],
              agent_hint: args[14], avatar_type: args[15], avatar_value: args[16], avatar_color: args[17],
              author_name: args[18], author_handle: args[19], trust: "community", featured: 0, status: "active",
              likes_count: 0, hires_count: 0, reports_count: 0, submitter_hash: args[20], created_at: args[21], updated_at: args[22],
            });
          } else if (sql.startsWith("INSERT OR IGNORE INTO likes")) likes.add(`${args[0]}::${args[1]}`);
          else if (sql.startsWith("DELETE FROM likes")) likes.delete(`${args[0]}::${args[1]}`);
          else if (sql.includes("likes_count = likes_count + 1")) { const b = bots.get(args[1]); if (b) b.likes_count += 1; }
          else if (sql.includes("likes_count = MAX(0, likes_count - 1)")) { const b = bots.get(args[1]); if (b) b.likes_count = Math.max(0, b.likes_count - 1); }
          else if (sql.startsWith("INSERT OR IGNORE INTO hires")) hires.add(`${args[0]}::${args[1]}::${args[2]}`);
          else if (sql.includes("hires_count = hires_count + 1")) { const b = bots.get(args[1]); if (b) b.hires_count += 1; }
          else if (sql.startsWith("INSERT OR IGNORE INTO reports")) reports.add(`${args[0]}::${args[1]}`);
          else if (sql.includes("SET reports_count = ?")) { const b = bots.get(args[3]); if (b) { b.reports_count = args[0]; b.status = args[1]; } }
          else if (sql.includes("SET trust = ?, status = ?, featured = ?")) { const b = bots.get(args[4]); if (b) { b.trust = args[0]; b.status = args[1]; b.featured = args[2]; } }
          return { success: true };
        },
      };
      return stmt;
    },
  };
}

test("parseOrcaBotShareId and serverSanitizeText work cleanly", () => {
  assert.equal(parseOrcaBotShareId("https://app.orca.dev/bots/share/abc_123"), "abc_123");
  assert.equal(parseOrcaBotShareId("orca://bots/share/deep_42"), "deep_42");
  assert.equal(parseOrcaBotShareId("https://evil.example.com/bots/share/abc"), null);
  const red = serverSanitizeText("Contact me@test.com at /Users/alice/code on 47.102.122.42");
  assert.ok(!red.includes("me@test.com") && !red.includes("/Users/alice") && !red.includes("47.102.122.42"));
});

test("1-click direct recipe publish generates share link, blocks hard secrets & serves /s/:code", async () => {
  const handler = createHandler(async () => ({ status: 200 }));
  const env = { DB: createMockDb(), ADMIN_TOKEN: "secret-admin", AUTO_HIDE_REPORT_THRESHOLD: "3", PUBLISH_LIMIT_PER_HOUR: "8" };

  // Block hard secret
  const rSec = await handler.fetch(new Request("https://market.test/api/bots", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Client-Id": "u1" },
    body: JSON.stringify({ name: "Leaky", purpose: "Oops", soulMd: "Use key sk-1234567890abcdefghij1234" }),
  }), env);
  assert.equal(rSec.status, 400);

  // Direct recipe publish (NO shareUrl needed!)
  const rPub = await handler.fetch(new Request("https://market.test/api/bots", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Client-Id": "u1" },
    body: JSON.stringify({
      name: "Daily Assistant",
      purpose: "General daily helper for macOS dev tasks",
      soulMd: "# Daily Assistant\nCheck /Users/bob/project and ping bob@company.com",
      category: "productivity",
      tags: ["daily", "mac"],
      skills: ["disk-check"],
      authorName: "Bob",
    }),
  }), env);
  assert.equal(rPub.status, 201);
  const data = await rPub.json();
  assert.equal(data.bot.shareMode, "recipe");
  assert.ok(data.shareUrl.startsWith("https://market.test/s/bm_"));
  assert.ok(!data.bot.soulMd.includes("/Users/bob"));
  assert.ok(!data.bot.soulMd.includes("bob@company.com"));

  // Public share HTML page works
  const rPage = await handler.fetch(new Request(data.shareUrl), env);
  assert.equal(rPage.status, 200);
  const html = await rPage.text();
  assert.ok(html.includes("Daily Assistant"));
  assert.ok(html.includes("orca bot create --offer"));
});
