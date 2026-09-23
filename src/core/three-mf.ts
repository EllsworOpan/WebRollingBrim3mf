import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { Matrix4 } from 'three';
import { compactMesh, loadStl, transformMesh } from './mesh';
import { importObj } from './obj';
import type { BrimResult, Mesh, ModelObject, ModelPart, Project } from './types';

const NS = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const CONFIG = 'Metadata/Slic3r_PE_model.config';
const MARKER = 'rolling-brim.generated.stl';
type Doc = ReturnType<DOMParser['parseFromString']>;
type El = Element;
const xml = (value: string): Doc => {
  if (/<!DOCTYPE|<!ENTITY/i.test(value)) throw new Error('XML entity declarations are not supported.');
  let problem = '';
  const doc = new DOMParser({ errorHandler: { warning: m => { problem = m; }, error: m => { problem = m; }, fatalError: m => { problem = m; } } }).parseFromString(value, 'application/xml');
  if (problem || !doc.documentElement) throw new Error('Invalid XML in the 3MF archive.');
  return doc;
};
const serialize = (doc: Doc) => strToU8(new XMLSerializer().serializeToString(doc));
const children = (parent: El, name: string): El[] => Array.from(parent.childNodes).filter(n => n.nodeType === 1 && (n as El).localName === name) as El[];
const child = (parent: El, name: string): El => {
  const element = children(parent, name)[0];
  if (!element) throw new Error(`Missing ${name} in 3MF model.`);
  return element;
};
const meta = (parent: El | undefined, key: string) => parent && children(parent, 'metadata').find(m => m.getAttribute('key') === key)?.getAttribute('value') || '';
const generated = (volume: El) => meta(volume, 'source_file') === MARKER;
const num = (s: string | null) => {
  if (s === null || s.trim() === '' || !Number.isFinite(Number(s))) throw new Error('Invalid numeric value in the 3MF model.');
  return Number(s);
};
function matrix(value: string | null, scale = 1): Matrix4 {
  const t = value?.trim() ? value.trim().split(/\s+/).map(num) : [1,0,0,0,1,0,0,0,1,0,0,0];
  if (t.length !== 12) throw new Error('Invalid 3MF placement transform.');
  const result = new Matrix4().set(t[0],t[3],t[6],t[9], t[1],t[4],t[7],t[10], t[2],t[5],t[8],t[11], 0,0,0,1);
  result.premultiply(new Matrix4().makeScale(scale,scale,scale));
  if (Math.abs(result.determinant()) < 1e-12) throw new Error('A model has a singular placement transform.');
  return result;
}
function readMesh(element: El): Mesh {
  const vertices = children(child(element, 'vertices'), 'vertex').flatMap(v => ['x','y','z'].map(k => num(v.getAttribute(k))));
  const triangles = children(child(element, 'triangles'), 'triangle').flatMap(t => ['v1','v2','v3'].map(k => num(t.getAttribute(k))));
  if (vertices.some(n => Math.abs(n) > 1e6) || triangles.some(n => !Number.isInteger(n) || n < 0 || n >= vertices.length / 3)) throw new Error('The 3MF mesh has invalid coordinates or triangle indices.');
  if (!triangles.length) throw new Error('A model mesh contains no triangles.');
  return { vertices, triangles };
}
function safePath(path: string): string {
  const decoded = decodeURIComponent(path).replaceAll('\\', '/').replace(/^\/+/, '');
  if (decoded.split('/').includes('..') || decoded.includes(':')) throw new Error('Unsupported archive resource path.');
  return decoded;
}
export function importProject(name: string, bytes: ArrayBuffer): Project {
  if (bytes.byteLength > 200_000_000) throw new Error('Choose a file smaller than 200 MB.');
  if (/\.obj$/i.test(name)) return importObj(name, bytes);
  if (/\.stl$/i.test(name)) {
    const mesh = loadStl(bytes);
    return { name, objects: [{ id: 'object-0', name: name.replace(/\.stl$/i, ''), resourceId: '1', buildIndex: 0, transform: new Matrix4().toArray(), parts: [{ name, kind: 'ModelPart', mesh }] }], bed: [], warnings: ['STL units are assumed to be millimetres. The model was placed on Z=0; disconnected shells remain one object.'] };
  }
  if (!/\.3mf$/i.test(name)) throw new Error('Choose an STL, OBJ or 3MF file.');
  let expanded = 0, entries = 0;
  const files = unzipSync(new Uint8Array(bytes), { filter: file => {
    expanded += file.originalSize; entries++;
    if (expanded > 500_000_000 || entries > 10000) throw new Error('The expanded 3MF exceeds the browser processing limit.');
    safePath(file.name); return true;
  } });
  if (files['Metadata/model_settings.config'] || files['Metadata/project_settings.config']) throw new Error('This Bambu/Orca project uses a different settings format. Open it in PrusaSlicer and save a PrusaSlicer 3MF project first.');
  const rels = files['_rels/.rels'] && xml(strFromU8(files['_rels/.rels']));
  const relation = rels && children(rels.documentElement, 'Relationship').find(r => /\/3dmodel$/.test(r.getAttribute('Type') || ''));
  if (!relation || relation.getAttribute('TargetMode') === 'External') throw new Error('The 3MF has no internal model relationship.');
  const modelPath = safePath(relation.getAttribute('Target') || '');
  if (!files[modelPath]) throw new Error('The 3MF model resource is missing.');
  const doc = xml(strFromU8(files[modelPath])), root = doc.documentElement;
  if ((root.getAttribute('requiredextensions') || '').trim()) throw new Error('This 3MF requires extensions not supported by this workbench. Save a standard PrusaSlicer 3MF first.');
  const units: Record<string, number> = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };
  const scale = units[root.getAttribute('unit') || 'millimeter'];
  if (!scale) throw new Error('Unsupported 3MF measurement unit.');
  const resources = children(child(root, 'resources'), 'object');
  const configs = files[CONFIG] ? children(xml(strFromU8(files[CONFIG])).documentElement, 'object') : [];
  const warnings: string[] = [];
  let meshCount = 0;
  const partsFor = (id: string, transform: Matrix4, seen = new Set<string>()): ModelPart[] => {
    if (seen.has(id) || seen.size > 64) throw new Error('The 3MF has circular or excessive component nesting.');
    seen = new Set(seen).add(id);
    const resource = resources.find(r => r.getAttribute('id') === id);
    if (!resource) throw new Error('A 3MF component references a missing object.');
    const meshElement = children(resource, 'mesh')[0];
    if (!meshElement) return children(child(resource, 'components'), 'component').flatMap(c => {
      if (Array.from(c.attributes).some(a => a.localName === 'path')) throw new Error('External model components are not supported. Save this as a PrusaSlicer 3MF project first.');
      return partsFor(c.getAttribute('objectid') || '', transform.clone().multiply(matrix(c.getAttribute('transform'))), seen);
    });
    const mesh = readMesh(meshElement);
    meshCount += mesh.triangles.length / 3;
    if (meshCount > 2_000_000) throw new Error('This scene exceeds the two-million-triangle browser limit.');
    const config = configs.find(c => c.getAttribute('id') === id), volumes = config ? children(config, 'volume') : [];
    if (!volumes.length) return [{ name: meta(config, 'name') || resource.getAttribute('name') || `Model ${id}`, kind: 'ModelPart', mesh: transformMesh(mesh, transform) }];
    return volumes.filter(v => !generated(v)).map(volume => {
      const first = num(volume.getAttribute('firstid')), last = num(volume.getAttribute('lastid'));
      if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || last < first || last >= mesh.triangles.length / 3) throw new Error('A 3MF part has invalid triangle ranges.');
      const kind = meta(volume, 'volume_type') || (meta(volume, 'modifier') === '1' ? 'ParameterModifier' : 'ModelPart');
      if (!['ModelPart','NegativeVolume','ParameterModifier','SupportEnforcer','SupportBlocker'].includes(kind)) throw new Error(`Unsupported part type: ${kind}`);
      return { name: meta(volume, 'name') || `Part ${first}`, kind, mesh: transformMesh(compactMesh({ vertices: mesh.vertices, triangles: mesh.triangles.slice(first * 3, (last + 1) * 3) }), transform) };
    });
  };
  const objects: ModelObject[] = [];
  children(child(root, 'build'), 'item').forEach((item, index) => {
    if (item.getAttribute('printable') === '0') return;
    const id = item.getAttribute('objectid') || '', config = configs.find(c => c.getAttribute('id') === id);
    const transform = matrix(item.getAttribute('transform'), scale), parts = partsFor(id, transform);
    if (parts.some(p => p.kind === 'ModelPart')) objects.push({ id: `object-${index}`, name: meta(config, 'name') || resources.find(r => r.getAttribute('id') === id)?.getAttribute('name') || parts[0]?.name || `Object ${index + 1}`, resourceId: id, buildIndex: index, transform: transform.toArray(), parts });
  });
  if (!objects.length) throw new Error('This 3MF contains no printable model objects.');
  if (objects.some(o => o.parts.some(p => p.kind === 'NegativeVolume'))) warnings.push('Negative volumes are applied in the footprint view. The 3D view shows the original positive meshes.');
  if (resources.some(r => children(r, 'components').length) && Array.from(root.getElementsByTagName('*')).some(e => e.hasAttribute('pid'))) throw new Error('Component assemblies with material/color assignments are not supported. Save a standard PrusaSlicer 3MF first.');
  const ini = files['Metadata/Slic3r_PE.config'] ? strFromU8(files['Metadata/Slic3r_PE.config']) : '';
  const setting = (key: string) => ini.match(new RegExp(`^;?\\s*${key}\\s*=\\s*(.+)$`, 'm'))?.[1].trim();
  const height = setting('first_layer_height');
  const bed = (setting('bed_shape') || '').split(',').filter(Boolean).map(p => { const [x,y] = p.split('x').map(Number); return { x,y }; });
  if (bed.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new Error('The project has an invalid bed shape.');
  if (!bed.length) warnings.push('No print bed is stored in this file; brim edges are not clipped to a bed.');
  if (Number(setting('xy_size_compensation')) !== 0 && setting('xy_size_compensation')) warnings.push('The project applies XY size compensation. The preview shows uncompensated mesh sections; check the final gap after slicing.');
  if (Number(setting('raft_layers')) > 0) throw new Error('Raft projects are not supported. Disable the raft and place the model on the bed first.');
  if (Number(setting('brim_width')) > 0) warnings.push('Native slicer brim is enabled in this project and may add another brim. Turn it off in PrusaSlicer if unwanted.');
  if (configs.some(c => children(c, 'volume').some(generated))) warnings.push('Previously generated rolling-brim parts will be replaced on export.');
  return { name, objects, bed, warnings, source: { files, modelPath }, suggestedHeight: height && !height.endsWith('%') && Number(height) > 0 ? Number(height) : undefined };
}

