require("dotenv").config();
const crypto = require("crypto");

const raw = process.argv[2];
if (!raw) {
  console.error("Usage: node hashkey.js <rawKey>");
  process.exit(1);
}

const salt = process.env.API_KEY_SALT;
console.log("SALT loaded:", !!salt);

if (!salt) {
  console.error("API_KEY_SALT missing from .env");
  process.exit(2);
}

const hash = crypto
  .createHash("sha256")
  .update(raw + salt)
  .digest("hex");

console.log(hash);
