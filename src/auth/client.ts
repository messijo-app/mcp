import { WORKER_CLIENT_ID, type Config } from "../env";

/** Authorization-server error classification shared by introspection and exchange. */
export type AuthServerFailure =
  | "unauthorized" // 401 invalid_client — credentials unusable now
  | "concealed" // 404 — OAuth routes concealed (kill switch)
  | "server_error"
  | "network";

export class AuthServerError extends Error {
  constructor(
    public readonly failure: AuthServerFailure,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "AuthServerError";
  }
}

function basicAuthHeader(secret: string): string {
  const raw = `${WORKER_CLIENT_ID}:${secret}`;
  return `Basic ${btoa(raw)}`;
}

export interface AuthServerRequestInit {
  path: string;
  form: Record<string, string>;
}

/**
 * POST to the authorization server with `client_secret_basic` as
 * `messijo-mcp-worker`. The active secret is always sent first; only if it is
 * rejected (401 invalid_client) and the retiring secret's absolute deadline has
 * not passed is the request retried once with the retiring secret.
 */
export async function authServerPost(
  config: Config,
  request: AuthServerRequestInit,
): Promise<Response> {
  let response = await postForm(config, request.path, request.form, basicAuthHeader(config.clientSecret));
  if (response.status === 401 && isRotationWindowOpen(config)) {
    await response.body?.cancel();
    response = await postForm(config, request.path, request.form, basicAuthHeader(config.retiringSecret!));
  }
  if (response.status === 401) {
    await response.body?.cancel();
    throw new AuthServerError(
      "unauthorized",
      "Authorization server rejected worker client credentials",
      401,
    );
  }
  return response;
}

function isRotationWindowOpen(config: Config): boolean {
  return (
    config.retiringSecret !== undefined &&
    config.retiringValidUntilMs !== undefined &&
    Date.now() < config.retiringValidUntilMs
  );
}

async function postForm(
  config: Config,
  path: string,
  form: Record<string, string>,
  authorization: string,
): Promise<Response> {
  const body = new URLSearchParams(form).toString();
  let response: Response;
  try {
    response = await fetch(`${config.authBaseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body,
    });
  } catch {
    throw new AuthServerError("network", `Authorization server unreachable: ${path}`);
  }

  if (response.status === 404) {
    await response.body?.cancel();
    throw new AuthServerError("concealed", `Authorization server route concealed: ${path}`, 404);
  }
  if (response.status >= 500) {
    await response.body?.cancel();
    throw new AuthServerError("server_error", `Authorization server error on ${path}`, response.status);
  }
  return response;
}
