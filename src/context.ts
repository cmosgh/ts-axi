/** Per-run context handed to every command handler by `main()`. */
export interface CommandContext {
  /** Directory the command runs in; tests pass a fixture path instead of chdir. */
  cwd: string;
  /** Stdin content for `impact -` and `anchor -`; undefined = read `process.stdin`. */
  stdin?: string;
}
