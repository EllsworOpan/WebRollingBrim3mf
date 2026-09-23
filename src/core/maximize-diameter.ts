import { brimGeometry, footprint, generateBrims, uncoveredFootprints, validateBrimSettings } from './brim';
import { sampleHeights } from './first-layer';
import { polygonsOf } from './geometry';
import { DIAMETER_STEP, MAX_DIAMETER, MIN_DIAMETER, type BrimSettings, type DiameterOutcome, type DiameterProgress, type Project } from './types';

/** Yield between evaluations so the worker can report progress and cancel. */
export function* maximizeDiameter(project: Project, settings: BrimSettings, enabled = project.objects.map(o => o.id)): Generator<DiameterProgress, DiameterOutcome> {
  validateBrimSettings(settings);
  const z = sampleHeights(settings.height).middle;
  // Slice only once per enabled object. Candidates reuse the same footprints.
  const shapes = project.objects.filter(o => enabled.includes(o.id)).map(o => {
    const shape = footprint(o, z);
    return { shape, islands: polygonsOf(shape) };
  }).filter(o => o.islands.length);
  if (!shapes.length) return { status: 'no-footprints' };

  // Integer hundredths avoid accumulating floating-point error at the limit.
  let low = Math.round(MIN_DIAMETER / DIAMETER_STEP), high = Math.round(MAX_DIAMETER / DIAMETER_STEP), checks = 0;
  const diameterOf = (tick: number) => Number((tick * DIAMETER_STEP).toFixed(2));
  const check = (tick: number) => {
    const candidate = { ...settings, diameter: diameterOf(tick) };
    const uncovered = shapes.reduce((sum, o) => sum + uncoveredFootprints(o.islands, brimGeometry(o.shape, candidate).area, candidate.gap).length, 0);
    checks++;
    return uncovered;
  };
  const progress = (tick: number): DiameterProgress => ({ diameter: diameterOf(tick), checks, stage: 'searching' });

  const uncovered = check(low);
  yield progress(low);
  if (uncovered) return { status: 'no-solution', uncovered };
  const atLimit = check(high) === 0;
  yield progress(high);
  if (atLimit) low = high;
  else {
    // With the other settings fixed, increasing the circle loses access.
    // Keep a verified passing low and a failing high, one hundredth apart.
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (check(middle) === 0) low = middle;
      else high = middle;
      yield progress(middle);
    }
  }
  yield { diameter: diameterOf(low), checks, stage: 'verifying' };
  const result = generateBrims(project, { ...settings, diameter: diameterOf(low) }, enabled);
  if (result.objects.some(o => o.uncovered.length)) throw new Error('Could not verify coverage at the optimized diameter. The diameter was left unchanged.');
  return { status: 'found', result, atLimit };
}
