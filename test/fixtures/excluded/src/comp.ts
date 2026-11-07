export function Comp(): () => void {
  const handler = { label: "tap" };
  function onTap(): void {
    console.log(handler.label);
  }
  onTap();
  return () => onTap();
}

export function Primary(): void {
  function onPress(): number {
    return 1;
  }
  onPress();
}

export function Secondary(): void {
  const onPress = (): number => 2;
  onPress();
}
