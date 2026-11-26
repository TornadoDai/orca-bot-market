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

const HARD_SECRET_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i,
  /\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16})\b/,
];

function corsHeaders(origin = "*") {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Id",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders("*"), ...extraHeaders },
  });
}

function escHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function parseOrcaBotShareId(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;
  if (SHARE_ID_RE.test(value)) return value;
  let url;
  try { url = new URL(value); } catch { return null; }
  const re = /^\/?bots\/share\/([A-Za-z0-9_-]{1,128})\/?$/;
  if (url.protocol === "orca:") return `${url.host}${url.pathname}`.match(re)?.[1] ?? null;
  if (url.protocol !== "https:" || !ORCA_SHARE_HOSTS.has(url.hostname)) return null;
  return url.pathname.match(re)?.[1] ?? null;
}

export function serverSanitizeText(text, maxLen = 12000) {
  let out = String(text || "").replace(/\r\n/g, "\n").slice(0, maxLen);
  out = out.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi, "[REDACTED_KEY]");
  out = out.replace(/\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16})\b/g, "[REDACTED_TOKEN]");
  out = out.replace(/((?:api[_-]?key|token|secret|password|passwd|bearer)\s*[:=]\s*["']?)([^\s"'`,;]{8,})(["']?)/gi, "$1[REDACTED]$3");
  out = out.replace(/(https?:\/\/)([^:\s/@]+):([^@\s/]+)@/gi, "$1[REDACTED]@");
  out = out.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED_EMAIL]");
  out = out.replace(/(?:\/Users\/|\/home\/)[^\s"'`),;:]+/g, "<local-path>");
  out = out.replace(/[A-Za-z]:\\Users\\[^\s"'`),;:]+/g, "<local-path>");
  out = out.replace(/\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g, "[REDACTED_IP]");
  return out.trim();
}

function hasHardSecret(text) {
  const s = String(text || "");
  return HARD_SECRET_PATTERNS.some((re) => re.test(s));
}

async function sha256Hex(input) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(input)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function getClientHash(request) {
  const cid = (request.headers.get("X-Client-Id") || "").trim().slice(0, 128);
  const ip = (request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "anon").split(",")[0].trim();
  return (await sha256Hex(cid ? `cid:${cid}` : `ip:${ip}`)).slice(0, 32);
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
    if (res.status === 404 || res.status === 410) return { ok: false, reason: "Share link not found or stopped in Orca" };
    return { ok: true };
  } catch {
    return { ok: true, uncertain: true };
  }
}

function cleanText(val, maxLen) {
  return String(val || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLen);
}

function parseList(raw, maxItems = 6, maxLen = 28) {
  const list = Array.isArray(raw) ? raw : String(raw || "").split(/[,，\s]+/).filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const t of list) {
    const clean = cleanText(t, maxLen).replace(/^#/, "");
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= maxItems) break;
  }
  return out;
}

function safeJsonArray(raw) {
  try {
    const p = JSON.parse(raw || "[]");
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}

function safeJsonObject(raw) {
  try {
    const p = JSON.parse(raw || "{}");
    return p && typeof p === "object" && !Array.isArray(p) ? p : {};
  } catch {
    return {};
  }
}

function sanitizeBundle(rawBundle) {
  const b = rawBundle && typeof rawBundle === "object" ? rawBundle : {};
  const skills = (Array.isArray(b.skills) ? b.skills : []).slice(0, 16).map((s) => ({
    name: cleanText(typeof s === "string" ? s : s?.name, 64),
    content: serverSanitizeText(typeof s === "string" ? "" : s?.content, 6000),
  })).filter((s) => s.name);

  const automations = (Array.isArray(b.automations) ? b.automations : []).slice(0, 20).map((a) => ({
    name: cleanText(serverSanitizeText(a?.name, 100), 80),
    rrule: cleanText(a?.rrule || a?.schedule || "", 160),
    prompt: serverSanitizeText(a?.prompt, 3000),
    resultsTo: cleanText(a?.resultsTo || "chat", 32),
  })).filter((a) => a.name || a.prompt);

  const tools = (Array.isArray(b.tools) ? b.tools : []).slice(0, 20).map((t) => ({
    name: cleanText(typeof t === "string" ? t : t?.name, 64),
    scope: cleanText(t?.scope || "own", 16),
    url: cleanText(serverSanitizeText(t?.url || "", 200), 200),
    headerNames: parseList(t?.headerNames, 12, 40),
  })).filter((t) => t.name);

  const memory = (Array.isArray(b.memory) ? b.memory : []).slice(0, 12).map((m) => ({
    topic: cleanText(m?.topic, 80),
    content: serverSanitizeText(m?.content, 5000),
  })).filter((m) => m.topic && m.content);

  const rawSet = b.settings && typeof b.settings === "object" ? b.settings : {};
  const settings = {
    agent: cleanText(rawSet.agent || "", 24).toLowerCase(),
    outfit: cleanText(rawSet.outfit || "", 32),
    connectors: parseList(rawSet.connectors, 8, 24),
    setupNote: serverSanitizeText(rawSet.setupNote || "", 1500),
  };

  const result = { skills, automations, tools, memory, settings };
  const serialized = JSON.stringify(result);
  if (serialized.length > 52000) {
    throw new Error("Selected bundle content exceeds 50 KB limit; uncheck large memory/skill files.");
  }
  return { result, serialized };
}

function formatBotRow(row, origin, likedSet = null, clientHash = "") {
  const isOrcaLink = row.share_mode === "orca_link" && row.share_id && !String(row.share_id).startsWith("mkt:");
  const shareCode = row.share_code || row.id;
  const marketShareUrl = `${origin}/s/${shareCode}`;
  const bundle = safeJsonObject(row.bundle_json);
  return {
    id: row.id,
    shareCode,
    shareMode: isOrcaLink ? "orca_link" : "recipe",
    shareId: isOrcaLink ? row.share_id : "",
    shareUrl: isOrcaLink ? `https://app.orca.dev/bots/share/${row.share_id}` : marketShareUrl,
    marketShareUrl,
    deepLink: isOrcaLink ? `orca://bots/share/${row.share_id}` : "",
    name: row.name,
    purpose: row.purpose,
    description: row.description || "",
    soulMd: row.soul_md || "",
    skills: safeJsonArray(row.skills_json),
    bundle: {
      skills: Array.isArray(bundle.skills) ? bundle.skills : [],
      automations: Array.isArray(bundle.automations) ? bundle.automations : [],
      tools: Array.isArray(bundle.tools) ? bundle.tools : [],
      memory: Array.isArray(bundle.memory) ? bundle.memory : [],
      settings: bundle.settings && typeof bundle.settings === "object" ? bundle.settings : {},
    },
    watches: row.watches || "",
    doesText: row.does_text || "",
    reports: row.reports || "",
    category: row.category || "general",
    tags: safeJsonArray(row.tags_json),
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
    isMine: Boolean(clientHash && row.submitter_hash && row.submitter_hash === clientHash),
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

  let totalHires = 0, totalLikes = 0, verifiedBots = 0;
  for (const r of allRows) {
    totalHires += Number(r.hires_count || 0);
    totalLikes += Number(r.likes_count || 0);
    if (r.trust === "verified") verifiedBots += 1;
  }

  let items = allRows.map((r) => formatBotRow(r, url.origin, likedSet, clientHash));
  const myBots = items.filter((b) => b.isMine).length;
  if (category && category !== "all") {
    items = category === "verified" ? items.filter((b) => b.trust === "verified" || b.featured) : items.filter((b) => b.category === category);
  }
  if (q) {
    items = items.filter((b) => `${b.name} ${b.purpose} ${b.description} ${b.authorName} ${b.agentHint} ${b.tags.join(" ")}`.toLowerCase().includes(q));
  }

  items.sort((a, b) => {
    if (sort === "newest") return b.createdAt - a.createdAt;
    if (sort === "likes") return (b.likesCount - a.likesCount) || (b.hiresCount - a.hiresCount);
    const sa = (a.featured ? 12 : 0) + (a.trust === "verified" ? 6 : 0) + a.hiresCount * 2 + a.likesCount * 3;
    const sb = (b.featured ? 12 : 0) + (b.trust === "verified" ? 6 : 0) + b.hiresCount * 2 + b.likesCount * 3;
    return (sb - sa) || (b.createdAt - a.createdAt);
  });

  return jsonResponse({
    schemaVersion: 1,
    source: "cloudflare-worker",
    updatedAt: Date.now(),
    stats: { totalBots: allRows.length, verifiedBots, totalHires, totalLikes, myBots },
    bots: items.slice(0, limit),
  });
}

async function handlePublishBot(request, env, fetchImpl) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ ok: false, error: "Invalid JSON body" }, 400); }

  const rawShareInput = String(body.shareUrl || body.shareId || "").trim();
  const parsedOrcaId = rawShareInput ? parseOrcaBotShareId(rawShareInput) : null;
  if (rawShareInput && !parsedOrcaId) {
    return jsonResponse({ ok: false, error: "Invalid Orca share link format (leave empty to auto-generate a share link)" }, 400);
  }

  const rawConcat = `${body.name || ""}\n${body.purpose || ""}\n${body.description || ""}\n${body.soulMd || ""}\n${JSON.stringify(body.bundle || {})}`;
  if (hasHardSecret(rawConcat)) {
    return jsonResponse({ ok: false, error: "Secret key or token detected — please redact secrets before publishing" }, 400);
  }
  let sanitizedBundle;
  try {
    sanitizedBundle = sanitizeBundle(body.bundle);
  } catch (e) {
    return jsonResponse({ ok: false, error: String(e?.message || e) }, 400);
  }

  const name = cleanText(serverSanitizeText(body.name, 60), 48);
  const purpose = cleanText(serverSanitizeText(body.purpose, 200), 160);
  const description = serverSanitizeText(body.description, 1600);
  const soulMd = serverSanitizeText(body.soulMd, 12000);
  if (!name || name.length < 2) return jsonResponse({ ok: false, error: "Bot name must be 2–48 characters" }, 400);
  if (!purpose || purpose.length < 4) return jsonResponse({ ok: false, error: "One-line purpose must be 4–160 characters" }, 400);
  if (!parsedOrcaId && soulMd.length < 10 && description.length < 10) {
    // Still allow concise purpose-only Bot recipes, fill soulMd from purpose
  }

  const clientHash = await getClientHash(request);
  const maxPerHour = Math.max(1, Number(env.PUBLISH_LIMIT_PER_HOUR || 8) || 8);
  const rl = await checkRateLimit(env.DB, `pub:${clientHash}`, maxPerHour, 3600 * 1000);
  if (!rl.allowed) return jsonResponse({ ok: false, error: `Rate limit reached. Try again in ${rl.retryAfterSec}s.` }, 429);

  if (parsedOrcaId) {
    const existing = await env.DB.prepare("SELECT id FROM bots WHERE share_id = ?").bind(parsedOrcaId).first();
    if (existing) return jsonResponse({ ok: false, error: "This Orca share link is already listed in the Talent Market", botId: existing.id }, 409);
    if (String(env.SKIP_SHARE_PROBE || "0") !== "1") {
      const probe = await probeOrcaShareLiveness(parsedOrcaId, fetchImpl);
      if (!probe.ok) return jsonResponse({ ok: false, error: probe.reason }, 400);
    }
  }

  const now = Date.now();
  const hashHex = await sha256Hex(`${parsedOrcaId || name}:${clientHash}:${now}`);
  const id = `bot_${hashHex.slice(0, 12)}`;
  const shareCode = `bm_${hashHex.slice(12, 22)}`;
  const shareMode = parsedOrcaId ? "orca_link" : "recipe";
  const shareId = parsedOrcaId || `mkt:${shareCode}`;

  const rawCat = cleanText(body.category, 24).toLowerCase();
  const category = VALID_CATEGORIES.has(rawCat) ? rawCat : "general";
  const tags = parseList(body.tags, 6, 24);
  const skills = parseList(body.skills, 16, 40);
  const watches = cleanText(serverSanitizeText(body.watches, 240), 200);
  const doesText = cleanText(serverSanitizeText(body.doesText, 300), 240);
  const reports = cleanText(serverSanitizeText(body.reports, 240), 200);
  const agentHint = cleanText(body.agentHint || "claude", 24).toLowerCase() || "claude";
  const rawAvType = cleanText(body.avatarType || "mascot", 16).toLowerCase();
  const avatarType = VALID_AVATAR_TYPES.has(rawAvType) ? rawAvType : "mascot";
  let avatarValue = cleanText(body.avatarValue || "A1", 12);
  if (avatarType === "mascot" && !VALID_MASCOTS.has(avatarValue)) avatarValue = "A1";
  if (avatarType === "emoji" && !avatarValue) avatarValue = "🤖";
  const rawColor = cleanText(body.avatarColor || "#b3dbf4", 12);
  const avatarColor = HEX_COLOR_RE.test(rawColor) ? rawColor.toLowerCase() : "#b3dbf4";
  const authorName = cleanText(serverSanitizeText(body.authorName || "Community", 40), 36) || "Community";
  const authorHandle = cleanText(body.authorHandle || "", 36).replace(/^@/, "");

  await env.DB.prepare(
    `INSERT INTO bots (
      id, share_id, share_code, share_mode, name, purpose, description, soul_md, skills_json, bundle_json,
      watches, does_text, reports, category, tags_json, agent_hint, avatar_type, avatar_value,
      avatar_color, author_name, author_handle, trust, featured, status,
      likes_count, hires_count, reports_count, submitter_hash, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'community', 0, 'active', 0, 0, 0, ?, ?, ?)`
  )
    .bind(
      id, shareId, shareCode, shareMode, name, purpose, description, soulMd, JSON.stringify(skills), sanitizedBundle.serialized,
      watches, doesText, reports, category, JSON.stringify(tags), agentHint, avatarType, avatarValue,
      avatarColor, authorName, authorHandle, clientHash, now, now
    )
    .run();

  const row = await env.DB.prepare("SELECT * FROM bots WHERE id = ?").bind(id).first();
  const bot = formatBotRow(row, new URL(request.url).origin, null, clientHash);
  return jsonResponse({ ok: true, shareUrl: bot.shareUrl, marketShareUrl: bot.marketShareUrl, bot }, 201);
}

