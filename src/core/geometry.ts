import { union, difference, intersect, inflatePaths, simplifyPaths, FillRule, JoinType, EndType } from 'clipper2-ts';
import type { Bounds, Point, Polygon, Ring, Rings } from './types';

// One integer unit is 1 micrometre. Rounding stays well inside JS's safe integer range.
const SCALE = 1000;
const ARC_TOLERANCE = 6; // 0.006 mm
const RULE = FillRule.NonZero;
const toInt = (rings: Rings): Rings => rings.map(ring => ring.map(p => ({ x: Math.round(p.x * SCALE), y: Math.round(p.y * SCALE) })));
const toMm = (rings: Rings): Rings => rings.map(ring => ring.map(p => ({ x: p.x / SCALE, y: p.y / SCALE })));
const clean = (rings: Rings): Rings => simplifyPaths(rings, 2, true).filter(ring => ring.length >= 3 && Math.abs(signedArea(ring)) > 100);
const offset = (rings: Rings, amount: number): Rings => rings.length ? clean(inflatePaths(rings, amount, JoinType.Round, EndType.Polygon, 2, ARC_TOLERANCE)) : [];
const merge = (rings: Rings): Rings => rings.length ? clean(union(rings, RULE)) : [];
const subtract = (a: Rings, b: Rings): Rings => a.length ? clean(difference(a, b, RULE)) : [];
const intersection = (a: Rings, b: Rings): Rings => a.length && b.length ? clean(intersect(a, b, RULE)) : [];

export function signedArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}
export function totalArea(rings: Rings): number { return Math.max(0, rings.reduce((sum, ring) => sum + signedArea(ring), 0)); }
export function boundsOf(rings: Rings): Bounds {
  const bounds: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const ring of rings) for (const p of ring) {
    bounds.minX = Math.min(bounds.minX, p.x); bounds.maxX = Math.max(bounds.maxX, p.x);
    bounds.minY = Math.min(bounds.minY, p.y); bounds.maxY = Math.max(bounds.maxY, p.y);
  }
  return bounds;
}
function pointInRing(p: Point, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if (((a.y > p.y) !== (b.y > p.y)) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
export function containsPoint(p: Point, polygon: Polygon): boolean {
  return pointInRing(p, polygon.outer) && !polygon.holes.some(hole => pointInRing(p, hole));
}

/** Clipper returns positive outer boundaries and negative holes, including nested islands. */
export function polygonsOf(rings: Rings): Polygon[] {
  const polygons = rings.filter(ring => signedArea(ring) > 0).map(outer => ({ outer, holes: [] as Rings }));
  const ordered = [...polygons].sort((a, b) => signedArea(a.outer) - signedArea(b.outer));
  for (const hole of rings.filter(ring => signedArea(ring) < 0)) {
    ordered.find(poly => pointInRing(hole[0], poly.outer))?.holes.push(hole);
  }
  return polygons;
}
const flatten = (polygon: Polygon): Rings => [polygon.outer, ...polygon.holes];
export const unionPolygons = (rings: Rings): Rings => toMm(merge(toInt(rings)));
export const offsetPolygons = (rings: Rings, mm: number): Rings => toMm(offset(toInt(rings), mm * SCALE));
export const subtractPolygons = (a: Rings, b: Rings): Rings => toMm(subtract(toInt(a), toInt(b)));

interface ReachableRegions { outside: Rings; holes: Rings; pockets: Rings; counts: { outside: number; holes: number; pockets: number } }

/**
 * Configuration space: a radius-r disk centre must lie outside offset(model, r).
 * Classify connected centre regions against the ORIGINAL free space. This is
 * essential: a narrow-neck pocket becomes enclosed after inflation, but is not a hole.
 * Dilating each selected centre region by r recovers the area a disk can cover.
 */
export function classifyRegions(modelMm: Rings, diameter: number): ReachableRegions {
  if (!modelMm.length) return { outside: [], holes: [], pockets: [], counts: { outside: 0, holes: 0, pockets: 0 } };
  const model = toInt(modelMm), radius = diameter * SCALE / 2;
  const b = boundsOf(model), margin = Math.max(radius * 5, 100 * SCALE);
  const frame: Ring = [
    { x: b.minX - margin, y: b.minY - margin }, { x: b.maxX + margin, y: b.minY - margin },
    { x: b.maxX + margin, y: b.maxY + margin }, { x: b.minX - margin, y: b.maxY + margin },
  ];
  const isOutside = (p: Polygon) => boundsOf([p.outer]).minX <= frame[0].x + 2;
  const originalHoles = polygonsOf(subtract([frame], model)).filter(poly => !isOutside(poly));
  // The extra micron eliminates zero-clearance, just-touching passages.
  const centers = polygonsOf(subtract([frame], offset(model, radius + 1)));
  const result: ReachableRegions = { outside: [], holes: [], pockets: [], counts: { outside: 0, holes: 0, pockets: 0 } };
  for (const component of centers) {
    const kind = isOutside(component) ? 'outside'
      : originalHoles.some(hole => containsPoint(component.outer[0], hole)) ? 'holes' : 'pockets';
    result.counts[kind]++;
    // Restore the clearance micron too: it controls connectivity, not the
    // distance of the recovered boundary from straight model walls.
    result[kind].push(...offset(flatten(component), radius + 1));
  }
  return { outside: toMm(merge(result.outside)), holes: toMm(merge(result.holes)), pockets: toMm(merge(result.pockets)), counts: result.counts };
}

export const intersectPolygons = (a: Rings, b: Rings): Rings => toMm(intersection(toInt(a), toInt(b)));

