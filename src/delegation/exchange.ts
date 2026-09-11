import type { Config } from "../env";
import { authServerPost, AuthServerError } from "../auth/client";
import { invalidateIntrospection, type GrantContext } from "../auth/introspection";
import type { McpTokenClaims } from "../auth/verify";

const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

export type ExchangeFailure =
  | "concealed"
  | "unauthorized"
  | "server_error"
  | "network"
  | "invalid_grant"
  | "invalid_target"
  | "invalid_scope"
  | "invalid_request"
  | "unsupported_grant_type"
  | "invalid_400_response"
  | "invalid_response";

/**
 * 400 error codes from the token endpoint that map directly onto an
 * `ExchangeFailure`. Anything else (or an unparseable body) falls back to
 * `invalid_400_response`.
 */
const KNOWN_400_ERRORS: ReadonlySet<string> = new Set([
  "invalid_grant",
  "invalid_target",
  "invalid_scope",
  "invalid_request",
  "unsupported_grant_type",
]);

export class ExchangeError extends Error {
  constructor(
    public readonly failure: ExchangeFailure,
    message: string,
  ) {
    super(message);
    this.name = "ExchangeError";
  }
}

/**
 * Per-request delegation state. Exactly one token exchange is performed per
 * delegated request; concurrent REST calls share the in-flight promise. There
 * is no timed backend-token cache — the promise lives only for the request.
 */
export class DelegationContext {
  private exchangePromise: Promise<string> | null = null;

  readonly restBaseUrl: string;

  /** RFC 8693 `resource` value required by the API's exchange validation. */
  readonly workerBackendResource: string;

  constructor(
    private readonly config: Config,
    readonly claims: McpTokenClaims,
    readonly grant: GrantContext,
    private readonly mcpToken: string,
  ) {
    this.restBaseUrl = config.restApiBaseUrl;
    this.workerBackendResource = `${config.restApiBaseUrl}/oauth/worker-delegation`;
  }

  /**
   * Exchange T_mcp for a short-lived `worker_backend` token (RFC 8693). No
   * `scope` parameter is sent, so granted scopes are preserved. In-flight
   * calls are deduped onto a single exchange request.
   */
  getBackendToken(): Promise<string> {
    if (this.exchangePromise === null) {
      this.exchangePromise = this.exchange().catch((error: unknown) => {
        this.exchangePromise = null;
        throw error;
      });
    }
    return this.exchangePromise;
  }

  /** Drop exchanged credentials and cached introspection (used on REST 401/403). */
  dropCredentials(): void {
    this.exchangePromise = null;
    invalidateIntrospection(this.claims.jti);
  }

  private async exchange(): Promise<string> {
    let response: Response;
    try {
      response = await authServerPost(this.config, {
        path: "/oauth/token",
        form: {
          grant_type: TOKEN_EXCHANGE_GRANT,
          subject_token: this.mcpToken,
          subject_token_type: ACCESS_TOKEN_TYPE,
          issued_token_type: ACCESS_TOKEN_TYPE,
          resource: this.workerBackendResource,
        },
      });
    } catch (error) {
      if (error instanceof AuthServerError) {
        // Kill switch / credentials unusable now — fail closed, no retry storm.
        throw new ExchangeError(error.failure, `Token exchange failed: ${error.failure}`);
      }
      throw error;
    }

  if (response.status !== 200) {
    // A 400 from the token endpoint is classified by the body's `error`
    // field: `invalid_grant` means the grant is no longer usable (an auth
    // failure), while the other codes indicate worker/API misconfiguration
    // and must not be masked as a dead grant.
    if (response.status === 400) {
      let errorCode: string | null = null;
      try {
        const body = (await response.json()) as { error?: unknown };
        if (typeof body.error === "string") errorCode = body.error;
      } catch {
        // Non-JSON body → generic fallback below.
      }
      const failure = errorCode !== null && KNOWN_400_ERRORS.has(errorCode)
        ? (errorCode as ExchangeFailure)
        : "invalid_400_response";
      throw new ExchangeError(
        failure,
        `Token exchange rejected with 400 (${failure})`,
      );
    }
    throw new ExchangeError(
      "invalid_response",
      `Token exchange returned ${response.status}`,
    );
  }

    const body = (await response.json()) as { access_token?: unknown };
    if (typeof body.access_token !== "string" || body.access_token.length === 0) {
      throw new ExchangeError("invalid_response", "Token exchange response missing access_token");
    }
    return body.access_token;
  }
}
