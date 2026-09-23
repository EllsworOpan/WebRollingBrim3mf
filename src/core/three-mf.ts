import { NS, xml, serialize, children, child, meta, num, matrix, readMesh, safePath, checkIds, type Doc, type El } from './three-mf-xml';
import { importNativeProject, exportNativeProject, selectPlate } from './bambu-3mf';
export { selectPlate };
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { Matrix4 } from 'three';
import { compactMesh, loadStl, transformMesh } from './mesh';
import { importObj } from './obj';
import { signedArea } from './geometry';
import { MIN_LAYER_HEIGHT, MAX_LAYER_HEIGHT } from './first-layer';
import type { BrimResult, Mesh, ModelObject, ModelPart, Project, SlicerFormat } from './types';

const CONFIG = 'Metadata/Slic3r_PE_model.config';
const BRIM_SOURCE_FILE = 'rolling-brim.generated.stl';
function checkVolumes(volumes: El[], triangleCount: number) {
  const ranges = volumes.map(v => ({ first: num(v.getAttribute('firstid')), last: num(v.getAttribute('lastid')) })).sort((a,b) => a.first - b.first);
  let next = 0;
  for (const {first, last} of ranges) {
    if (!Number.isInteger(first) || !Number.isInteger(last) || first !== next || last < first || last >= triangleCount) throw new Error('The 3MF part triangle ranges overlap, have gaps, or are out of bounds. Save a repaired project in PrusaSlicer.');
    next = last + 1;
  }
  if (next !== triangleCount) throw new Error('The 3MF part triangle ranges do not cover the model. Save a repaired project in PrusaSlicer.');
}
function meshResourceId(id: string, resources: El[], configs: El[]): string {
  // PrusaSlicer represents extra instances as an identity component pointing
  // to the configured mesh. Resolve only this alias; never flatten its paint.
  const resource = resources.find(r => r.getAttribute('id') === id);
  const components = resource && children(resource, 'components')[0];
  const refs = components ? children(components, 'component') : [];
  if (resource && children(resource,'mesh').length || refs.length !== 1 || refs[0].attributes.length !== 1 || !refs[0].hasAttribute('objectid') || configs.some(c => c.getAttribute('id') === id)) return id;
  const target = refs[0].getAttribute('objectid')!;
  const cfg = configs.find(c => c.getAttribute('id') === target);
  const mesh = resources.find(r => r.getAttribute('id') === target);
  return cfg && Number(cfg.getAttribute('instances_count')) > 1 && mesh && children(mesh,'mesh').length ? target : id;
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
  const rels = files['_rels/.rels'] && xml(strFromU8(files['_rels/.rels']));
  const relation = rels && children(rels.documentElement, 'Relationship').find(r => /\/3dmodel$/.test(r.getAttribute('Type') || ''));
  if (!relation || relation.getAttribute('TargetMode') === 'External') throw new Error('The 3MF has no internal model relationship.');
  const modelPath = safePath(relation.getAttribute('Target') || '');
  if (!files[modelPath]) throw new Error('The 3MF model resource is missing.');
  if (files['Metadata/model_settings.config'] || files['Metadata/project_settings.config']) return importNativeProject(name, files, modelPath);
  const doc = xml(strFromU8(files[modelPath])), root = doc.documentElement;
  if (root.localName !== 'model' || root.namespaceURI !== NS) throw new Error('The 3MF resource is not a supported core model.');
  if ((root.getAttribute('requiredextensions') || '').trim()) throw new Error('This 3MF requires extensions not supported by this workbench. Save a standard PrusaSlicer 3MF first.');
  const units: Record<string, number> = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };
  const unit = root.getAttribute('unit') || 'millimeter';
  const scale = Object.hasOwn(units, unit) ? units[unit] : undefined;
  if (!scale) throw new Error('Unsupported 3MF measurement unit.');
  const resources = children(child(root, 'resources'), 'object');
  const configs = files[CONFIG] ? children(xml(strFromU8(files[CONFIG])).documentElement, 'object') : [];
  checkIds(Array.from(child(root, 'resources').childNodes).filter(n => n.nodeType === 1) as El[], 'resource');
  checkIds(configs, 'object configuration');
  const warnings: string[] = [];
  let meshCount = 0;
  const partsFor = (id: string, transform: Matrix4, seen = new Set<string>(), assembly = false): ModelPart[] => {
    if (seen.has(id) || seen.size > 64) throw new Error('The 3MF has circular or excessive component nesting.');
    seen = new Set(seen).add(id);
    const resource = resources.find(r => r.getAttribute('id') === id);
    if (!resource) throw new Error('A 3MF component references a missing object.');
    const meshElement = children(resource, 'mesh')[0];
    const config = configs.find(c => c.getAttribute('id') === id);
    if (config && (assembly || !meshElement)) throw new Error('Component assemblies with slicer-specific settings are not supported. Save this as a standard PrusaSlicer 3MF first.');
    if (!meshElement) return children(child(resource, 'components'), 'component').flatMap(c => {
      if (Array.from(c.attributes).some(a => a.localName === 'path')) throw new Error('External model components are not supported. Save this as a PrusaSlicer 3MF project first.');
      return partsFor(c.getAttribute('objectid') || '', transform.clone().multiply(matrix(c.getAttribute('transform'))), seen, true);
    });
    if (assembly && children(child(meshElement, 'triangles'), 'triangle').some(t => Array.from(t.attributes).some(a => !['v1','v2','v3'].includes(a.name)))) {
      throw new Error('Component assemblies with painted or annotated triangles are not supported. Save this as a standard PrusaSlicer 3MF first.');
    }
    const mesh = readMesh(meshElement);
    meshCount += mesh.triangles.length / 3;
    if (meshCount > 2_000_000) throw new Error('This scene exceeds the two-million-triangle browser limit.');
    const volumes = config ? children(config, 'volume') : [];
    if (!volumes.length) return [{ name: meta(config, 'name') || resource.getAttribute('name') || `Model ${id}`, kind: 'ModelPart', mesh: transformMesh(mesh, transform) }];
    checkVolumes(volumes, mesh.triangles.length / 3);
    return volumes.map(volume => {
      const first = num(volume.getAttribute('firstid')), last = num(volume.getAttribute('lastid'));
      if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || last < first || last >= mesh.triangles.length / 3) throw new Error('A 3MF part has invalid triangle ranges.');
      const kind = meta(volume, 'volume_type') || (meta(volume, 'modifier') === '1' ? 'ParameterModifier' : 'ModelPart');
      if (!['ModelPart','NegativeVolume','ParameterModifier','SupportEnforcer','SupportBlocker'].includes(kind)) throw new Error(`Unsupported part type: ${kind}`);
      return { name: meta(volume, 'name') || `Part ${first}`, kind, mesh: transformMesh(compactMesh({ vertices: mesh.vertices, triangles: mesh.triangles.slice(first * 3, (last + 1) * 3) }), transform) };
    });
  };
  const objects: ModelObject[] = [];
  children(child(root, 'build'), 'item').forEach((item, index) => {
    if (['0','false'].includes(item.getAttribute('printable') || '')) return;
    const id = meshResourceId(item.getAttribute('objectid') || '',resources,configs), config = configs.find(c => c.getAttribute('id') === id);
    const transform = matrix(item.getAttribute('transform'), scale), parts = partsFor(id, transform);
    if (parts.some(p => p.kind === 'ModelPart')) objects.push({ id: `object-${index}`, name: meta(config, 'name') || resources.find(r => r.getAttribute('id') === id)?.getAttribute('name') || parts[0]?.name || `Object ${index + 1}`, resourceId: id, buildIndex: index, transform: transform.toArray(), parts });
  });
  if (!objects.length) throw new Error('This 3MF contains no printable model objects.');
  if (objects.some(o => o.parts.some(p => p.kind === 'NegativeVolume'))) warnings.push('Negative volumes are applied in the footprint view. The 3D view shows the original positive meshes.');
  if (resources.some(r => children(r, 'components').length) && Array.from(root.getElementsByTagName('*')).some(e => e.hasAttribute('pid'))) throw new Error('Component assemblies with material/color assignments are not supported. Save a standard PrusaSlicer 3MF first.');
  const ini = files['Metadata/Slic3r_PE.config'] ? strFromU8(files['Metadata/Slic3r_PE.config']) : '';
  const setting = (key: string) => ini.match(new RegExp(`^;?\\s*${key}\\s*=\\s*(.+)$`, 'm'))?.[1].trim();
  const height = setting('first_layer_height');
  const bed = (setting('bed_shape') || '').split(',').filter(Boolean).map(p => {
    const coords = p.trim().split('x');
    if (coords.length !== 2 || coords.some(c => !c.trim())) throw new Error('The project has an invalid bed shape.');
    const [x,y] = coords.map(Number); return { x,y };
  });
  if (bed.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y) || Math.abs(p.x) > 1e6 || Math.abs(p.y) > 1e6) || (bed.length && (bed.length < 3 || Math.abs(signedArea(bed)) < 1e-6))) throw new Error('The project has an invalid bed shape.');
  if (!bed.length) warnings.push('No print bed is stored in this file; brim edges are not clipped to a bed.');
  if (Number(setting('xy_size_compensation')) !== 0 && setting('xy_size_compensation')) warnings.push('The project applies XY size compensation. The preview shows uncompensated mesh sections; check the final gap after slicing.');
  if (Number(setting('raft_layers')) > 0) throw new Error('Raft projects are not supported. Disable the raft and place the model on the bed first.');
  if (Number(setting('brim_width')) > 0) warnings.push('Native slicer brim is enabled in this project and may add another brim. Turn it off in PrusaSlicer if unwanted.');
  const suggestedHeight = height && Number.isFinite(Number(height)) && Number(height) >= MIN_LAYER_HEIGHT && Number(height) <= MAX_LAYER_HEIGHT ? Number(height) : undefined;
  if (height && !height.endsWith('%') && suggestedHeight === undefined) warnings.push(`The stored first-layer height is outside the supported ${MIN_LAYER_HEIGHT}–${MAX_LAYER_HEIGHT} mm range. Choose the height manually.`);
  return { name, objects, bed, warnings, source: { files, modelPath }, format: files[CONFIG] ? 'prusa' : 'generic', suggestedHeight };
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
export function exportProject(project: Project, result: BrimResult, format: SlicerFormat = project.format === 'bambu' || project.format === 'orca' ? project.format : 'prusa'): Uint8Array {
  if (project.format && project.format !== 'generic' && project.format !== format) throw new Error('Native projects must be exported to their original slicer.');
  if (format !== 'prusa') return exportNativeProject(project, result, format);
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
  const referenceCounts = new Map<string, number>();
  for (const item of buildItems) {
    const id = meshResourceId(item.getAttribute('objectid') || '',originalResources,originalConfigs);
    referenceCounts.set(id,(referenceCounts.get(id) || 0)+1);
  }
  for (const object of project.objects) {
    const brim = result.objects.find(o => o.id === object.id)!;
    const original = originalResources.find(r => r.getAttribute('id') === object.resourceId);
    const oldConfig = originalConfigs.find(c => c.getAttribute('id') === object.resourceId);
    const direct = original && children(original, 'mesh').length > 0;
    const repeated = (referenceCounts.get(object.resourceId) || 0) > 1;
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
      // Append to the original mesh without rebuilding faces or their corner
      // order: PrusaSlicer stores partial-face painting on these triangles.
      const triangles = child(meshElement, 'triangles');
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
      const settings: Record<string, string> = { source_file: BRIM_SOURCE_FILE, perimeters: String(result.settings.perimeters), top_solid_layers: '0', bottom_solid_layers: '0', top_solid_min_thickness: '0', bottom_solid_min_thickness: '0', fill_density: '0%', gap_fill_enabled: '0', ensure_vertical_shell_thickness: 'disabled', only_one_perimeter_first_layer: '0', top_one_perimeter_type: 'none', ironing: '0' };
      Object.entries(settings).forEach(([key,value]) => addMeta(config, volume, 'volume', key, value));
    }
    if (original && !repeated) resources.replaceChild(out, original); else resources.appendChild(out);
    if (oldConfig && !repeated) config.documentElement.replaceChild(cfg, oldConfig); else config.documentElement.appendChild(cfg);
    let item = buildItems[object.buildIndex];
    if (!item) { item = doc.createElementNS(NS, 'item'); build.appendChild(item); }
    item.setAttribute('objectid', id);
    // Keep the original resource for the last remaining reference. PrusaSlicer
    // rejects orphan mesh resources, even if all copied build items are valid.
    if (repeated) referenceCounts.set(object.resourceId,referenceCounts.get(object.resourceId)!-1);
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
