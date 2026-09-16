import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuthConfigError, loadAuthConfig } from "./auth-config";

const VALID_SESSION_SECRET = "s".repeat(32);
const OWNER_ID = "325861437";

let secretsDir: string;

function writeSecretFile(name: string, contents: string): string {
  const filePath = path.join(secretsDir, name);
  fs.writeFileSync(filePath, contents, "utf8");
  return filePath;
}

function validEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    GITHUB_OAUTH_CLIENT_ID_FILE: writeSecretFile("client-id", "Iv1.placeholder"),
    GITHUB_OAUTH_CLIENT_SECRET_FILE: writeSecretFile("client-secret", "placeholder-secret-value"),
    SESSION_SECRET_FILE: writeSecretFile("session-secret", VALID_SESSION_SECRET),
    OWNER_GITHUB_USER_ID_FILE: writeSecretFile("owner-id", OWNER_ID),
    ...overrides,
  };
}

beforeEach(() => {
  secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pocketboard-auth-config-"));
});

afterEach(() => {
  fs.rmSync(secretsDir, { recursive: true, force: true });
});

describe("loadAuthConfig", () => {
  it("loads every value from the files named by the environment", () => {
    const config = loadAuthConfig(validEnv());

    expect(config.githubClientId).toBe("Iv1.placeholder");
    expect(config.githubClientSecret).toBe("placeholder-secret-value");
    expect(config.sessionSecret).toBe(VALID_SESSION_SECRET);
    expect(config.ownerGitHubUserId).toBe(325861437);
  });

  it("trims surrounding whitespace so a trailing newline in a secret file is harmless", () => {
    const config = loadAuthConfig(
      validEnv({
        GITHUB_OAUTH_CLIENT_ID_FILE: writeSecretFile("client-id-nl", "Iv1.placeholder\n"),
        OWNER_GITHUB_USER_ID_FILE: writeSecretFile("owner-id-nl", `${OWNER_ID}\n`),
      }),
    );

    expect(config.githubClientId).toBe("Iv1.placeholder");
    expect(config.ownerGitHubUserId).toBe(325861437);
  });

  it.each([
    "GITHUB_OAUTH_CLIENT_ID_FILE",
    "GITHUB_OAUTH_CLIENT_SECRET_FILE",
    "SESSION_SECRET_FILE",
    "OWNER_GITHUB_USER_ID_FILE",
  ])("fails closed when %s is not set", (variable) => {
    const env = validEnv();
    delete env[variable as keyof typeof env];

    expect(() => loadAuthConfig(env)).toThrow(AuthConfigError);
    expect(() => loadAuthConfig(env)).toThrow(
      expect.objectContaining({ code: "missing_env", variable }),
    );
  });

  it("fails closed when a configured secret file does not exist", () => {
    const env = validEnv({
      SESSION_SECRET_FILE: path.join(secretsDir, "does-not-exist"),
    });

    expect(() => loadAuthConfig(env)).toThrow(
      expect.objectContaining({ code: "unreadable_secret_file", variable: "SESSION_SECRET_FILE" }),
    );
  });

  it("fails closed when a secret file is empty or blank", () => {
    const env = validEnv({
      GITHUB_OAUTH_CLIENT_SECRET_FILE: writeSecretFile("blank", "   \n"),
    });

    expect(() => loadAuthConfig(env)).toThrow(
      expect.objectContaining({
        code: "empty_secret_file",
        variable: "GITHUB_OAUTH_CLIENT_SECRET_FILE",
      }),
    );
  });

  it("fails closed when the session secret is shorter than 32 characters", () => {
    const env = validEnv({
      SESSION_SECRET_FILE: writeSecretFile("short-session-secret", "too-short"),
    });

    expect(() => loadAuthConfig(env)).toThrow(
      expect.objectContaining({ code: "weak_session_secret", variable: "SESSION_SECRET_FILE" }),
    );
  });

  it.each(["not-a-number", "12.5", "-1", "0", "325861437abc"])(
    "fails closed when the owner id file contains %s",
    (contents) => {
      const env = validEnv({
        OWNER_GITHUB_USER_ID_FILE: writeSecretFile("bad-owner-id", contents),
      });

      expect(() => loadAuthConfig(env)).toThrow(
        expect.objectContaining({
          code: "invalid_owner_github_user_id",
          variable: "OWNER_GITHUB_USER_ID_FILE",
        }),
      );
    },
  );

  it("never leaks a secret file's contents through the thrown error", () => {
    const leakCanary = "SUPER-SECRET-CANARY-VALUE";
    const env = validEnv({
      OWNER_GITHUB_USER_ID_FILE: writeSecretFile("leaky-owner-id", leakCanary),
    });

    let thrown: unknown;
    try {
      loadAuthConfig(env);
    } catch (error) {
      thrown = error;
    }

    const serialized = `${String(thrown)} ${JSON.stringify(thrown, Object.getOwnPropertyNames(thrown))}`;
    expect(serialized).not.toContain(leakCanary);
    expect(serialized).toContain("OWNER_GITHUB_USER_ID_FILE");
  });

  it("marks cookies Secure in production and not in development", () => {
    expect(loadAuthConfig(validEnv({ TRUSTED_PROXY_IPS: "none" }), "production").cookieSecure).toBe(
      true,
    );
    expect(loadAuthConfig(validEnv(), "development").cookieSecure).toBe(false);
  });

  it("expires sessions after eight hours", () => {
    expect(loadAuthConfig(validEnv()).sessionTtlMs).toBe(8 * 60 * 60 * 1000);
  });

  it("defaults the app base url and allows an explicit override", () => {
    expect(loadAuthConfig(validEnv()).appBaseUrl).toBe("http://127.0.0.1:5173");
    expect(
      loadAuthConfig(validEnv({ APP_BASE_URL: "https://board.example.dedyn.io" })).appBaseUrl,
    ).toBe("https://board.example.dedyn.io");
  });

  it("rejects an app base url that is not a valid absolute http(s) url", () => {
    expect(() => loadAuthConfig(validEnv({ APP_BASE_URL: "not a url" }))).toThrow(
      expect.objectContaining({ code: "invalid_app_base_url", variable: "APP_BASE_URL" }),
    );
  });
});

