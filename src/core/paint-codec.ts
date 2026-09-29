// Independent implementation of vendor TriangleSelector serialization.
// Geometry and child order remain unchanged; only leaf material codes change.
export type PaintDialect = 'prusa' | 'bambu' | 'orca';

export function translatePaint(hex: string, source: PaintDialect, target: PaintDialect) {
  if (!hex) return { hex: '', maxState: 0 };
  if (!/^[\da-f]+$/i.test(hex)) throw new Error('Invalid triangle paint encoding.');
  let cursor = hex.length - 1,
    nodes = 0,
    maxState = 0;
  const next = () => {
    if (cursor < 0) throw new Error('Truncated triangle paint encoding.');
    return parseInt(hex[cursor--], 16);
  };
  const read = (depth = 0): string => {
    if (depth > 40 || ++nodes > 1_000_000)
      throw new Error('Triangle paint is too deeply subdivided.');
    const code = next(),
      sides = code & 3,
      side = code >> 2;
    if (sides) {
      if (side > 2 || (sides === 3 && side !== 0))
        throw new Error('Invalid painted triangle subdivision.');
      return (
        Array.from({ length: sides + 1 }, () => read(depth + 1))
          .reverse()
          .join('') + code.toString(16).toUpperCase()
      );
    }
    let state = side;
    if (state === 3) {
      let n = next();
      if (source === 'bambu') {
        state = 3;
        while (n === 15) {
          state += 15;
          if (state > 255) throw new Error('Unsupported paint material slot.');
          n = next();
        }
        state += n;
      } else if (source === 'prusa' && n === 14) state = 17 + next() + 16 * next();
      else {
        if (n > 13)
          throw new Error(
            source === 'orca'
              ? 'OrcaSlicer 2.4.2 supports painted material slots 1–16.'
              : 'Invalid Prusa paint prefix.',
          );
        state = n + 3;
      }
    }
    if (state > 255) throw new Error('Unsupported paint material slot.');
    if (target === 'orca' && state > 16)
      throw new Error(
        'OrcaSlicer 2.4.2 supports painted material slots 1–16. Reassign higher paint slots or retain the original slicer.',
      );
    maxState = Math.max(maxState, state);
    if (state < 3) return (state * 4).toString(16).toUpperCase();
    if (target === 'bambu')
      return (
        ((state - 3) % 15).toString(16).toUpperCase() +
        'F'.repeat(Math.floor((state - 3) / 15)) +
        'C'
      );
    return state <= 16
      ? (state - 3).toString(16).toUpperCase() + 'C'
      : (state - 17).toString(16).toUpperCase().padStart(2, '0') + 'EC';
  };
  const output = read();
  if (cursor >= 0) throw new Error('Unexpected trailing triangle paint data.');
  return { hex: output, maxState };
}
