const SHARE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ORCA_SHARE_HOSTS = new Set(["app.orca.dev", "share.orca.dev", "share.onorca.dev"]);
const VALID_CATEGORIES = new Set(["dev", "ops", "release", "productivity", "research", "general"]);
const VALID_AVATAR_TYPES = new Set(["mascot", "emoji"]);
const VALID_MASCOTS = new Set([
  "A1", "B1", "D1", "E1", "F1", "G1", "H1", "H2", "I1", "J1",
  "K2", "L2", "M1", "N1", "O1", "P3", "Q1", "R3", "S2", "T1",
]);
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;
const VALID_TRUST = new Set(["community", "verified"]);
const VALID_STATUS = new Set(["active", "flagged", "hidden", "removed"]);

function corsHeaders(origin = "*") {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Id",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders("*"),
      ...extraHeaders,
    },
  });
}

export function parseOrcaBotShareId(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;
  if (SHARE_ID_RE.test(value)) return value;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const re = /^\/?bots\/share\/([A-Za-z0-9_-]{1,128})\/?$/;
  if (url.protocol === "orca:") {
    return `${url.host}${url.pathname}`.match(re)?.[1] ?? null;
  }
  if (url.protocol !== "https:" || !ORCA_SHARE_HOSTS.has(url.hostname)) {
    return null;
  }
  return url.pathname.match(re)?.[1] ?? null;
}

async function sha256Hex(input) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(input)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function getClientHash(request) {
  const cid = (request.headers.get("X-Client-Id") || "").trim().slice(0, 128);
  const ip = (request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "anon")
    .split(",")[0]
    .trim();
  const seed = cid ? `cid:${cid}` : `ip:${ip}`;
  return (await sha256Hex(seed)).slice(0, 32);
}

async function checkRateLimit(db, bucket, maxHits, windowMs) {
  const now = Date.now();
  const row = await db.prepare("SELECT hits, reset_at FROM rate_limits WHERE bucket = ?").bind(bucket).first();
  if (!row || Number(row.reset_at) <= now) {
    await db
      .prepare("INSERT INTO rate_limits (bucket, hits, reset_at) VALUES (?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET hits = 1, reset_at = ?")
      .bind(bucket, now + windowMs, now + windowMs)
      .run();
    return { allowed: true, remaining: maxHits - 1 };
  }
  if (Number(row.hits) >= maxHits) {
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((Number(row.reset_at) - now) / 1000)) };
  }
  await db.prepare("UPDATE rate_limits SET hits = hits + 1 WHERE bucket = ?").bind(bucket).run();
  return { allowed: true, remaining: maxHits - Number(row.hits) - 1 };
}

async function probeOrcaShareLiveness(shareId, fetchImpl = fetch) {
  const url = `https://app.orca.dev/bots/share/${encodeURIComponent(shareId)}`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetchImpl(url, { method: "HEAD", redirect: "follow", signal: ctrl.signal });
    clearTimeout(timer);
    if (res.status === 404 || res.status === 410) {
      return { ok: false, reason: "Share link not found or stopped in Orca" };
    }
    return { ok: true };
  } catch {
    // Allow submission if Orca edge temporarily times out; community report + periodic check still guard quality
    return { ok: true, uncertain: true };
  }
}

function cleanText(val, maxLen) {
  return String(val || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLen);
}

function parseTags(raw) {
  const list = Array.isArray(raw)
    ? raw
    : String(raw || "")
        .split(/[,，\s]+/)
        .filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const t of list) {
    const clean = cleanText(t, 24).replace(/^#/, "");
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= 6) break;
  }
  return out;
}

function formatBotRow(row, likedSet = null) {
  let tags = [];
  try {
    const parsed = JSON.parse(row.tags_json || "[]");
    if (Array.isArray(parsed)) tags = parsed;
  } catch {
    tags = [];
  }
  return {
    id: row.id,
    shareId: row.share_id,
    shareUrl: `https://app.orca.dev/bots/share/${row.share_id}`,
    deepLink: `orca://bots/share/${row.share_id}`,
    name: row.name,
    purpose: row.purpose,
    description: row.description || "",
    category: row.category || "general",
    tags,
    agentHint: row.agent_hint || "claude",
    avatarType: row.avatar_type || "mascot",
    avatarValue: row.avatar_value || "A1",
    avatarColor: row.avatar_color || "#b3dbf4",
    authorName: row.author_name || "Community",
    authorHandle: row.author_handle || "",
    trust: row.trust || "community",
    featured: Boolean(row.featured),
    status: row.status || "active",
    likesCount: Number(row.likes_count || 0),
    hiresCount: Number(row.hires_count || 0),
    liked: likedSet ? likedSet.has(row.id) : false,
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
  };
}

