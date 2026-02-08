"use strict";

require("dotenv").config();
const fastify = require("fastify")({
  logger: true,
  trustProxy: true,
});

const crypto = require("crypto");
const OpenAI = require("openai");
const { createClient } = require("redis");
const { ethers } = require("ethers");

const {
  pool,
  getKeyRecordByHash,
  touchKeyUsage,
  upsertApiKeyForWallet,
} = require("./db");

const PORT = Number(process.env.PORT || 3040);
const SALT = process.env.API_KEY_SALT || "dev_salt_change_me";

// Tier limits (API usage limits; not on-chain pricing)
const FREE_DAILY_LIMIT = Number(process.env.FREE_DAILY_LIMIT || 5);
const BASIC_DAILY_LIMIT = Number(process.env.BASIC_DAILY_LIMIT || 50);
const PRO_DAILY_LIMIT = Number(process.env.PRO_DAILY_LIMIT || 250);
const FREE_IP_DAILY_LIMIT = Number(process.env.FREE_IP_DAILY_LIMIT || 20);

// Model locked server-side (remove from API params)
const MODEL = process.env.ROASTER_MODEL || "gpt-4.1-nano";

if (!process.env.OPENAI_API_KEY) fastify.log.warn("OPENAI_API_KEY is not set");
if (!process.env.DATABASE_URL) fastify.log.warn("DATABASE_URL is not set");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --------------------
// Redis (rate limit counters + nonces + cache)
// --------------------
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const redis = createClient({ url: REDIS_URL });

redis.on("error", (err) => {
  fastify.log.error({ err }, "Redis error");
});

// --------------------
// Onchain config (Base)
// --------------------
const CHAIN_ID = Number(process.env.ROASTER_CHAIN_ID || 8453);
const CONTRACT_ADDR = process.env.ROASTER_CONTRACT; // e.g. 0x430b...
const DOMAIN = process.env.ROASTER_DOMAIN || "theroaster.app";
const BASE_RPC_URL = process.env.BASE_RPC_URL;

// Base USDC (6 decimals)
const USDC_ADDR = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

if (!BASE_RPC_URL) fastify.log.warn("BASE_RPC_URL is not set");
if (!CONTRACT_ADDR) fastify.log.warn("ROASTER_CONTRACT is not set");

const provider = BASE_RPC_URL ? new ethers.JsonRpcProvider(BASE_RPC_URL) : null;

// Minimal ABI for what we need
const ROASTER_ABI = [
  "function getAllPlans() view returns ((uint8 tier,uint8 durationId,uint32 durationSeconds_,uint256 priceUSDC_)[])",
  "function entitlement(address) view returns (uint8 tier,uint64 expiresAt)",
  "function effectiveTier(address) view returns (uint8)",
  "function purchase(uint8 tier,uint8 durationId) returns (uint64)",
];

const USDC_ABI = ["function approve(address spender,uint256 amount) returns (bool)"];

const roaster =
  provider && CONTRACT_ADDR
    ? new ethers.Contract(CONTRACT_ADDR, ROASTER_ABI, provider)
    : null;

const usdc =
  provider ? new ethers.Contract(USDC_ADDR, USDC_ABI, provider) : null;

// --------------------
// Helpers
// --------------------

// Seconds until next UTC midnight (so daily counters auto-reset)
function secondsUntilUtcMidnight() {
  const now = new Date();
  const next = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0,
      0,
      0,
      0
    )
  );
  const diffMs = next.getTime() - now.getTime();
  return Math.max(1, Math.floor(diffMs / 1000));
}

function utcDayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function hashKey(rawKey) {
  return crypto.createHash("sha256").update(rawKey + SALT).digest("hex");
}

// sanitize requester/agent name for logs + redis key safety
function cleanRequester(v) {
  if (typeof v !== "string") return "";
  const s = v.trim().slice(0, 48);
  return s.replace(/[^a-zA-Z0-9_-]/g, "");
}

async function getKeyRecord(req) {
  const auth = req.headers.authorization || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;

  const raw = m[1].trim();
  if (!raw) return null;

  const h = hashKey(raw);
  const rec = await getKeyRecordByHash(h);
  if (!rec) return null;

  // update last_used_at best-effort
  touchKeyUsage(h).catch(() => {});
  return { id: h, ...rec };
}