describe("loadAuthConfig trusted proxies", () => {
  it("trusts no proxy outside production when nothing is configured", () => {
    expect(loadAuthConfig(validEnv(), "development").trustedProxies).toEqual([]);
  });

  it("refuses to start in production until the proxy boundary is stated", () => {
    // Silence here is ambiguous: it could mean "direct TLS" or "somebody forgot
    // the reverse proxy". In production the deployer has to say which.
    expect(() => loadAuthConfig(validEnv(), "production")).toThrow(
      expect.objectContaining({ code: "missing_env", variable: "TRUSTED_PROXY_IPS" }),
    );
  });

  it("accepts the explicit 'none' for a directly TLS-terminating deployment", () => {
    expect(
      loadAuthConfig(validEnv({ TRUSTED_PROXY_IPS: "none" }), "production").trustedProxies,
    ).toEqual([]);
  });

  it("accepts a narrow list of proxy addresses and networks", () => {
    expect(
      loadAuthConfig(
        validEnv({ TRUSTED_PROXY_IPS: "127.0.0.1, 172.18.0.0/16, ::1" }),
        "production",
      ).trustedProxies,
    ).toEqual(["127.0.0.1", "172.18.0.0/16", "::1"]);
  });

  it.each([
    ["true", "a blanket trust-everything switch"],
    ["*", "a wildcard"],
    ["0.0.0.0/0", "every IPv4 address"],
    ["::/0", "every IPv6 address"],
    ["2", "a hop count, which trusts whichever proxy happens to be two hops out"],
    ["proxy.example.com", "a hostname the address matcher cannot verify"],
    ["127.0.0.1/33", "an impossible prefix length"],
    ["not-an-ip", "nonsense"],
    ["127.0.0.1,", "a trailing empty entry"],
  ])("rejects %s, which would trust %s", (value) => {
    expect(() => loadAuthConfig(validEnv({ TRUSTED_PROXY_IPS: value }), "production")).toThrow(
      expect.objectContaining({
        code: "invalid_trusted_proxies",
        variable: "TRUSTED_PROXY_IPS",
      }),
    );
  });
});
