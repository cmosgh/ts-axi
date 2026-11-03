export function parse(input: string): string[] {
  return input.split(",").map((part) => part.trim());
}
