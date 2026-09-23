export const MIN_LAYER_HEIGHT = 0.05;
export const MAX_LAYER_HEIGHT = 1;

export function sampleHeights(height: number) {
  // Comparison cuts are illustrative sections inside the first layer, not a
  // bed-contact test. A one-micron cut can miss otherwise flat STL bases with
  // tiny Z offsets (e.g. 0.0015 mm). Keep the midpoint used for brims unchanged.
  const inset = Math.min(0.01, height / 20);
  return { bottom: inset, middle: height / 2, top: height - inset };
}

// Thin layers can use comparison cuts such as 0.0025 mm. Do not label those
// as 0.003 mm while drawing a different plane.
export const formatSampleHeight = (height: number) => height.toFixed(4).replace(/0$/, '');
