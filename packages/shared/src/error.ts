import { z } from "zod";

/**
 * The single body the API sends for any failure it did not intend. It carries
 * no message, stack, SQL text, or framework code, so a driver or plugin error
 * cannot describe the server's internals to a caller.
 */
export const ApiErrorCode = {
  InternalError: "internal_error",
} as const;

export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];

export const internalErrorSchema = z
  .object({ error: z.literal(ApiErrorCode.InternalError) })
  .strict();

export type InternalError = z.infer<typeof internalErrorSchema>;