// Tier -> daily limit (DB override if daily_limit exists)
function tierLimit(rec) {
  if (rec && rec.daily_limit != null) {
    const n = Number(rec.daily_limit);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const tier = String(rec?.tier || "").toLowerCase();
  if (tier === "pro") return PRO_DAILY_LIMIT;
  if (tier === "basic") return BASIC_DAILY_LIMIT;

  // Default for unknown tiers with keys: treat as basic
  return BASIC_DAILY_LIMIT;
}

async function rateLimitDaily({ scope, id, limit }) {
  const day = utcDayKey();
  const key = `roaster:daily:${scope}:${day}:${id}`;
  const ttl = secondsUntilUtcMidnight();

  const used = await redis.incr(key);
  if (used === 1) await redis.expire(key, ttl);

  return { used, remaining: Math.max(0, limit - used), day };
}

// --- IMPORTANT: split onchain requirements ---

function requireRoaster(reply) {
  if (!provider || !roaster || !CONTRACT_ADDR) {
    reply.code(500);
    return { ok: false, error: "Onchain not configured" };
  }
  return null;
}

function requireUSDC(reply) {
  const bad = requireRoaster(reply);
  if (bad) return bad;
  if (!usdc) {
    reply.code(500);
    return { ok: false, error: "USDC not configured" };
  }
  return null;
}

async function getPlansCached() {
  if (!roaster) throw new Error("Onchain not configured");

  const cacheKey = "roaster:plans:v1";
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const plans = await roaster.getAllPlans();
  const out = plans.map((p) => ({
    tier: Number(p.tier),
    durationId: Number(p.durationId),
    durationSeconds: Number(p.durationSeconds_),
    priceUSDC: p.priceUSDC_.toString(), // 6 decimals
  }));

  // short cache (prices can change by owner)
  await redis.set(cacheKey, JSON.stringify(out), { EX: 60 });
  return out;
}

function randomNonce() {
  return crypto.randomBytes(16).toString("hex");
}

function makeApiKey() {
  return "rk_" + crypto.randomBytes(24).toString("base64url");
}

const SYSTEM_PROMPT = `
You are a playful, sarcastic roast bot in a group chat. (your name is The Roaster)
Your job is to roast people in a brutal-but-funny way.

Context glossary (use when relevant or Moltbook is mentioned):
- Moltbook: a Reddit-style social network for AI agents ("moltys").
- submolt: a community (like a subreddit).
- molty: an AI agent user on Moltbook (lobster vibes).
- "heartbeat": a bot's periodic check-in routine (posting/commenting on schedule).
- Karma/upvotes/feed: standard Reddit mechanics.

VERY IMPORTANT RULES (every roast):
- Do NOT attack protected characteristics (race, religion, sexuality, gender, disability, etc.).
- Do NOT encourage self-harm, violence, or threats.
- Keep it clearly as a joke; no harassment or demeaning hate.
- You may mock behaviour, choices, or message content.
- Swearing is allowed but not over-used.

Style:
- Short and punchy (1–3 sentences).
- British / American internet banter vibe.
- Assume they opted-in.

Output ONLY the roast text (no quotes, no markdown, no preamble).
`.trim();

// --------------------
// Routes
// --------------------
fastify.get("/health", async () => ({ ok: true }));

// ---- Onchain helpers ----

fastify.get("/api/v1/contract", async (_req, reply) => {
  const bad = requireRoaster(reply);
  if (bad) return bad;

  return {
    success: true,
    chainId: CHAIN_ID,
    domain: DOMAIN,
    contract: CONTRACT_ADDR,
    usdc: USDC_ADDR,
  };
});

fastify.get("/api/v1/plans", async (_req, reply) => {
  try {
    const bad = requireRoaster(reply);
    if (bad) return bad;

    const plans = await getPlansCached();
    return { success: true, plans };
  } catch (e) {
    reply.code(500);
    return { success: false, error: e?.message || "Failed to load plans" };
  }
});

fastify.get("/api/v1/entitlement/:address", async (req, reply) => {
  try {
    const bad = requireRoaster(reply);
    if (bad) return bad;

    const address = ethers.getAddress(req.params.address);
    const [tier, expiresAt] = await roaster.entitlement(address);

    const exp = Number(expiresAt);
    const now = Math.floor(Date.now() / 1000);

    return {
      success: true,
      address,
      tier: Number(tier),
      expiresAt: exp,
      active: exp > now,
    };
  } catch (e) {
    reply.code(400);
    return { success: false, error: e?.message || "Bad address" };
  }
});

// Build unsigned approve tx for a plan (bots/humans sign + send)
fastify.post("/api/v1/tx/approve", async (req, reply) => {
  try {
    const bad = requireUSDC(reply);
    if (bad) return bad;

    const { buyer, tier, durationId } = req.body || {};
    const from = ethers.getAddress(buyer);

    const plans = await getPlansCached();
    const match = plans.find(
      (p) => p.tier === Number(tier) && p.durationId === Number(durationId)
    );
    if (!match) return reply.code(400).send({ success: false, error: "Unknown plan" });

    const price = BigInt(match.priceUSDC);

    return {
      success: true,
      tx: {
        from,
        to: USDC_ADDR,
        data: usdc.interface.encodeFunctionData("approve", [CONTRACT_ADDR, price]),
        value: "0x0",
      },
      priceUSDC: match.priceUSDC,
    };
  } catch (e) {
    reply.code(500);
    return { success: false, error: e?.message || "Failed to build approve tx" };
  }
});

// Build unsigned purchase tx for a plan (bots/humans sign + send)
fastify.post("/api/v1/tx/purchase", async (req, reply) => {
  try {
    const bad = requireRoaster(reply);
    if (bad) return bad;

    const { buyer, tier, durationId } = req.body || {};
    const from = ethers.getAddress(buyer);

    // validate plan exists to avoid reverts
    const plans = await getPlansCached();
    const match = plans.find(
      (p) => p.tier === Number(tier) && p.durationId === Number(durationId)
    );
    if (!match) return reply.code(400).send({ success: false, error: "Unknown plan" });

    return {
      success: true,
      tx: {
        from,
        to: CONTRACT_ADDR,
        data: roaster.interface.encodeFunctionData("purchase", [
          Number(tier),
          Number(durationId),
        ]),
        value: "0x0",
      },
      priceUSDC: match.priceUSDC,
    };
  } catch (e) {
    reply.code(500);
    return { success: false, error: e?.message || "Failed to build purchase tx" };
  }
});

// ---- Key claim flow (wallet signs message; server verifies; server issues API key) ----

// Step 1: get message to sign
fastify.post("/api/v1/auth/nonce", async (req, reply) => {
  try {
    const bad = requireRoaster(reply);
    if (bad) return bad;

    const { address } = req.body || {};
    const addr = ethers.getAddress(address);

    const nonce = randomNonce();
    const issuedAt = new Date().toISOString();

    const message = [
      "TheRoaster API Key Claim",
      `Domain: ${DOMAIN}`,
      `ChainId: ${CHAIN_ID}`,
      `Contract: ${CONTRACT_ADDR}`,
      `Address: ${addr}`,
      `Nonce: ${nonce}`,
      `IssuedAt: ${issuedAt}`,
    ].join("\n");

    // store nonce for 5 minutes
    await redis.set(`roaster:nonce:${addr}`, JSON.stringify({ nonce, issuedAt }), {
      EX: 300,
    });

    return { success: true, address: addr, message };
  } catch (e) {
    reply.code(400);
    return { success: false, error: e?.message || "Bad address" };
  }
});

// Step 2: claim API key (requires entitlement active onchain)
fastify.post("/api/v1/auth/claim", async (req, reply) => {
  try {
    const bad = requireRoaster(reply);
    if (bad) return bad;

    const body = req.body || {};
    const requester = cleanRequester(body.requester || "");
    const addr = ethers.getAddress(body.address);
    const signature = String(body.signature || "");

    if (!requester) {
      return reply.code(400).send({ success: false, error: "Send requester (bot name)." });
    }
    if (!signature) {
      return reply.code(400).send({ success: false, error: "Missing signature." });
    }

    const nonceRaw = await redis.get(`roaster:nonce:${addr}`);
    if (!nonceRaw) {
      return reply
        .code(400)
        .send({ success: false, error: "Nonce expired. Request a new nonce." });
    }

    const { nonce, issuedAt } = JSON.parse(nonceRaw);

    const message = [
      "TheRoaster API Key Claim",
      `Domain: ${DOMAIN}`,
      `ChainId: ${CHAIN_ID}`,
      `Contract: ${CONTRACT_ADDR}`,
      `Address: ${addr}`,
      `Nonce: ${nonce}`,
      `IssuedAt: ${issuedAt}`,
    ].join("\n");

    // Verify signature
    const recovered = ethers.verifyMessage(message, signature);
    if (ethers.getAddress(recovered) !== addr) {
      return reply.code(401).send({ success: false, error: "Signature mismatch." });
    }

    // burn nonce (one-time use)
    await redis.del(`roaster:nonce:${addr}`);

    // Onchain entitlement check
    const [tier, expiresAt] = await roaster.entitlement(addr);
    const exp = Number(expiresAt);
    const now = Math.floor(Date.now() / 1000);
    const active = exp > now;
    const effTier = active ? Number(tier) : 0;

    if (effTier === 0) {
      return reply.code(402).send({
        success: false,
        error: "No active entitlement",
        hint: "Buy a plan onchain then claim again.",
      });
    }

    // Mint API key
    const rawKey = makeApiKey();
    const keyHash = hashKey(rawKey);
    const tierName = effTier === 2 ? "pro" : "basic";

    if (typeof upsertApiKeyForWallet !== "function") {
      return reply.code(500).send({
        success: false,
        error: "DB function upsertApiKeyForWallet missing in db.js",
      });
    }

    // Persist in DB. Store only hash, return raw once.
    await upsertApiKeyForWallet({
      key_hash: keyHash,
      wallet: addr,
      tier: tierName,
      entitlement_expires_at_unix: exp, // from the contract
      expires_at_unix: null, // optional
      agent_name: requester,
    });

    return {
      success: true,
      api_key: rawKey,
      tier: effTier,
      expiresAt: exp,
    };
  } catch (e) {
    req.log.error(e, "claim error");
    reply.code(500);
    return { success: false, error: e?.message || "Claim failed" };
  }
});

// ---- Existing roast endpoint ----
fastify.post("/api/v1/roast", async (req, reply) => {
  if (!process.env.OPENAI_API_KEY) {
    return reply.code(500).send({ success: false, error: "Server misconfigured" });
  }

  const body = req.body || {};
  const requester = cleanRequester(body.requester);
  const name = typeof body.name === "string" ? body.name.slice(0, 64) : "";
  const message = typeof body.message === "string" ? body.message.slice(0, 800) : "";

  if (!requester) {
    return reply.code(400).send({
      success: false,
      error: "Send 'requester' (calling bot name).",
      hint: 'Example: {"requester":"ClawdClawderberg","name":"SomeMolty","message":"..."}',
    });
  }

  if (!name && !message) {
    return reply.code(400).send({ success: false, error: "Send at least 'name' or 'message'." });
  }

  const authHeader = req.headers.authorization || "";
  const hadAuth = /^Bearer\s+/i.test(authHeader);

  const keyRec = await getKeyRecord(req);

  if (!keyRec && hadAuth) {
    return reply.code(401).send({ success: false, error: "Invalid or expired API key" });
  }

  if (!keyRec) {
    const day = utcDayKey();
    const ttl = secondsUntilUtcMidnight();

    const ipKey = `roaster:daily:free-ip:${day}:${req.ip}`;
    const ipUsed = await redis.incr(ipKey);
    if (ipUsed === 1) await redis.expire(ipKey, ttl);

    if (ipUsed > FREE_IP_DAILY_LIMIT) {
      return reply.code(429).send({
        success: false,
        error: "Free IP limit reached",
        hint: "Too many free requests from this IP today",
        reset_utc_day: day,
        daily_limit: FREE_IP_DAILY_LIMIT,
      });
    }

    const freeId = `${req.ip}:${requester.toLowerCase()}`;
    const { used } = await rateLimitDaily({
      scope: "free",
      id: freeId,
      limit: FREE_DAILY_LIMIT,
    });

    if (used > FREE_DAILY_LIMIT) {
      return reply.code(429).send({
        success: false,
        error: "Free daily limit reached",
        hint: "Add Authorization: Bearer <API_KEY> for higher limits",
        reset_utc_day: day,
        daily_limit: FREE_DAILY_LIMIT,
      });
    }
  } else {
    const limit = tierLimit(keyRec);
    const { used, day } = await rateLimitDaily({
      scope: "key",
      id: keyRec.id,
      limit,
    });

    if (used > limit) {
      const t = String(keyRec.tier || "basic").toLowerCase();
      return reply.code(429).send({
        success: false,
        error: `${t} daily limit reached`,
        reset_utc_day: day,
        daily_limit: limit,
      });
    }
  }

  const parts = [];
  parts.push(`Requester bot: ${requester}`);
  if (name) parts.push(`Target username: ${name}`);
  if (message) parts.push(`Last message from user: "${message}"`);

  const userPrompt = `Roast this user based on the details below.\n\n${parts.join("\n")}`;

  try {
    const resp = await openai.responses.create({
      model: MODEL,
      input: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      max_output_tokens: 80,
    });

    const roast = (resp.output_text || "").trim();
    if (!roast) {
      return reply.code(502).send({ success: false, error: "Empty roast output" });
    }

    return { success: true, roast };
  } catch (e) {
    req.log.error(e, "Roast generation error");
    return reply.code(500).send({ success: false, error: "Roast generation failed" });
  }
});

// Graceful shutdown
fastify.addHook("onClose", async (_instance, done) => {
  try {
    await redis.quit();
  } catch {}
  try {
    await pool.end();
  } catch {}
  done();
});

async function start() {
  await redis.connect();
  fastify.log.info({ REDIS_URL }, "Redis connected");
  await fastify.listen({ port: PORT, host: "127.0.0.1" });
}

start().catch((err) => {
  fastify.log.error(err);
  process.exit(1);
});
