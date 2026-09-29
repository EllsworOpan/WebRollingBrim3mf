import { describe, it, expect } from 'vitest';
import { translatePaint } from '../src/core/paint-codec';

describe('vendor paint encodings', () => {
  it.each([
    [1, '4', '4'],
    [16, 'DC', 'DC'],
    [17, '00EC', 'EC'],
    [18, '01EC', '0FC'],
    [32, '0FEC', 'EFC'],
    [255, 'EEEC', 'C' + 'F'.repeat(16) + 'C'],
  ] as const)('translates slot %i without changing its state', (state, prusa, bambu) => {
    expect(translatePaint(bambu, 'bambu', 'prusa')).toEqual({ hex: prusa, maxState: state });
    expect(translatePaint(prusa, 'prusa', 'bambu')).toEqual({ hex: bambu, maxState: state });
  });
  it('preserves subdivision and child order with mixed extended leaves', () => {
    // Four children: slot 1, a two-child subtree, slot 0 (inherit), slot 16.
    expect(translatePaint('4EC0FC10DC3', 'bambu', 'prusa')).toEqual({
      hex: '400EC01EC10DC3',
      maxState: 18,
    });
    expect(translatePaint('400EC01EC10DC3', 'prusa', 'bambu').hex).toBe('4EC0FC10DC3');
  });
  it('supports the shared Orca range and rejects higher or malformed paint', () => {
    expect(translatePaint('4DC1', 'orca', 'prusa').hex).toBe('4DC1');
    expect(() => translatePaint('00EC', 'prusa', 'orca')).toThrow(/1–16/);
    for (const hex of ['EC', '0FC', 'EFC'])
      expect(() => translatePaint(hex, 'orca', 'orca')).toThrow(/1–16/);
    for (const hex of ['Z', 'C', 'EC', '00EC4', '44447'])
      expect(() => translatePaint(hex, 'prusa', 'bambu')).toThrow();
    expect(() => translatePaint('0FC', 'prusa', 'bambu')).toThrow();
  });
});
