import { jwtVerify } from "jose";
import type { Config } from "../env";
import { getJwksResolver } from "./jwks";

export interface McpTokenClaims {
  iss: string;
  aud: string | string[];
  sub: string;
  iat: number;
  exp: number;
  jti: string;
  scope: string;
  client_id: string;
  original_client_id: string;
  grant_id: string;
  organization_ids: string[];
  token_use: string;
  [claim: string]: unknown;
}

const REQUIRED_CLAIMS = [
  "iss",
  "aud",
  "sub",
  "iat",
  "exp",
  "jti",
  "scope",
  "client_id",
  "original_client_id",
  "grant_id",
  "organization_ids",
  "token_use",
] as const;

export type VerifyFailureReason =
  | "malformed"
  | "algorithm"
  | "signature"
  | "issuer"
  | "audience"
  | "expired"
  | "token_use"
  | "missing_claim";

export class TokenVerificationError extends Error {
  constructor(
    public readonly reason: VerifyFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "TokenVerificationError";
  }
}

/**
 * Local RS256/JWKS verification of an MCP access token: exact `iss`, exact
 * `aud` (the MCP resource), `token_use: mcp_access`, valid exp/iat, and all
 * required claims present. Unknown `kid` handling (one refresh attempt before
 * rejecting) is provided by the jose remote JWKS resolver.
 */
export async function verifyMcpToken(config: Config, token: string): Promise<McpTokenClaims> {
  if (typeof token !== "string" || token.length === 0) {
    throw new TokenVerificationError("malformed", "Missing bearer token");
  }

  let claims: McpTokenClaims;
  try {
    const { payload } = await jwtVerify(token, getJwksResolver(config), {
      algorithms: ["RS256"],
      issuer: config.authBaseUrl,
      audience: config.mcpResourceUrl,
      clockTolerance: 5,
      requiredClaims: [...REQUIRED_CLAIMS],
    });
    claims = payload as McpTokenClaims;
  } catch (error) {
    throw toVerificationError(error);
  }

  if (claims.token_use !== "mcp_access") {
    throw new TokenVerificationError("token_use", "token_use must be mcp_access");
  }

  for (const claim of REQUIRED_CLAIMS) {
    if (claims[claim] === undefined || claims[claim] === null) {
      throw new TokenVerificationError("missing_claim", `Missing required claim: ${claim}`);
    }
  }

  return claims;
}

function toVerificationError(error: unknown): TokenVerificationError {
  const code = (error as { code?: string }).code;
  switch (code) {
    case "ERR_JWT_INVALID":
    case "ERR_JWS_INVALID":
      return new TokenVerificationError("malformed", "Malformed token");
    case "ERR_JWS_SIGNATURE_VERIFICATION_FAILED":
      return new TokenVerificationError("signature", "Signature verification failed");
    case "ERR_JWT_CLAIM_VALIDATION_FAILED": {
      const reason = (error as { claim?: string }).claim;
      if (reason === "iss") return new TokenVerificationError("issuer", "Issuer mismatch");
      if (reason === "aud") return new TokenVerificationError("audience", "Audience mismatch");
      if (reason === "exp") return new TokenVerificationError("expired", "Token expired");
      if (reason === "iat") return new TokenVerificationError("expired", "Invalid issued-at");
      return new TokenVerificationError("missing_claim", "Claim validation failed");
    }
    case "ERR_JWKS_NO_MATCHING_KEY":
      return new TokenVerificationError(
        "signature",
        "No matching key for kid (after refresh)",
      );
    case "ERR_JWKS_MULTIPLE_MATCHING_KEYS":
    case "ERR_JWKS_INVALID":
      return new TokenVerificationError("signature", "Invalid JWKS response");
    default:
      if (error instanceof TokenVerificationError) return error;
      return new TokenVerificationError("signature", "Token verification failed");
  }
}
