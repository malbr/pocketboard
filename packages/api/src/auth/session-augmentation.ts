/**
 * Typed session payload. Nothing here may ever hold a GitHub access token.
 */
declare module "fastify" {
  interface Session {
    githubUserId?: number;
    _csrf?: string;
  }
}

export {};