function addMeta(doc: Doc, parent: El, type: string, key: string, value: string) {
  const node = doc.createElement('metadata'); node.setAttribute('type', type); node.setAttribute('key', key); node.setAttribute('value', value); parent.appendChild(node);
}
function setMeta(doc: Doc, parent: El, type: string, key: string, value: string) {
  for (const node of children(parent, 'metadata').filter(m => m.getAttribute('key') === key)) parent.removeChild(node);
  addMeta(doc, parent, type, key, value);
}
function addMesh(doc: Doc, object: El, mesh: Mesh): El {
  const node = doc.createElementNS(NS, 'mesh'), vertices = doc.createElementNS(NS, 'vertices'), triangles = doc.createElementNS(NS, 'triangles');
  node.appendChild(vertices); node.appendChild(triangles); object.appendChild(node); appendMesh(doc, node, mesh); return node;
}
function appendMesh(doc: Doc, element: El, mesh: Mesh) {
  const vertices = child(element, 'vertices'), triangles = child(element, 'triangles'), base = children(vertices, 'vertex').length;
  for (let i = 0; i < mesh.vertices.length; i += 3) {
    const v = doc.createElementNS(NS, 'vertex'); ['x','y','z'].forEach((key,j) => v.setAttribute(key, String(mesh.vertices[i+j]))); vertices.appendChild(v);
  }
  for (let i = 0; i < mesh.triangles.length; i += 3) {
    const t = doc.createElementNS(NS, 'triangle'); ['v1','v2','v3'].forEach((key,j) => t.setAttribute(key, String(base + mesh.triangles[i+j]))); triangles.appendChild(t);
  }
}
function partConfig(doc: Doc, parent: El, first: number, count: number, name: string, kind = 'ModelPart'): El {
  const v = doc.createElement('volume'); v.setAttribute('firstid', String(first)); v.setAttribute('lastid', String(first + count - 1));
  addMeta(doc, v, 'volume', 'name', name); addMeta(doc, v, 'volume', 'volume_type', kind); parent.appendChild(v); return v;
}
export function exportProject(project: Project, result: BrimResult): Uint8Array {
  if (!result.objects.some(o => o.mesh.triangles.length)) throw new Error('Generate at least one brim before exporting.');
  const files: Record<string, Uint8Array> = { ...project.source?.files };
  const modelPath = project.source?.modelPath || '3D/3dmodel.model';
  const doc = files[modelPath] ? xml(strFromU8(files[modelPath])) : xml(`<model unit="millimeter" xml:lang="en-US" xmlns="${NS}" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06"><metadata name="slic3rpe:Version3mf">1</metadata><resources/><build/></model>`);
  const config = files[CONFIG] ? xml(strFromU8(files[CONFIG])) : xml('<config/>');
  const root = doc.documentElement, resources = child(root, 'resources'), build = child(root, 'build');
  if (!Array.from(root.getElementsByTagName('metadata')).some(m => m.getAttribute('name') === 'slic3rpe:Version3mf')) {
    root.setAttribute('xmlns:slic3rpe', 'http://schemas.slic3r.org/3mf/2017/06');
    const m = doc.createElementNS(NS, 'metadata'); m.setAttribute('name', 'slic3rpe:Version3mf'); m.appendChild(doc.createTextNode('1')); root.insertBefore(m, resources);
  }
  let nextId = Math.max(0, ...Array.from(resources.childNodes).filter(n => n.nodeType === 1).map(n => Number((n as El).getAttribute('id')) || 0)) + 1;
  const originalResources = children(resources, 'object'), originalConfigs = children(config.documentElement, 'object');
  const buildItems = children(build, 'item');
  for (const object of project.objects) {
    const brim = result.objects.find(o => o.id === object.id)!;
    const original = originalResources.find(r => r.getAttribute('id') === object.resourceId);
    const oldConfig = originalConfigs.find(c => c.getAttribute('id') === object.resourceId);
    const direct = original && children(original, 'mesh').length > 0;
    const repeated = buildItems.filter(item => item.getAttribute('objectid') === object.resourceId).length > 1;
    if (repeated && Object.keys(files).some(p => /layer_heights_profile|layer_config_ranges/.test(p))) throw new Error('Repeated instances with custom layer-height profiles need to be made independent objects in PrusaSlicer before export.');
    const id = original && !repeated ? object.resourceId : String(nextId++);
    const out = direct ? original.cloneNode(true) as El : doc.createElementNS(NS, 'object');
    out.setAttribute('id', id); out.setAttribute('type', 'model');
    const cfg = oldConfig ? oldConfig.cloneNode(true) as El : config.createElement('object'); cfg.setAttribute('id', id); cfg.setAttribute('instances_count', '1');
    if (!oldConfig) addMeta(config, cfg, 'object', 'name', object.name);
    // PrusaSlicer scopes elephant-foot compensation to the parent object, so
    // this applies to both its original model parts and the attached brim.
    setMeta(config, cfg, 'object', 'elefant_foot_compensation', '0');
    let meshElement: El;
    if (direct) {
      meshElement = child(out, 'mesh');
      const triangles = child(meshElement, 'triangles'), all = children(triangles, 'triangle');
      const volumes = children(cfg, 'volume');
      const remove = new Set<number>();
      for (const v of volumes.filter(generated)) { for (let i = Number(v.getAttribute('firstid')); i <= Number(v.getAttribute('lastid')); i++) remove.add(i); cfg.removeChild(v); }
      if (remove.size) {
        const removedBefore = (n: number) => [...remove].filter(i => i < n).length;
        for (const v of volumes.filter(v => !generated(v))) { for (const key of ['firstid','lastid']) { const n = Number(v.getAttribute(key)); v.setAttribute(key, String(n - removedBefore(n))); } }
        all.forEach((t,i) => { if (remove.has(i)) triangles.removeChild(t); });
      }
      if (!children(cfg, 'volume').length) partConfig(config, cfg, 0, children(triangles, 'triangle').length, object.name);
    } else {
      // Generic component assemblies are flattened into one multipart object per
      // build item. Preserve the world placement and each component's grouping.
      if (oldConfig) throw new Error('This project combines component assemblies with slicer-specific settings. Save it as a standard PrusaSlicer 3MF first.');
      meshElement = addMesh(doc, out, { vertices: [], triangles: [] });
      for (const part of object.parts) {
        const first = children(child(meshElement, 'triangles'), 'triangle').length;
        appendMesh(doc, meshElement, transformMesh(part.mesh, new Matrix4().fromArray(object.transform).invert()));
        partConfig(config, cfg, first, part.mesh.triangles.length / 3, part.name, part.kind);
      }
    }
    if (brim.mesh.triangles.length) {
      const first = children(child(meshElement, 'triangles'), 'triangle').length;
      const local = transformMesh(brim.mesh, new Matrix4().fromArray(object.transform).invert());
      appendMesh(doc, meshElement, local);
      const volume = partConfig(config, cfg, first, local.triangles.length / 3, 'Rolling brim');
      const settings: Record<string, string> = { source_file: MARKER, perimeters: String(result.settings.perimeters), top_solid_layers: '0', bottom_solid_layers: '0', top_solid_min_thickness: '0', bottom_solid_min_thickness: '0', fill_density: '0%', gap_fill_enabled: '0', ensure_vertical_shell_thickness: 'disabled', only_one_perimeter_first_layer: '0', top_one_perimeter_type: 'none', ironing: '0' };
      Object.entries(settings).forEach(([key,value]) => addMeta(config, volume, 'volume', key, value));
    }
    if (original && !repeated) resources.replaceChild(out, original); else resources.appendChild(out);
    if (oldConfig && !repeated) config.documentElement.replaceChild(cfg, oldConfig); else config.documentElement.appendChild(cfg);
    let item = buildItems[object.buildIndex];
    if (!item) { item = doc.createElementNS(NS, 'item'); build.appendChild(item); }
    item.setAttribute('objectid', id);
  }
  files[modelPath] = serialize(doc); files[CONFIG] = serialize(config);
  files['Metadata/rolling_brim.json'] = strToU8(JSON.stringify({ version: 1, settings: result.settings, sampleZ: result.settings.height / 2, printOrder: 'Determined by PrusaSlicer; brim-first is not guaranteed.' }, null, 2));
  files['[Content_Types].xml'] ||= strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>');
  files['_rels/.rels'] ||= strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rel-1" Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>');
  const ct = xml(strFromU8(files['[Content_Types].xml']));
  for (const [extension, type] of [['config','application/octet-stream'], ['json','application/json']]) if (!children(ct.documentElement, 'Default').some(e => e.getAttribute('Extension') === extension)) {
    const e = ct.createElementNS(ct.documentElement.namespaceURI || '', 'Default'); e.setAttribute('Extension', extension); e.setAttribute('ContentType', type); ct.documentElement.appendChild(e);
  }
  files['[Content_Types].xml'] = serialize(ct);
  return zipSync(files, { level: 6 });
}
