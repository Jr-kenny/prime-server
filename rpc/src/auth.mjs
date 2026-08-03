import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getAddress, isAddress, verifyMessage } from "viem";

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decode(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function sign(value, secret) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function normalizeAddress(address) {
  if (!isAddress(address)) throw new Error("valid EVM address is required");
  return getAddress(address);
}

export function createPrimeAuthMessage({ domain, address, nonce, issuedAt, expirationTime }) {
  return `${domain} wants you to sign in with your Ethereum account:\n${address}\n\nSign in to Prime Server.\n\nURI: https://${domain}/prime/v1\nVersion: 1\nChain ID: 114\nNonce: ${nonce}\nIssued At: ${issuedAt}\nExpiration Time: ${expirationTime}`;
}

export class PrimeAuthManager {
  constructor({ secret, domain = "api.primeserver", sessionTtlMs = 86_400_000, challengeTtlMs = 300_000 } = {}) {
    if (!secret || String(secret).length < 32) throw new Error("PRIME_SERVER_AUTH_SECRET must be at least 32 characters");
    this.secret = String(secret);
    this.domain = domain;
    this.sessionTtlMs = sessionTtlMs;
    this.challengeTtlMs = challengeTtlMs;
    this.challenges = new Map();
  }

  createChallenge(address, now = Date.now()) {
    const normalizedAddress = normalizeAddress(address);
    const issuedAt = new Date(now).toISOString();
    const expirationTime = new Date(now + this.challengeTtlMs).toISOString();
    const nonce = randomBytes(16).toString("hex");
    const message = createPrimeAuthMessage({
      domain: this.domain,
      address: normalizedAddress,
      nonce,
      issuedAt,
      expirationTime
    });
    this.challenges.set(`${normalizedAddress.toLowerCase()}:${nonce}`, {
      address: normalizedAddress,
      nonce,
      message,
      expiresAt: now + this.challengeTtlMs
    });
    return { address: normalizedAddress, nonce, message, issuedAt, expirationTime };
  }

  async createSession({ address, nonce, signature, now = Date.now() } = {}) {
    const normalizedAddress = normalizeAddress(address);
    const key = `${normalizedAddress.toLowerCase()}:${nonce}`;
    const challenge = this.challenges.get(key);
    if (!challenge || challenge.expiresAt <= now) {
      this.challenges.delete(key);
      throw new Error("authentication challenge expired or not found");
    }
    const valid = await verifyMessage({ address: normalizedAddress, message: challenge.message, signature });
    if (!valid) throw new Error("invalid wallet signature");
    this.challenges.delete(key);
    const issuedAt = now;
    const expiresAt = now + this.sessionTtlMs;
    const payload = encode({
      address: normalizedAddress,
      issuedAt,
      expiresAt
    });
    const token = `${payload}.${sign(payload, this.secret)}`;
    return {
      token,
      address: normalizedAddress,
      expiresAt: new Date(expiresAt).toISOString()
    };
  }

  verifyToken(token, now = Date.now()) {
    if (!token || typeof token !== "string") throw new Error("authentication required");
    const [payloadPart, signature] = token.split(".");
    if (!payloadPart || !signature) throw new Error("invalid authentication token");
    const expected = sign(payloadPart, this.secret);
    const expectedBytes = Buffer.from(expected);
    const signatureBytes = Buffer.from(signature);
    if (expectedBytes.length !== signatureBytes.length || !timingSafeEqual(expectedBytes, signatureBytes)) {
      throw new Error("invalid authentication token");
    }
    const payload = decode(payloadPart);
    if (!payload?.address || !Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= now) {
      throw new Error("authentication token expired");
    }
    return { ...payload, address: normalizeAddress(payload.address) };
  }
}

export function bearerToken(request) {
  const value = request.headers.authorization || "";
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || null;
}
