README.md
=========

The Roaster API 🔥

The Roaster is a Web3-powered roast API for AI agents and bots.

It delivers short, brutal-but-funny roasts with clear safety rules, on-chain entitlements, and bot-friendly rate limits.

Entitlements are purchased on-chain (USDC on Base), while API keys are issued off-chain and enforced server-side.

------------------------------------------------------------

FEATURES
- Designed for AI agents & bots
- Wallet-based entitlement (no accounts, no emails)
- On-chain plans (USDC on Base)
- Off-chain API keys with daily limits
- Fast, stateless HTTP API
- Deterministic safety rules (no protected-class attacks)
- Free tier (limited, IP-rate-limited)

------------------------------------------------------------

HOW IT WORKS (HIGH LEVEL)
1) User/bot buys a plan on-chain (USDC -> TheRoaster contract)
2) Wallet signs a message to claim an API key
3) Server verifies entitlement on-chain
4) API key is issued and stored hashed
5) Requests are rate-limited by tier

The contract is the source of truth for access.
The API enforces usage.

------------------------------------------------------------

ON-CHAIN CONTRACT
Network: Base Mainnet (8453)
Token: USDC (6 decimals)
Contract: 0x430bCCfBa14423708E26e19C69a2Ad0b87152B40

------------------------------------------------------------

API ENDPOINTS

Health:
GET https://theroaster.app/health

Contract metadata:
GET https://theroaster.app/api/v1/contract

Plans:
GET https://theroaster.app/api/v1/plans

Check entitlement:
GET https://theroaster.app/api/v1/entitlement/{walletAddress}

Build unsigned approve tx:
POST https://theroaster.app/api/v1/tx/approve
Body JSON:
{
  "buyer": "0xYourWallet",
  "tier": 1,
  "durationId": 1
}

Build unsigned purchase tx:
POST https://theroaster.app/api/v1/tx/purchase
Body JSON:
{
  "buyer": "0xYourWallet",
  "tier": 1,
  "durationId": 1
}

Auth nonce (message to sign):
POST https://theroaster.app/api/v1/auth/nonce
Body JSON:
{
  "address": "0xYourWallet"
}

Auth claim (issue API key if entitled):
POST https://theroaster.app/api/v1/auth/claim
Body JSON:
{
  "requester": "YourBotName",
  "address": "0xYourWallet",
  "signature": "0xSignedMessage"
}

Roast:
POST https://theroaster.app/api/v1/roast
Header:
Authorization: Bearer <API_KEY>
Body JSON:
{
  "requester": "ClawdClawderberg",
  "name": "SomeMolty",
  "message": "I think this is a great idea"
}

Example response:
{
  "success": true,
  "roast": "Calling that a great idea is generous — it’s more like a thought that tripped on the way out."
}

------------------------------------------------------------

AUTHENTICATION
- API keys are issued once and never shown again
- Keys are hashed in the database
- Expiration follows on-chain entitlement
- Invalid or expired keys are rejected

------------------------------------------------------------

SAFETY RULES
- No attacks on protected characteristics
- No encouragement of violence or self-harm
- Roasts target behavior or message content only
- Always framed as humor

------------------------------------------------------------

DEPLOYMENT
- Node.js + Fastify
- Redis (rate limits + nonce storage)
- PostgreSQL (API keys)
- PM2 for process management
- OpenAI API provides roasts
- 
Secrets must be stored in .env (never committed).

------------------------------------------------------------
