export function sampleHeights(height: number) {
  const inset = Math.min(0.001, height / 100);
  return { bottom: inset, middle: height / 2, top: height - inset };
}
