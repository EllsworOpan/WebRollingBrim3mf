export type JsonObject = Record<string, unknown>;
export const fail = (reason: string): never => { throw new Error(`Unsupported PrusaSlicer 3.0 project: ${reason} Supported format: 3.0.0-alpha12 FFF with rectangular beds.`); };
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

// Only these sections are read by the adapter. All configuration values,
// material slots and virtual-extruder definitions remain opaque source data.
export function configuration(value: unknown): JsonObject {
  const config = record(value, 'configuration');
  for (const name of ['printer_settings','print_settings','toolprint_settings']) record(config[name], name);
  return config;
}
