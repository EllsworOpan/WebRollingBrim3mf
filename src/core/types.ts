export interface Point { x: number; y: number }
export type Ring = Point[];
export type Rings = Ring[];
export interface Polygon { outer: Ring; holes: Rings }
export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }
export interface Mesh { vertices: number[]; triangles: number[] }
export interface ModelPart { name: string; kind: string; mesh: Mesh }
export interface ModelObject { id: string; name: string; parts: ModelPart[]; resourceId: string; buildIndex: number; transform: number[] }
export interface Project {
  name: string; objects: ModelObject[]; warnings: string[]; bed: Ring;
  source?: { files: Record<string, Uint8Array>; modelPath: string };
  suggestedHeight?: number;
}
export interface BrimSettings { diameter: number; width: number; gap: number; height: number; holes: boolean; pockets: boolean; perimeters: number }
export const MIN_DIAMETER = 0.05;
export const MAX_DIAMETER = 100;
export const DIAMETER_STEP = 0.01;
export const DEFAULT_BRIM: BrimSettings = { diameter: 10, width: 5, gap: 0.1, height: 0.2, holes: false, pockets: false, perimeters: 99 };
export interface ObjectBrim { id: string; footprint: Rings; bottom: Rings; top: Rings; area: Rings; uncovered: Polygon[]; mesh: Mesh; areaMm2: number; changeArea: number; warnings: string[] }
export interface BrimResult { objects: ObjectBrim[]; circleSweep: Rings; regions: { outside: number; holes: number; pockets: number }; bounds: Bounds; warnings: string[]; settings: BrimSettings; computeMs: number }
export interface DiameterProgress { diameter: number; checks: number; stage: 'searching' | 'verifying' }
export type DiameterOutcome = { status: 'found'; result: BrimResult; atLimit: boolean } | { status: 'no-solution'; uncovered: number } | { status: 'no-footprints' };
export type WorkerRequest = { type: 'load'; id: number; name: string; bytes: ArrayBuffer } | { type: 'generate' | 'export' | 'maximize'; id: number; settings: BrimSettings; enabled: string[] } | { type: 'cancel'; id: number };
export type WorkerResponse = { type: 'loaded'; id: number; project: Omit<Project, 'source'> } | { type: 'generated'; id: number; result: BrimResult } | { type: 'exported'; id: number; bytes: Uint8Array } | { type: 'maximizing'; id: number; progress: DiameterProgress } | { type: 'maximized'; id: number; outcome: DiameterOutcome } | { type: 'cancelled'; id: number } | { type: 'error'; id: number; message: string };