async function handleListBots(request, env) {
  const url = new URL(request.url);
  const q = cleanText(url.searchParams.get("q") || "", 80).toLowerCase();
  const category = cleanText(url.searchParams.get("category") || "", 32).toLowerCase();
  const sort = cleanText(url.searchParams.get("sort") || "hot", 16).toLowerCase();
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") || 60) || 60));

  const clientHash = await getClientHash(request);
  const rowsRes = await env.DB.prepare("SELECT * FROM bots WHERE status = 'active'").all();
  const allRows = Array.isArray(rowsRes?.results) ? rowsRes.results : [];

  const likesRes = await env.DB.prepare("SELECT bot_id FROM likes WHERE client_hash = ?").bind(clientHash).all();
  const likedSet = new Set((likesRes?.results || []).map((r) => r.bot_id));

  let totalHires = 0;
  let totalLikes = 0;
  let verifiedBots = 0;
  for (const r of allRows) {
    totalHires += Number(r.hires_count || 0);
    totalLikes += Number(r.likes_count || 0);
    if (r.trust === "verified") verifiedBots += 1;
  }

  let items = allRows.map((r) => formatBotRow(r, likedSet));
  if (category && category !== "all") {
    if (category === "verified") {
      items = items.filter((b) => b.trust === "verified" || b.featured);
    } else {
      items = items.filter((b) => b.category === category);
    }
  }
  if (q) {
    items = items.filter((b) => {
      const hay = `${b.name} ${b.purpose} ${b.description} ${b.authorName} ${b.agentHint} ${b.tags.join(" ")}`.toLowerCase();
      return hay.includes(q);
    });
  }

  items.sort((a, b) => {
    if (sort === "newest") return b.createdAt - a.createdAt;
    if (sort === "likes") return (b.likesCount - a.likesCount) || (b.hiresCount - a.hiresCount);
    if (sort === "verified") {
      const va = (a.trust === "verified" ? 2 : 0) + (a.featured ? 1 : 0);
      const vb = (b.trust === "verified" ? 2 : 0) + (b.featured ? 1 : 0);
      if (vb !== va) return vb - va;
    }
    const scoreA = (a.featured ? 12 : 0) + (a.trust === "verified" ? 6 : 0) + a.hiresCount * 2 + a.likesCount * 3;
    const scoreB = (b.featured ? 12 : 0) + (b.trust === "verified" ? 6 : 0) + b.hiresCount * 2 + b.likesCount * 3;
    return (scoreB - scoreA) || (b.createdAt - a.createdAt);
  });

  return jsonResponse({
    schemaVersion: 1,
    source: "cloudflare-worker",
    updatedAt: Date.now(),
    stats: { totalBots: allRows.length, verifiedBots, totalHires, totalLikes },
    bots: items.slice(0, limit),
  });
}

