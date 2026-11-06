import { AxiError, exitCodeForError as sdkExitCode } from "axi-sdk-js";

export { AxiError };

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "GIT_ERROR"
  | "SETUP_FAILED"
  | "UNKNOWN";

/** `anchor` exit code when an anchor is not commentable; set by the handler, the output still prints. */
export const ANCHOR_INVALID_EXIT = 3;

/** SDK mapping: 2 for usage errors, 1 otherwise (`GIT_ERROR` included). */
export function exitCodeForError(error: unknown): number {
  return sdkExitCode(error);
}

export function usageError(message: string, suggestions: string[] = []): AxiError {
  return new AxiError(message, "VALIDATION_ERROR", suggestions);
}

export function axiError(
  message: string,
  code: ErrorCode,
  suggestions: string[] = [],
): AxiError {
  return new AxiError(message, code, suggestions);
}
