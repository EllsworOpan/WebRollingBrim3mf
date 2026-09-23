import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { strToU8 } from 'fflate';
import { Matrix4 } from 'three';
import type { Mesh } from './types';

export const NS = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';


export type Doc = ReturnType<DOMParser['parseFromString']>;
export type El = Element;
export const xml = (value: string): Doc => {
  if (/<!DOCTYPE|<!ENTITY/i.test(value)) throw new Error('XML entity declarations are not supported.');
  let problem = '';
  const doc = new DOMParser({ errorHandler: { warning: m => { problem = m; }, error: m => { problem = m; }, fatalError: m => { problem = m; } } }).parseFromString(value, 'application/xml');
  if (problem || !doc.documentElement) throw new Error('Invalid XML in the 3MF archive.');
  return doc;
};
export const serialize = (doc: Doc) => strToU8(new XMLSerializer().serializeToString(doc));
export const children = (parent: El, name: string): El[] => Array.from(parent.childNodes).filter(n => n.nodeType === 1 && (n as El).localName === name) as El[];
export const child = (parent: El, name: string): El => {
  const element = children(parent, name)[0];
  if (!element) throw new Error(`Missing ${name} in 3MF model.`);
  return element;
};
export const meta = (parent: El | undefined, key: string) => parent && children(parent, 'metadata').find(m => m.getAttribute('key') === key)?.getAttribute('value') || '';
export const num = (s: string | null) => {
  if (s === null || s.trim() === '' || !Number.isFinite(Number(s))) throw new Error('Invalid numeric value in the 3MF model.');
  return Number(s);
};
export function matrix(value: string | null, scale = 1): Matrix4 {
  const t = value?.trim() ? value.trim().split(/\s+/).map(num) : [1,0,0,0,1,0,0,0,1,0,0,0];
  if (t.length !== 12) throw new Error('Invalid 3MF placement transform.');
  const result = new Matrix4().set(t[0],t[3],t[6],t[9], t[1],t[4],t[7],t[10], t[2],t[5],t[8],t[11], 0,0,0,1);
  result.premultiply(new Matrix4().makeScale(scale,scale,scale));
  const determinant = result.determinant();
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) throw new Error('A model has an invalid or singular placement transform.');
  return result;
}
export function readMesh(element: El): Mesh {
  const vertices = children(child(element, 'vertices'), 'vertex').flatMap(v => ['x','y','z'].map(k => num(v.getAttribute(k))));
  const triangles = children(child(element, 'triangles'), 'triangle').flatMap(t => ['v1','v2','v3'].map(k => num(t.getAttribute(k))));
  if (vertices.some(n => Math.abs(n) > 1e6) || triangles.some(n => !Number.isInteger(n) || n < 0 || n >= vertices.length / 3)) throw new Error('The 3MF mesh has invalid coordinates or triangle indices.');
  if (!triangles.length) throw new Error('A model mesh contains no triangles.');
  return { vertices, triangles };
}
export function safePath(path: string): string {
  const decoded = decodeURIComponent(path).replaceAll('\\', '/').replace(/^\/+/, '');
  if (decoded.split('/').includes('..') || decoded.includes(':')) throw new Error('Unsupported archive resource path.');
  return decoded;
}
export function checkIds(elements: El[], label: string) {
  const ids = new Set<number>();
  for (const element of elements) {
    const id = num(element.getAttribute('id'));
    if (!Number.isSafeInteger(id) || id < 1) throw new Error(`Invalid ${label} ID in the 3MF.`);
    if (ids.has(id)) throw new Error(`Duplicate ${label} ID in the 3MF.`);
    ids.add(id);
  }
}
