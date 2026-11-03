/** Per-run context handed to every command handler by `main()`. */
export interface CommandContext {
  /** Directory the command runs in; tests pass a fixture path instead of chdir. */
  cwd: string;
}