async function handlePublicSharePage(request, env, code) {
  const row = await env.DB.prepare("SELECT * FROM bots WHERE (share_code = ? OR id = ?) AND status = 'active'").bind(code, code).first();
  if (!row) {
    return new Response("<h1>Bot share link not found or removed</h1>", { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  const bot = formatBotRow(row, new URL(request.url).origin);
  const cliCmd = `orca bot create --offer --name ${JSON.stringify(bot.name)} --purpose ${JSON.stringify(bot.purpose)}`;
  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(bot.name)} · Orca Bot Talent Market</title>
<style>body{margin:0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0b1120;color:#e2e8f0;padding:24px}
.wrap{max-width:720px;margin:0 auto;background:#131c31;border:1px solid rgba(148,163,184,.25);border-radius:16px;padding:24px}
.badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:700;background:rgba(52,211,153,.18);color:#6ee7b7;border:1px solid rgba(52,211,153,.4)}
h1{margin:12px 0 6px;font-size:24px}.pitch{color:#cbd5e1;line-height:1.6}
.meta{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}.pill{padding:3px 9px;border-radius:999px;background:#1e293b;font-size:12px;color:#94a3b8}
pre{background:#090d16;border:1px solid rgba(148,163,184,.2);border-radius:10px;padding:14px;overflow:auto;white-space:pre-wrap;font-size:12.5px;line-height:1.55;color:#e2e8f0}
.cta{display:inline-block;margin-top:10px;padding:10px 18px;border-radius:10px;font-weight:800;text-decoration:none;background:linear-gradient(135deg,#34d399,#fbbf24);color:#042f2e}</style></head>
<body><div class="wrap"><span class="badge">🏪 Orca Bot Talent Market · 已自动脱敏</span>
<h1>${escHtml(bot.name)}</h1><p class="pitch">${escHtml(bot.purpose)}</p>
<div class="meta"><span class="pill">Agent: ${escHtml(bot.agentHint)}</span><span class="pill">by ${escHtml(bot.authorName)}</span><span class="pill">👍 ${bot.likesCount}</span><span class="pill">👥 已招 ${bot.hiresCount} 次</span>${bot.tags.map((t) => `<span class="pill">#${escHtml(t)}</span>`).join("")}</div>
${bot.deepLink ? `<a class="cta" href="${escHtml(bot.deepLink)}">⚡ 在 Orca 中一键招聘</a>` : ""}
<h3>快速创建命令（也可在 Bot Office 人才市场一键招聘）</h3><pre>${escHtml(cliCmd)}</pre>
${bot.soulMd ? `<h3>脱敏后的 SOUL.md</h3><pre>${escHtml(bot.soulMd)}</pre>` : ""}
${bot.bundle.automations.length ? `<h3>定时任务 / 自动化 (${bot.bundle.automations.length})</h3>${bot.bundle.automations.map((a) => `<pre><b>${escHtml(a.name)}</b> (${escHtml(a.rrule)})\n${escHtml(a.prompt)}</pre>`).join("")}` : ""}
${bot.bundle.skills.length ? `<h3>附带技能 (${bot.bundle.skills.length})</h3>${bot.bundle.skills.map((s) => `<pre><b>${escHtml(s.name)}</b>\n${escHtml(s.content || "(skill name)")}</pre>`).join("")}` : ""}
${bot.bundle.tools.length ? `<h3>工具 / MCP (${bot.bundle.tools.length})</h3><pre>${escHtml(bot.bundle.tools.map((t) => `${t.name} [${t.scope}]${t.url ? ` ${t.url}` : ""}`).join("\n"))}</pre>` : ""}
${bot.bundle.memory.length ? `<h3>精选脱敏记忆 (${bot.bundle.memory.length})</h3>${bot.bundle.memory.map((m) => `<pre><b>${escHtml(m.topic)}</b>\n${escHtml(m.content)}</pre>`).join("")}` : ""}
</div></body></html>`;
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
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
  const existing = await env.DB.prepare("SELECT 1 FROM hires WHERE bot_id = ? AND client_hash = ? AND day_key = ?").bind(botId, clientHash, dayKey).first();
  if (!existing) {
    await env.DB.prepare("INSERT OR IGNORE INTO hires (bot_id, client_hash, day_key, created_at) VALUES (?, ?, ?, ?)").bind(botId, clientHash, dayKey, Date.now()).run();
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
    await env.DB.prepare("INSERT OR IGNORE INTO reports (bot_id, client_hash, reason, created_at) VALUES (?, ?, ?, ?)").bind(botId, clientHash, reason, Date.now()).run();
    const threshold = Math.max(1, Number(env.AUTO_HIDE_REPORT_THRESHOLD || 3) || 3);
    const nextCount = Number(row.reports_count || 0) + 1;
    const nextStatus = nextCount >= threshold && row.status === "active" ? "flagged" : row.status;
    await env.DB.prepare("UPDATE bots SET reports_count = ?, status = ?, updated_at = ? WHERE id = ?").bind(nextCount, nextStatus, Date.now(), botId).run();
    return jsonResponse({ ok: true, id: botId, reportsCount: nextCount, autoHidden: nextStatus === "flagged" });
  }
  return jsonResponse({ ok: true, id: botId, reportsCount: Number(row.reports_count || 0), duplicate: true });
}

async function handleDeleteBot(request, env, botId) {
  const row = await env.DB.prepare("SELECT id, submitter_hash, name FROM bots WHERE id = ?").bind(botId).first();
  if (!row) return jsonResponse({ ok: false, error: "Bot not found" }, 404);
  const clientHash = await getClientHash(request);
  const adminToken = String(env.ADMIN_TOKEN || "").trim();
  const isAdmin = Boolean(adminToken && (request.headers.get("Authorization") || "").trim() === `Bearer ${adminToken}`);
  const isOwner = Boolean(row.submitter_hash && row.submitter_hash === clientHash);
  if (!isOwner && !isAdmin) {
    return jsonResponse({ ok: false, error: "Only the original publisher can delete this Bot" }, 403);
  }
  await env.DB.prepare("DELETE FROM likes WHERE bot_id = ?").bind(botId).run();
  await env.DB.prepare("DELETE FROM hires WHERE bot_id = ?").bind(botId).run();
  await env.DB.prepare("DELETE FROM reports WHERE bot_id = ?").bind(botId).run();
  await env.DB.prepare("DELETE FROM bots WHERE id = ?").bind(botId).run();
  return jsonResponse({ ok: true, id: botId, deleted: true });
}

async function handleAdminUpdate(request, env, botId) {
  const token = String(env.ADMIN_TOKEN || "").trim();
  if (!token || (request.headers.get("Authorization") || "").trim() !== `Bearer ${token}`) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }
  const row = await env.DB.prepare("SELECT * FROM bots WHERE id = ?").bind(botId).first();
  if (!row) return jsonResponse({ ok: false, error: "Bot not found" }, 404);
  let body = {};
  try { body = await request.json(); } catch {}
  const trust = VALID_TRUST.has(body.trust) ? body.trust : row.trust;
  const status = VALID_STATUS.has(body.status) ? body.status : row.status;
  const featured = typeof body.featured === "boolean" ? (body.featured ? 1 : 0) : row.featured;
  await env.DB.prepare("UPDATE bots SET trust = ?, status = ?, featured = ?, updated_at = ? WHERE id = ?").bind(trust, status, featured, Date.now(), botId).run();
  const fresh = await env.DB.prepare("SELECT * FROM bots WHERE id = ?").bind(botId).first();
  return jsonResponse({ ok: true, bot: formatBotRow(fresh, new URL(request.url).origin) });
}

export function createHandler(fetchImpl = fetch) {
  return {
    async fetch(request, env) {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders("*") });
      const url = new URL(request.url);
      const p = url.pathname.replace(/\/+$/, "") || "/";
      try {
        if (request.method === "GET" && (p === "/" || p === "/api/health")) {
          return jsonResponse({ ok: true, service: "orca-bot-market", version: 4, now: Date.now() });
        }
        const mShare = /^\/s\/([A-Za-z0-9_-]+)$/.exec(p);
        if (request.method === "GET" && mShare) return await handlePublicSharePage(request, env, mShare[1]);
        if (request.method === "GET" && p === "/api/bots") return await handleListBots(request, env);
        if (request.method === "POST" && p === "/api/bots") return await handlePublishBot(request, env, fetchImpl);
        const mBotId = /^\/api\/bots\/([A-Za-z0-9_-]+)$/.exec(p);
        if (request.method === "DELETE" && mBotId) return await handleDeleteBot(request, env, mBotId[1]);
        const mAction = /^\/api\/bots\/([A-Za-z0-9_-]+)\/(like|hire|report|delete)$/.exec(p);
        if (request.method === "POST" && mAction) {
          const [, botId, action] = mAction;
          if (action === "like") return await handleToggleLike(request, env, botId);
          if (action === "hire") return await handleRecordHire(request, env, botId);
          if (action === "report") return await handleReportBot(request, env, botId);
          if (action === "delete") return await handleDeleteBot(request, env, botId);
        }
        const mAdmin = /^\/api\/admin\/bots\/([A-Za-z0-9_-]+)$/.exec(p);
        if (request.method === "POST" && mAdmin) return await handleAdminUpdate(request, env, mAdmin[1]);
        return jsonResponse({ ok: false, error: "Not found" }, 404);
      } catch (err) {
        return jsonResponse({ ok: false, error: String(err?.message || err) }, 500);
      }
    },
  };
}

export default createHandler();
