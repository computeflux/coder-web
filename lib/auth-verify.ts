// Server-side local verification of apps/auth (:8008) JWTs.
//
// Mirrors the main API's internal/authn pattern: fetch GET /jwks and cache
// public keys (indexed by kid, TTL 1h) → verify RS256 signature + iss/aud/exp
// locally. No per-request round trip to the auth service.
//
// AUTH_URL empty → auth disabled (pass-through), same convention as the main
// API (cmd/api) for environments where the auth service is not deployed.

import { createPublicKey, createVerify } from "node:crypto";

const JWKS_TTL_MS = 60 * 60 * 1000;

interface JwksKey {
  kty: string;
  kid: string;
  n: string;
  e: string;
}

interface JwtClaims {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  sub?: string;
  email?: string;
  roles?: string[];
}

export interface VerifiedUser {
  userId: string;
  email?: string;
  roles: string[];
}

let cachedKeys: Map<string, JwksKey> | null = null;
let fetchedAt = 0;

function base64UrlToBuffer(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/")
    + "=".repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

async function fetchJwks(): Promise<Map<string, JwksKey> | null> {
  const authUrl = (process.env.AUTH_URL ?? "").trim().replace(/\/+$/, "");
  if (!authUrl) return null;
  const resp = await fetch(`${authUrl}/jwks`, { signal: AbortSignal.timeout(5000) });
  if (!resp.ok) return null;
  const data = (await resp.json().catch(() => ({}))) as { keys?: JwksKey[] };
  const keys = new Map<string, JwksKey>();
  for (const key of data.keys ?? []) {
    if (key.kty === "RSA" && key.kid && key.n && key.e) keys.set(key.kid, key);
  }
  return keys;
}

async function getKeys(): Promise<Map<string, JwksKey> | null> {
  const now = Date.now();
  if (!cachedKeys || now - fetchedAt > JWKS_TTL_MS) {
    const fresh = await fetchJwks();
    if (fresh) {
      // Key rotation: keep old kids until their TTL expires.
      if (cachedKeys) {
        for (const [kid, key] of cachedKeys) {
          if (!fresh.has(kid)) fresh.set(kid, key);
        }
      }
      cachedKeys = fresh;
      fetchedAt = now;
    }
  }
  return cachedKeys;
}

export function isAuthEnabled(): boolean {
  return typeof process.env.AUTH_URL === "string" && process.env.AUTH_URL.trim().length > 0;
}

/**
 * Verify a `Bearer <jwt>` header against the auth service's JWKS.
 * Returns the verified user, or null when the header is missing/invalid.
 */
export async function verifyBearerToken(
  authorization: string | null,
): Promise<VerifiedUser | null> {
  if (!isAuthEnabled() || !authorization) return null;

  const match = /^Bearer\s+(\S+)$/i.exec(authorization);
  if (!match) return null;

  const parts = match[1].split(".");
  if (parts.length !== 3) return null;

  let header: { alg?: string; kid?: string };
  let claims: JwtClaims;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (header.alg !== "RS256" || !header.kid) return null;
  if (typeof claims.exp === "number" && claims.exp * 1000 <= Date.now()) return null;

  const issuer = process.env.AUTH_ISSUER ?? "https://auth.computeflux.ai";
  const audience = process.env.AUTH_AUDIENCE ?? "workflow";
  if (claims.iss !== issuer) return null;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(audience)) return null;

  const key = (await getKeys())?.get(header.kid);
  if (!key) return null;

  try {
    const publicKey = createPublicKey({
      key: { kty: "RSA", n: key.n, e: key.e },
      format: "jwk",
    });
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${parts[0]}.${parts[1]}`);
    if (!verifier.verify(publicKey, base64UrlToBuffer(parts[2]))) return null;
  } catch {
    return null;
  }

  if (!claims.sub) return null;
  return {
    userId: claims.sub,
    email: claims.email,
    roles: Array.isArray(claims.roles) ? claims.roles : [],
  };
}
