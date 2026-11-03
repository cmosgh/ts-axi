import { AxiError, exitCodeForError as sdkExitCode } from "axi-sdk-js";

export { AxiError };

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "GIT_ERROR"
  | "UNKNOWN";

/** SDK mapping (2 usage, 1 otherwise) plus `GIT_ERROR` → 3. */
export function exitCodeForError(error: unknown): number {
  if (error instanceof AxiError && error.code === "GIT_ERROR") return 3;
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
