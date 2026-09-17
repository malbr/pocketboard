import fs from "node:fs";
import net from "node:net";
import { repositoryRoot, resolveFromRepositoryRoot } from "./repository-root";

/**
 * Secrets are never read from the environment directly. The environment only
 * names a file path; the value itself lives in a root-owned file on the host
 * (see CONTEXT.md, "Production operations"). Every failure here is fatal: the
 * API must not start with a partially configured owner-only auth boundary.
 */
export type AuthConfigErrorCode =
  | "missing_env"
  | "unreadable_secret_file"
  | "empty_secret_file"
  | "weak_session_secret"
  | "invalid_owner_github_user_id"
  | "invalid_app_base_url"
  | "invalid_trusted_proxies";

export class AuthConfigError extends Error {
  readonly code: AuthConfigErrorCode;
  readonly variable: string;

  constructor(code: AuthConfigErrorCode, variable: string) {
    // The message names the variable only. Secret file contents must never
    // reach a log line, a stack trace, or a crash report.
    super(`Auth configuration failed: ${code} for ${variable}`);
    this.name = "AuthConfigError";
    this.code = code;
    this.variable = variable;
  }
}

export interface AuthConfig {
  githubClientId: string;
  githubClientSecret: string;
  sessionSecret: string;
  ownerGitHubUserId: number;
  appBaseUrl: string;
  cookieSecure: boolean;
  sessionTtlMs: number;
  /**
   * Addresses and networks whose `X-Forwarded-*` headers may be believed. An
   * empty list means no proxy is trusted and `request.protocol` reflects the
   * socket only.
   */
  trustedProxies: string[];
}

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MIN_SESSION_SECRET_LENGTH = 32;
// 127.0.0.1, not localhost: GitHub matches the registered callback URL exactly,
// and the approved OAuth app registers the literal 127.0.0.1 form.
const DEFAULT_APP_BASE_URL = "http://127.0.0.1:5173";

type AuthEnv = Record<string, string | undefined>;

function readSecretFile(env: AuthEnv, variable: string, baseDir: string): string {
  const filePath = env[variable];
  if (!filePath || filePath.trim() === "") {
    throw new AuthConfigError("missing_env", variable);
  }

  let raw: string;
  try {
    // A relative path is relative to the repository, never to whichever
    // workspace directory npm happened to start the process in.
    raw = fs.readFileSync(resolveFromRepositoryRoot(filePath.trim(), baseDir), "utf8");
  } catch {
    // The underlying error can embed the path but never the contents; we drop
    // it anyway so nothing about the secret store leaks into a stack trace.
    throw new AuthConfigError("unreadable_secret_file", variable);
  }

  const value = raw.trim();
  if (value === "") {
    throw new AuthConfigError("empty_secret_file", variable);
  }
  return value;
}

function readOwnerGitHubUserId(env: AuthEnv, baseDir: string): number {
  const variable = "OWNER_GITHUB_USER_ID_FILE";
  const raw = readSecretFile(env, variable, baseDir);

  // GitHub numeric user IDs are immutable, unlike the login handle, so they are
  // the only safe thing to authorize against.
  if (!/^[0-9]+$/.test(raw)) {
    throw new AuthConfigError("invalid_owner_github_user_id", variable);
  }

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new AuthConfigError("invalid_owner_github_user_id", variable);
  }
  return parsed;
}

function readAppBaseUrl(env: AuthEnv): string {
  const raw = env.APP_BASE_URL?.trim();
  if (!raw) {
    return DEFAULT_APP_BASE_URL;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AuthConfigError("invalid_app_base_url", "APP_BASE_URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AuthConfigError("invalid_app_base_url", "APP_BASE_URL");
  }
  return raw.replace(/\/$/, "");
}

/**
 * Accepts a single literal address (`127.0.0.1`, `::1`) or a CIDR network
 * (`172.18.0.0/16`). Everything else is refused, including the values that look
 * convenient but hand the forwarded headers to anyone who can reach the
 * socket: `true`, `*`, a hop count, a hostname, and any `/0` network.
 */
function isNarrowProxyEntry(entry: string): boolean {
  const [address, prefix, ...extra] = entry.split("/");
  if (extra.length > 0) {
    return false;
  }

  const family = net.isIP(address);
  if (family === 0) {
    return false;
  }

  if (prefix === undefined) {
    // A bare unspecified address matches every peer, same as a /0 network.
    return address !== "0.0.0.0" && address !== "::";
  }

  if (!/^[0-9]{1,3}$/.test(prefix)) {
    return false;
  }
  const bits = Number(prefix);
  return bits > 0 && bits <= (family === 4 ? 32 : 128);
}

function readTrustedProxies(env: AuthEnv, nodeEnv: string | undefined): string[] {
  const variable = "TRUSTED_PROXY_IPS";
  const raw = env[variable]?.trim();

  if (!raw) {
    // Behind a TLS-terminating proxy, an unconfigured boundary makes the Secure
    // session cookie silently undeliverable, so production has to be explicit
    // about whether a proxy exists rather than fail at first login.
    if (nodeEnv === "production") {
      throw new AuthConfigError("missing_env", variable);
    }
    return [];
  }

  if (raw === "none") {
    return [];
  }

  const entries = raw.split(",").map((entry) => entry.trim());
  if (!entries.every(isNarrowProxyEntry)) {
    throw new AuthConfigError("invalid_trusted_proxies", variable);
  }
  return entries;
}

export function loadAuthConfig(
  env: AuthEnv,
  nodeEnv = env.NODE_ENV,
  secretBaseDir = repositoryRoot,
): AuthConfig {
  const sessionSecret = readSecretFile(env, "SESSION_SECRET_FILE", secretBaseDir);
  if (sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new AuthConfigError("weak_session_secret", "SESSION_SECRET_FILE");
  }

  return {
    githubClientId: readSecretFile(env, "GITHUB_OAUTH_CLIENT_ID_FILE", secretBaseDir),
    githubClientSecret: readSecretFile(env, "GITHUB_OAUTH_CLIENT_SECRET_FILE", secretBaseDir),
    sessionSecret,
    ownerGitHubUserId: readOwnerGitHubUserId(env, secretBaseDir),
    appBaseUrl: readAppBaseUrl(env),
    cookieSecure: nodeEnv === "production",
    sessionTtlMs: SESSION_TTL_MS,
    trustedProxies: readTrustedProxies(env, nodeEnv),
  };
}
