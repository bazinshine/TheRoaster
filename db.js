"use strict";
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
});

// Returns a key record ONLY if it's usable (enabled, not revoked, not expired)
async function getKeyRecordByHash(keyHash) {
  const { rows } = await pool.query(
    `select
        key_hash,
        wallet_address,
        tier,
        daily_limit,
        enabled,
        expires_at,
        entitlement_expires_at,
        revoked_at
     from api_keys
     where key_hash = $1
       and enabled = true
       and revoked_at is null
       and (expires_at is null or expires_at > now())
       and (entitlement_expires_at is null or entitlement_expires_at > now())
     limit 1`,
    [keyHash]
  );
  return rows[0] || null;
}

async function touchKeyUsage(keyHash) {
  await pool.query(
    `update api_keys set last_used_at = now()
     where key_hash = $1`,
    [keyHash]
  );
}

// Create a key record. If expiresAt is omitted/null, the key does not expire.
async function insertApiKey({ keyHash, walletAddress, tier, dailyLimit, expiresAt }) {
  const { rows } = await pool.query(
    `insert into api_keys (key_hash, wallet_address, tier, daily_limit, expires_at)
     values ($1, $2, $3, $4, $5)
     returning id`,
    [keyHash, walletAddress || null, tier, dailyLimit ?? null, expiresAt || null]
  );
  return rows[0];
}

// Optional helper: revoke a key (keeps record for audit)
async function revokeApiKeyByHash(keyHash) {
  await pool.query(
    `update api_keys
     set enabled = false, revoked_at = now()
     where key_hash = $1`,
    [keyHash]
  );
}

/**
 * Upsert-ish behavior for wallet claims:
 * - Disable/revoke any currently-active keys for this wallet (keeps history)
 * - Insert a fresh key for the wallet with tier + expiry
 *
 * expires_at_unix should be the API key expiry you want (unix seconds) OR null.
 * entitlement_expires_at_unix should be the on-chain entitlement expiry (unix seconds) OR null.
 *
 * NOTE: Your schema uses agent_name (not requester).
 */
async function upsertApiKeyForWallet({
  key_hash,
  wallet,
  tier,
  daily_limit = null,
  expires_at_unix = null,                 // optional: your chosen API-key expiry
  entitlement_expires_at_unix = null,     // on-chain expiry snapshot
  agent_name = null,                      // stored in api_keys.agent_name
}) {
  const walletLc = (wallet || "").toLowerCase();
  if (!walletLc) throw new Error("wallet required");
  if (!key_hash) throw new Error("key_hash required");
  if (!tier) throw new Error("tier required");

  const expiresAt =
    expires_at_unix != null ? new Date(Number(expires_at_unix) * 1000) : null;

  const entitlementExpiresAt =
    entitlement_expires_at_unix != null
      ? new Date(Number(entitlement_expires_at_unix) * 1000)
      : null;

  const client = await pool.connect();
  try {
    await client.query("begin");

    // Revoke any currently-active keys for this wallet
    await client.query(
      `update api_keys
       set enabled = false, revoked_at = now()
       where wallet_address = $1
         and enabled = true
         and revoked_at is null
         and (expires_at is null or expires_at > now())
         and (entitlement_expires_at is null or entitlement_expires_at > now())`,
      [walletLc]
    );

    // Insert new key
    await client.query(
      `insert into api_keys (
          key_hash,
          wallet_address,
          tier,
          daily_limit,
          expires_at,
          entitlement_expires_at,
          agent_name
        )
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        key_hash,
        walletLc,
        tier,
        daily_limit,
        expiresAt,
        entitlementExpiresAt,
        agent_name,
      ]
    );

    await client.query("commit");
    return { ok: true };
  } catch (e) {
    try {
      await client.query("rollback");
    } catch {}
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  getKeyRecordByHash,
  touchKeyUsage,
  insertApiKey,
  revokeApiKeyByHash,
  upsertApiKeyForWallet,
};