async function handlePublishBot(request, env, fetchImpl) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const shareId = parseOrcaBotShareId(body.shareUrl || body.shareId);
  if (!shareId) {
    return jsonResponse({ ok: false, error: "Please provide a valid Orca bot share link (app.orca.dev/bots/share/... or orca://bots/share/...)" }, 400);
  }

  const name = cleanText(body.name, 48);
  const purpose = cleanText(body.purpose, 160);
  const description = cleanText(body.description, 1200);
  if (!name || name.length < 2) return jsonResponse({ ok: false, error: "Bot name must be 2–48 characters" }, 400);
  if (!purpose || purpose.length < 4) return jsonResponse({ ok: false, error: "One-line purpose must be 4–160 characters" }, 400);

  const clientHash = await getClientHash(request);
  const maxPerHour = Math.max(1, Number(env.PUBLISH_LIMIT_PER_HOUR || 5) || 5);
  const rl = await checkRateLimit(env.DB, `pub:${clientHash}`, maxPerHour, 3600 * 1000);
  if (!rl.allowed) {
    return jsonResponse({ ok: false, error: `Rate limit reached. Try again in ${rl.retryAfterSec}s.` }, 429);
  }

  const existing = await env.DB.prepare("SELECT id, status FROM bots WHERE share_id = ?").bind(shareId).first();
  if (existing) {
    return jsonResponse({ ok: false, error: "This Orca share link is already listed in the Talent Market", botId: existing.id }, 409);
  }

  if (String(env.SKIP_SHARE_PROBE || "0") !== "1") {
    const probe = await probeOrcaShareLiveness(shareId, fetchImpl);
    if (!probe.ok) {
      return jsonResponse({ ok: false, error: probe.reason }, 400);
    }
  }

  const rawCat = cleanText(body.category, 24).toLowerCase();
  const category = VALID_CATEGORIES.has(rawCat) ? rawCat : "general";
  const tags = parseTags(body.tags);
  const agentHint = cleanText(body.agentHint || "claude", 24).toLowerCase() || "claude";
  const rawAvType = cleanText(body.avatarType || "mascot", 16).toLowerCase();
  const avatarType = VALID_AVATAR_TYPES.has(rawAvType) ? rawAvType : "mascot";
  let avatarValue = cleanText(body.avatarValue || "A1", 12);
  if (avatarType === "mascot" && !VALID_MASCOTS.has(avatarValue)) avatarValue = "A1";
  if (avatarType === "emoji" && !avatarValue) avatarValue = "🤖";
  const rawColor = cleanText(body.avatarColor || "#b3dbf4", 12);
  const avatarColor = HEX_COLOR_RE.test(rawColor) ? rawColor.toLowerCase() : "#b3dbf4";
  const authorName = cleanText(body.authorName || "Community", 36) || "Community";
  const authorHandle = cleanText(body.authorHandle || "", 36).replace(/^@/, "");

  const now = Date.now();
  const id = `bot_${(await sha256Hex(`${shareId}:${now}`)).slice(0, 12)}`;

  await env.DB.prepare(
    `INSERT INTO bots (
      id, share_id, name, purpose, description, category, tags_json, agent_hint,
      avatar_type, avatar_value, avatar_color, author_name, author_handle,
      trust, featured, status, likes_count, hires_count, reports_count,
      submitter_hash, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'community', 0, 'active', 0, 0, 0, ?, ?, ?)`
  )
    .bind(
      id, shareId, name, purpose, description, category, JSON.stringify(tags), agentHint,
      avatarType, avatarValue, avatarColor, authorName, authorHandle, clientHash, now, now
    )
    .run();

  const row = await env.DB.prepare("SELECT * FROM bots WHERE id = ?").bind(id).first();
  return jsonResponse({ ok: true, bot: formatBotRow(row) }, 201);
}

async function handleToggleLike(request, env, botId) {
  const row = await env.DB.prepare("SELECT id, likes_count FROM bots WHERE id = ? AND status = 'active'").bind(botId).first();
  if (!row) return jsonResponse({ ok: false, error: "Bot not found" }, 404);

  const clientHash = await getClientHash(request);
  const existing = await env.DB.prepare("SELECT 1 FROM likes WHERE bot_id = ? AND client_hash = ?").bind(botId, clientHash).first();
  let liked;
  if (existing) {
    await env.DB.prepare("DELETE FROM likes WHERE bot_id = ? AND client_hash = ?").bind(botId, clientHash).run();
    await env.DB.prepare("UPDATE bots SET likes_count = MAX(0, likes_count - 1), updated_at = ? WHERE id = ?").bind(Date.now(), botId).run();
    liked = false;
  } else {
    await env.DB.prepare("INSERT OR IGNORE INTO likes (bot_id, client_hash, created_at) VALUES (?, ?, ?)").bind(botId, clientHash, Date.now()).run();
    await env.DB.prepare("UPDATE bots SET likes_count = likes_count + 1, updated_at = ? WHERE id = ?").bind(Date.now(), botId).run();
    liked = true;
  }
  const fresh = await env.DB.prepare("SELECT likes_count FROM bots WHERE id = ?").bind(botId).first();
  return jsonResponse({ ok: true, id: botId, liked, likesCount: Number(fresh?.likes_count || 0) });
}

async function handleRecordHire(request, env, botId) {
  const row = await env.DB.prepare("SELECT id, hires_count FROM bots WHERE id = ? AND status = 'active'").bind(botId).first();
  if (!row) return jsonResponse({ ok: false, error: "Bot not found" }, 404);

  const clientHash = await getClientHash(request);
  const dayKey = new Date().toISOString().slice(0, 10);
  const existing = await env.DB.prepare("SELECT 1 FROM hires WHERE bot_id = ? AND client_hash = ? AND day_key = ?")
    .bind(botId, clientHash, dayKey)
    .first();
  if (!existing) {
    await env.DB.prepare("INSERT OR IGNORE INTO hires (bot_id, client_hash, day_key, created_at) VALUES (?, ?, ?, ?)")
      .bind(botId, clientHash, dayKey, Date.now())
      .run();
    await env.DB.prepare("UPDATE bots SET hires_count = hires_count + 1, updated_at = ? WHERE id = ?").bind(Date.now(), botId).run();
  }
  const fresh = await env.DB.prepare("SELECT hires_count FROM bots WHERE id = ?").bind(botId).first();
  return jsonResponse({ ok: true, id: botId, hiresCount: Number(fresh?.hires_count || 0) });
}

