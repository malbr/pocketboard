import { URLSearchParams } from "node:url";
import { serializeErrorForLog } from "./errors";

const SENSITIVE_QUERY_KEY = /code|state|token|secret|password|key|credential|verifier|session|auth/i;

function redactRequestUrl(url: unknown): unknown {
  if (typeof url !== "string") return url;
  const queryStart = url.indexOf("?");
  if (queryStart < 0) return url;

  const params = new URLSearchParams(url.slice(queryStart + 1));
  let redacted = false;
  for (const key of params.keys()) {
    if (SENSITIVE_QUERY_KEY.test(key)) {
      params.set(key, "[redacted]");
      redacted = true;
    }
  }
  return redacted ? `${url.slice(0, queryStart)}?${params}` : url;
}

export function apiLoggerOptions(level: string) {
  return {
    level,
    serializers: { err: serializeErrorForLog },
    redact: { paths: ["req.url"], censor: redactRequestUrl },
  };
}
