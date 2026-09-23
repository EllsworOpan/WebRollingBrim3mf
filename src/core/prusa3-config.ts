import schemaData from './prusa3-schema.json';

export type JsonObject = Record<string, unknown>;
export const fail = (reason: string): never => { throw new Error(`Unsupported PrusaSlicer 3.0 project: ${reason} Supported format: 3.0.0-alpha12, single-tool FFF with rectangular beds.`); };
export function record(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  return value as JsonObject;
}
export function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array.`);
  return value as unknown[];
}
export function keys(value: JsonObject, allowed: string[], label: string) {
  const unknown = Object.keys(value).find(key => !allowed.includes(key));
  if (unknown) fail(`Unrecognized ${label} field: ${unknown}.`);
}
export function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e6) fail(`Invalid ${label}.`);
  return value as number;
}
export function integer(value: unknown, label: string, min = 0): number {
  const n = finite(value, label);
  if (!Number.isSafeInteger(n) || n < min) fail(`Invalid ${label}.`);
  return n;
}

interface Setting { type: string; element?: string; values?: string[]; overrides?: string[]; nullable?: boolean }
const schema = schemaData as Record<string, Record<string, Setting>>;
// Generated from the official alpha12 --export-config-schema, retaining only
// setting names/types/enums/scopes. See docs/prusaslicer-3-readiness.md.
function valid(value: unknown, setting: Setting): boolean {
  switch (setting.type) {
    case 'Array': return Array.isArray(value) && value.every(v => valid(v, {...setting, type:setting.element!}));
    case 'Bool': return typeof value === 'boolean';
    case 'String': return typeof value === 'string';
    case 'OptInt': return value === null || (typeof value === 'number' && Number.isSafeInteger(value));
    case 'Int': return typeof value === 'number' && Number.isSafeInteger(value);
    case 'Float': return typeof value === 'number' && Number.isFinite(value);
    case 'Enum': return typeof value === 'string' && !!setting.values?.includes(value);
    case 'Vec2d': return Array.isArray(value) && value.length === 2 && value.every(v => typeof v === 'number' && Number.isFinite(v));
    case 'Percentage':
    case 'FloatOrPercentage': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const v = value as JsonObject;
      return Object.keys(v).length === 2 && typeof v.value === 'number' && Number.isFinite(v.value) && typeof v.is_percent === 'boolean' && (setting.type !== 'Percentage' || v.is_percent);
    }
    default: return false;
  }
}
export function settings(value: unknown, scope: 'Object' | 'Volume'): JsonObject {
  const box = record(value ?? {}, `${scope} settings`);
  for (const [key, v] of Object.entries(box)) {
    const setting = key === 'extruder' ? {type:'Int'} : key === (scope === 'Object' ? 'wipe_into_objects' : 'wipe_into_infill') ? {type:'Bool'} : Object.values(schema).flatMap(s => Object.entries(s)).find(([k,s]) => k === key && s.overrides?.includes(scope))?.[1];
    if (!setting || !valid(v,setting)) fail(`Unknown or changed ${scope.toLowerCase()} setting: ${key}.`);
    if (key.endsWith('extruder') && (Number(v) < 0 || Number(v) > 1)) fail('Multiple tools/materials are not supported yet.');
  }
  return box;
}
export function configuration(value: unknown): JsonObject {
  const config = record(value, 'configuration');
  keys(config, [...Object.keys(schema), 'project_settings'], 'configuration');
  for (const [name, value] of Object.entries(config)) {
    const box = record(value, name);
    if (name === 'project_settings') {
      keys(box, ['extruder_colour','wiping_volumes_matrix','wiping_volumes_use_custom_matrix'], name);
      if (!Array.isArray(box.extruder_colour) || box.extruder_colour.length !== 1 || typeof box.extruder_colour[0] !== 'string') fail('Multiple materials or missing filament colors.');
      if (!Array.isArray(box.wiping_volumes_matrix) || box.wiping_volumes_matrix.some(v => typeof v !== 'number') || typeof box.wiping_volumes_use_custom_matrix !== 'boolean') fail('Changed project settings.');
      continue;
    }
    for (const [key,v] of Object.entries(box)) {
      const spec = schema[name]?.[key];
      const vector = name === 'toolprint_settings' || name === 'filament_settings';
      if (!spec || (vector ? !Array.isArray(v) || v.length !== 1 || !v.every(x => (x === null && spec.nullable) || valid(x,spec)) : !valid(v,spec))) fail(`Unknown or changed ${name} setting: ${key}.`);
    }
  }
  for (const name of Object.keys(schema)) record(config[name], name);
  return config;
}