async function handleReportBot(request, env, botId) {
  const row = await env.DB.prepare("SELECT id, reports_count, status FROM bots WHERE id = ?").bind(botId).first();
  if (!row) return jsonResponse({ ok: false, error: "Bot not found" }, 404);

  let body = {};
  try { body = await request.json(); } catch {}
  const reason = cleanText(body.reason || "broken_or_spam", 200);
  const clientHash = await getClientHash(request);
  const existing = await env.DB.prepare("SELECT 1 FROM reports WHERE bot_id = ? AND client_hash = ?").bind(botId, clientHash).first();
  if (!existing) {
    await env.DB.prepare("INSERT OR IGNORE INTO reports (bot_id, client_hash, reason, created_at) VALUES (?, ?, ?, ?)")
      .bind(botId, clientHash, reason, Date.now())
      .run();
    const threshold = Math.max(1, Number(env.AUTO_HIDE_REPORT_THRESHOLD || 3) || 3);
    const nextCount = Number(row.reports_count || 0) + 1;
    const nextStatus = nextCount >= threshold && row.status === "active" ? "flagged" : row.status;
    await env.DB.prepare("UPDATE bots SET reports_count = ?, status = ?, updated_at = ? WHERE id = ?")
      .bind(nextCount, nextStatus, Date.now(), botId)
      .run();
    return jsonResponse({ ok: true, id: botId, reportsCount: nextCount, autoHidden: nextStatus === "flagged" });
  }
  return jsonResponse({ ok: true, id: botId, reportsCount: Number(row.reports_count || 0), duplicate: true });
}

async function handleAdminUpdate(request, env, botId) {
  const token = String(env.ADMIN_TOKEN || "").trim();
  const auth = (request.headers.get("Authorization") || "").trim();
  if (!token || auth !== `Bearer ${token}`) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }
  const row = await env.DB.prepare("SELECT * FROM bots WHERE id = ?").bind(botId).first();
  if (!row) return jsonResponse({ ok: false, error: "Bot not found" }, 404);

  let body = {};
  try { body = await request.json(); } catch {}
  const trust = VALID_TRUST.has(body.trust) ? body.trust : row.trust;
  const status = VALID_STATUS.has(body.status) ? body.status : row.status;
  const featured = typeof body.featured === "boolean" ? (body.featured ? 1 : 0) : row.featured;
  await env.DB.prepare("UPDATE bots SET trust = ?, status = ?, featured = ?, updated_at = ? WHERE id = ?")
    .bind(trust, status, featured, Date.now(), botId)
    .run();
  const fresh = await env.DB.prepare("SELECT * FROM bots WHERE id = ?").bind(botId).first();
  return jsonResponse({ ok: true, bot: formatBotRow(fresh) });
}

export function createHandler(fetchImpl = fetch) {
  return {
    async fetch(request, env) {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders("*") });
      }
      const url = new URL(request.url);
      const p = url.pathname.replace(/\/+$/, "") || "/";

      try {
        if (request.method === "GET" && (p === "/" || p === "/api/health")) {
          return jsonResponse({ ok: true, service: "orca-bot-market", version: 1, now: Date.now() });
        }
        if (request.method === "GET" && p === "/api/bots") {
          return await handleListBots(request, env);
        }
        if (request.method === "POST" && p === "/api/bots") {
          return await handlePublishBot(request, env, fetchImpl);
        }
        const mAction = /^\/api\/bots\/([A-Za-z0-9_-]+)\/(like|hire|report)$/.exec(p);
        if (request.method === "POST" && mAction) {
          const [, botId, action] = mAction;
          if (action === "like") return await handleToggleLike(request, env, botId);
          if (action === "hire") return await handleRecordHire(request, env, botId);
          if (action === "report") return await handleReportBot(request, env, botId);
        }
        const mAdmin = /^\/api\/admin\/bots\/([A-Za-z0-9_-]+)$/.exec(p);
        if (request.method === "POST" && mAdmin) {
          return await handleAdminUpdate(request, env, mAdmin[1]);
        }
        return jsonResponse({ ok: false, error: "Not found" }, 404);
      } catch (err) {
        return jsonResponse({ ok: false, error: String(err?.message || err) }, 500);
      }
    },
  };
}

export default createHandler();
