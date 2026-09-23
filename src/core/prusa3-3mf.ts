import { strFromU8, strToU8, zipSync } from 'fflate';
import { transformMesh } from './mesh';
import { MIN_LAYER_HEIGHT, MAX_LAYER_HEIGHT } from './first-layer';
import { NS, xml, serialize, children, child, matrix, readMesh, checkIds, type Doc, type El } from './three-mf-xml';
import { configuration, record, list, keys, integer, fail, type JsonObject } from './prusa3-config';
import type { Project, ModelObject, ModelPart, BrimResult, Mesh } from './types';

export const PRUSA3_VERSION = 'PrusaSlicer-3.0.0-alpha12';
const PROJECT = 'Metadata/PrusaSlicer3_project.json', PAINT = 'Metadata/Slic3r_facets_annotation.json';
const ROLES = ['ModelPart','NegativeVolume','ParameterModifier','SupportEnforcer','SupportBlocker'];
const remove = (node: El) => node.parentNode?.removeChild(node);
function json(bytes: Uint8Array | undefined, label: string): unknown {
  if (!bytes) fail(`Missing ${label}.`);
  try { return JSON.parse(strFromU8(bytes!)); } catch { return fail(`Invalid ${label} JSON.`); }
}
function attrs(node: El, allowed: string[]) {
  for (const a of Array.from(node.attributes)) if (a.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && !allowed.includes(a.name)) fail(`Unrecognized ${node.localName} attribute: ${a.name}.`);
}
function tags(node: El, allowed: string[]) {
  for (const c of Array.from(node.childNodes).filter(n => n.nodeType === 1) as El[]) if (c.namespaceURI !== NS || !allowed.includes(c.localName)) fail(`Unrecognized ${node.localName} element: ${c.nodeName}.`);
}
interface Instance { index: number; item: El; cfg: JsonObject; parent: El; parts: ModelPart[]; printable: boolean }

function archive(files: Record<string, Uint8Array>, modelPath: string, modelDocument?: Doc) {
  const doc = modelDocument || xml(strFromU8(files[modelPath])), root = doc.documentElement;
  const application = children(root,'metadata').filter(m => m.getAttribute('name') === 'Application');
  if (application.length !== 1 || application[0].textContent !== PRUSA3_VERSION) fail('This PrusaSlicer version has not been validated.');
  if (root.namespaceURI !== NS || root.localName !== 'model' || root.getAttribute('unit') !== 'millimeter') fail('Expected a core 3MF model in millimetres.');
  if (root.getAttribute('requiredextensions')) fail('3MF extensions/external model resources are not supported yet.');
  attrs(root,['unit','xml:lang']); tags(root,['metadata','resources','build']);
  if (children(root,'resources').length !== 1 || children(root,'build').length !== 1) fail('Expected one resources section and one build.');
  for (const path of Object.keys(files)) {
    if ((/\.model$/i.test(path) && path !== modelPath) || (/\.rels$/i.test(path) && path !== '_rels/.rels')) fail(`External model resources/relationships are unsupported: ${path}.`);
    if (/^Metadata\/(?:Slic3r_PE_model|Slic3r_PE|model_settings|project_settings)\.config$/i.test(path)) fail('Mixed slicer metadata cannot be updated safely.');
  }
  const data = record(json(files[PROJECT], 'PrusaSlicer 3 project'), 'project file');
  keys(data,['objects','project','config_containers'],'project');
  const projectInfo = record(data.project,'project identity'); keys(projectInfo,['id','version'],'project identity');
  if (typeof projectInfo.id !== 'string') fail('Changed project identity schema.');
  integer(projectInfo.version,'project save revision');
  const resources = child(root,'resources'), build = child(root,'build'); tags(resources,['object']); tags(build,['item']);
  attrs(resources,[]); attrs(build,[]);
  const objects = children(resources,'object'); checkIds(objects,'resource');
  const resource = (id: string) => objects.find(o => o.getAttribute('id') === id) || fail(`Missing resource ${id}.`);
  const meshes = new Map<string,Mesh>();
  const declared = new Set<string>();
  for (const object of objects) {
    attrs(object,['id','name','type']);
    if (object.hasAttribute('type') && object.getAttribute('type') !== 'model') fail('Non-model resource types.');
    tags(object,['mesh','components']);
    if (children(object,'mesh').length + children(object,'components').length !== 1) fail('Changed mesh/component hierarchy.');
    if (children(object,'mesh').length) {
      const mesh = child(object,'mesh'); attrs(mesh,[]); tags(mesh,['vertices','triangles']);
      if (children(mesh,'vertices').length !== 1 || children(mesh,'triangles').length !== 1) fail('Changed mesh hierarchy.');
      const vertices = child(mesh,'vertices'), triangles = child(mesh,'triangles');
      attrs(vertices,[]); attrs(triangles,[]); tags(vertices,['vertex']); tags(triangles,['triangle']);
      for (const t of children(triangles,'triangle')) { attrs(t,['v1','v2','v3','slic3rpe:mmu_segmentation']); tags(t,[]); }
      for (const v of children(vertices,'vertex')) { attrs(v,['x','y','z']); tags(v,[]); }
      meshes.set(object.getAttribute('id')!,readMesh(mesh));
    } else {
      const components = child(object,'components'); attrs(components,[]); tags(components,['component']);
      for (const c of children(components,'component')) {
        attrs(c,['objectid','transform']); tags(c,[]); matrix(c.getAttribute('transform'));
        if (!declared.has(c.getAttribute('objectid')!)) fail('Components must reference an earlier resource; forward or cyclic references are unsupported.');
      }
    }
    declared.add(object.getAttribute('id')!);
  }
  const configurations = list(data.objects,'objects').map(v => record(v,'object'));
  const configIds = new Set<number>(), volumeIds = new Set<number>();
  for (const cfg of configurations) {
    keys(cfg,['id','volumes','instances','object_settings'],'object');
    const id = integer(cfg.id,'object id',1); if (configIds.has(id)) fail('Duplicate object metadata.'); configIds.add(id);
    record(cfg.object_settings ?? {},'object settings');
    const parent = resource(String(id)), refs = children(child(parent,'components'),'component');
    const volumes = list(cfg.volumes,'volumes').map(v => record(v,'volume'));
    if (volumes.length !== refs.length || !volumes.length) fail('Volume metadata does not match the components.');
    const localIds = new Set<number>();
    for (const [i,v] of volumes.entries()) {
      keys(v,['id','type','volume_settings','source'],'volume');
      const vid = integer(v.id,'volume id',1); volumeIds.add(vid);
      if (localIds.has(vid) || refs[i].getAttribute('objectid') !== String(vid)) fail('Ambiguous volume references.'); localIds.add(vid);
      if (!ROLES.includes(String(v.type))) fail(`Unknown volume type: ${v.type}.`);
      record(v.volume_settings ?? {},'volume settings');
      const volume = resource(String(vid)), geometry = children(child(volume,'components'),'component');
      if (geometry.length !== 1 || geometry[0].hasAttribute('transform') || !meshes.has(geometry[0].getAttribute('objectid')!)) fail('Unsupported nested volume geometry.');
    }
  }
  const painting = files[PAINT] ? list(json(files[PAINT],'painting'),'painting').map(v => record(v,'painting entry')) : [];
  const painted = new Set<number>();
  for (const p of painting) {
    const id = integer(p.id,'painted volume',1);
    if (!volumeIds.has(id) || painted.has(id)) fail('Painting refers to a missing or duplicate volume.'); painted.add(id);
    // Only the volume ID changes when an instance needs a new wrapper.
    // Painting payloads stay attached to unchanged source triangle corners.
  }
  const containers = list(data.config_containers,'configuration groups').map(c => record(c,'configuration group'));
  for (const container of containers) {
    const config = configuration(container.configuration), printer = record(config.printer_settings,'printer settings'), print = record(config.print_settings,'print settings');
    if (printer.printer_technology !== 'FFF' || print.spiral_vase !== false || integer(print.raft_layers ?? 0,'raft layers') !== 0) fail('SLA, vase and raft printing are not supported.');
  }
  const instances: Instance[] = [];
  const items = children(build,'item'), printability = new Map<number,boolean>();
  for (const cfg of configurations) for (const value of cfg.instances === undefined ? [] : list(cfg.instances,'instances')) {
    const instance = record(value,'instance'); keys(instance,['ord','printable'],'instance'); const ord = integer(instance.ord,'instance order');
    if (ord >= items.length || printability.has(ord) || items[ord].getAttribute('objectid') !== String(cfg.id) || typeof instance.printable !== 'boolean') fail('Invalid instance metadata.');
    printability.set(ord,instance.printable as boolean);
  }
  let triangles = 0;
  for (const [index,item] of items.entries()) {
    attrs(item,['objectid','transform']); tags(item,[]);
    const cfg = configurations.find(c => String(c.id) === item.getAttribute('objectid')) || fail('Missing object settings.');
    const parent = resource(String(cfg.id)), transform = matrix(item.getAttribute('transform'));
    const volumes = cfg.volumes as JsonObject[];
    const parts = children(child(parent,'components'),'component').map((ref,i): ModelPart => {
      const volume = resource(ref.getAttribute('objectid')!), geometry = child(child(volume,'components'),'component');
      const mesh = meshes.get(geometry.getAttribute('objectid')!)!; triangles += mesh.triangles.length/3;
      if (triangles > 2_000_000) fail('The scene exceeds the two-million-triangle browser limit.');
      return {name:volume.getAttribute('name') || `Part ${volumes[i].id}`,kind:String(volumes[i].type),mesh:transformMesh(mesh,transform.clone().multiply(matrix(ref.getAttribute('transform'))))};
    });
    const positive = parts.filter(p => p.kind === 'ModelPart'); if (!positive.length) fail('An object has no positive model parts.');
    const objectSettings = record(cfg.object_settings ?? {},'object settings');
    if (integer(objectSettings.raft_layers ?? 0,'object raft layers') !== 0) fail('Object rafts are not supported.');
    instances.push({index,item,cfg,parent,parts,printable:printability.get(index) !== false});
  }
  return {doc,root,resources,build,data,painting,containers,instances};
}

export function importPrusa3Project(name: string, files: Record<string,Uint8Array>, modelPath: string, modelDocument?: Doc): Project {
  const a = archive(files,modelPath,modelDocument);
  const objects: ModelObject[] = a.instances.filter(i => i.printable).map(i => ({
    id:`object-${i.index}`,name:i.parent.getAttribute('name') || `Object ${i.index+1}`,resourceId:String(i.cfg.id),buildIndex:i.index,
    transform:matrix(i.item.getAttribute('transform')).toArray(),parts:i.parts,
  }));
  const warnings = ['Experimental PrusaSlicer 3.0.0-alpha12 support.'];
  if (!objects.length) warnings.push('No printable model objects were found.');
  const effective = (key: string): unknown[] => a.containers.flatMap(container => {
    const config = configuration(container.configuration), print = record(config.print_settings,'print settings'), tool = record(config.toolprint_settings,'tool settings');
    return Array.isArray(tool[key]) && tool[key].length ? tool[key].map(value => value ?? print[key]) : [print[key]];
  });
  const heights = effective('first_layer_height').map(value => {
    const h = record(value,'first-layer height');
    return h.is_percent === false && typeof h.value === 'number' && h.value >= MIN_LAYER_HEIGHT && h.value <= MAX_LAYER_HEIGHT ? h.value : undefined;
  });
  const suggestedHeight = heights.every(h => h === heights[0]) ? heights[0] : undefined;
  if (suggestedHeight === undefined) warnings.push('Choose the first-layer height manually and match it in the slicer: beds or tools have differing, relative or unsupported first-layer heights.');
  const instances = a.instances;
  if (effective('brim_width').some(v => Number(v) > 0) || instances.some(i => Number(record(i.cfg.object_settings ?? {},'object settings').brim_width) > 0)) warnings.push('Native slicer brim is enabled. Disable it in the slicer if unwanted.');
  if (effective('xy_size_compensation').some(v => Number(v)) || instances.some(i => Number(record(i.cfg.object_settings ?? {},'object settings').xy_size_compensation))) warnings.push('The project applies XY compensation. Check the separation gap after slicing.');
  if (a.containers.some(c => { const materials = record(c.preset,'preset').materials; return Array.isArray(materials) && materials.length > 1; })) warnings.push('Material slots and virtual extruders are preserved. New brim parts inherit their parent object’s material settings, not its painted colors.');
  if (objects.some(o => o.parts.some(p => p.kind === 'NegativeVolume'))) warnings.push('Negative volumes are applied in the footprint view. The 3D view shows the original positive meshes.');
  return {name,objects,warnings,suggestedHeight,format:'prusa3',source:{files,modelPath}};
}

function meshResource(doc: Doc, id: string, mesh: Mesh): El {
  const object = doc.createElementNS(NS,'object'); object.setAttribute('id',id);
  const body = doc.createElementNS(NS,'mesh'), vertices = doc.createElementNS(NS,'vertices'), triangles = doc.createElementNS(NS,'triangles'); object.appendChild(body); body.appendChild(vertices); body.appendChild(triangles);
  for (let i=0;i<mesh.vertices.length;i+=3) { const v = doc.createElementNS(NS,'vertex'); ['x','y','z'].forEach((k,j) => v.setAttribute(k,String(mesh.vertices[i+j]))); vertices.appendChild(v); }
  for (let i=0;i<mesh.triangles.length;i+=3) { const t = doc.createElementNS(NS,'triangle'); ['v1','v2','v3'].forEach((k,j) => t.setAttribute(k,String(mesh.triangles[i+j]))); triangles.appendChild(t); }
  return object;
}
export function exportPrusa3Project(project: Project, result: BrimResult, modelDocument?: Doc): Uint8Array {
  if (!project.source || project.format !== 'prusa3') fail('Native PrusaSlicer 3 input is required.');
  if (!result.objects.some(o => o.mesh.triangles.length)) throw new Error('Generate at least one brim before exporting.');
  const source = project.source!, files = {...source.files}, a = archive(files,source.modelPath,modelDocument);
  const instances = a.instances;
  let id = children(a.resources,'object').reduce((max,o) => Math.max(max,Number(o.getAttribute('id'))),0)+1;
  const output: JsonObject[] = [], outputPainting: JsonObject[] = [...a.painting];
  const reused = new Set<number>();
  children(a.build,'item').forEach(remove);
  for (const [ordinal,i] of instances.entries()) {
    // Keep original IDs for the first instance. Only repeated instances need
    // separate wrappers so their generated brim/settings can differ.
    const reuse = !reused.has(Number(i.cfg.id)); reused.add(Number(i.cfg.id));
    const parent = i.parent.cloneNode(true) as El, parentId = reuse ? Number(i.cfg.id) : id++; parent.setAttribute('id',String(parentId));
    const cfg = structuredClone(i.cfg), volumes = cfg.volumes as JsonObject[]; cfg.id = parentId;
    if (!reuse) for (const [index,v] of volumes.entries()) {
      const oldId = Number(v.id), volumeId = id++;
      const original = children(a.resources,'object').find(o => o.getAttribute('id') === String(oldId))!;
      const volume = original.cloneNode(true) as El; volume.setAttribute('id',String(volumeId)); a.resources.appendChild(volume);
      children(child(parent,'components'),'component')[index].setAttribute('objectid',String(volumeId)); v.id = volumeId;
      const paint = a.painting.find(p => p.id === oldId); if (paint) outputPainting.push({...paint,id:volumeId});
    }
    delete cfg.instances; if (!i.printable) cfg.instances = [{ord:ordinal,printable:false}];
    if (i.printable) {
      cfg.object_settings = {...record(cfg.object_settings ?? {},'object settings'),elefant_foot_compensation:0};
      // Alpha12 permits volume-level compensation, which overrides the parent.
      for (const v of volumes) if (v.type === 'ModelPart') v.volume_settings = {...record(v.volume_settings ?? {},'volume settings'),elefant_foot_compensation:0};
    }
    const transform = matrix(i.item.getAttribute('transform'));
    const brim = i.printable && result.objects.find(o => o.id === `object-${i.index}`);
    if (brim && brim.mesh.triangles.length) {
      const meshId = id++, volumeId = id++;
      a.resources.appendChild(meshResource(a.doc,String(meshId),transformMesh(brim.mesh,transform.clone().invert())));
      const volume = a.doc.createElementNS(NS,'object'); volume.setAttribute('id',String(volumeId)); volume.setAttribute('name','Rolling brim');
      const components = a.doc.createElementNS(NS,'components'), geometry = a.doc.createElementNS(NS,'component'); geometry.setAttribute('objectid',String(meshId)); components.appendChild(geometry); volume.appendChild(components); a.resources.appendChild(volume);
      const component = a.doc.createElementNS(NS,'component'); component.setAttribute('objectid',String(volumeId)); child(parent,'components').appendChild(component);
      volumes.push({id:volumeId,type:'ModelPart',volume_settings:{perimeters:result.settings.perimeters,fill_density:{value:0,is_percent:true},top_solid_layers:0,bottom_solid_layers:0,top_solid_min_thickness:0,bottom_solid_min_thickness:0,gap_fill_enabled:false,ensure_vertical_shell_thickness:'disabled',only_one_perimeter_first_layer:false,top_one_perimeter_type:'none',ironing:false,elefant_foot_compensation:0,wipe_into_infill:false}});
    }
    output.push(cfg); if (reuse) remove(i.parent); a.resources.appendChild(parent);
    const item = i.item.cloneNode(true) as El; item.setAttribute('objectid',String(parentId)); a.build.appendChild(item);
  }
  a.data.objects = [...output,...(a.data.objects as JsonObject[]).filter(c => !reused.has(Number(c.id)))];
  files[PROJECT] = strToU8(JSON.stringify(a.data,null,2));
  if (files[PAINT] && outputPainting.length !== a.painting.length) files[PAINT] = strToU8(JSON.stringify(outputPainting,null,2));
  delete files['Metadata/thumbnail.png'];
  const rels = xml(strFromU8(files['_rels/.rels']));
  children(rels.documentElement,'Relationship').filter(r => /\/thumbnail$/.test(r.getAttribute('Type') || '')).forEach(remove); files['_rels/.rels'] = serialize(rels);
  const ct = xml(strFromU8(files['[Content_Types].xml']));
  children(ct.documentElement,'Override').filter(n => n.getAttribute('PartName') === '/Metadata/thumbnail.png').forEach(remove); files['[Content_Types].xml'] = serialize(ct);
  children(a.root,'metadata').filter(m => /^Thumbnail/i.test(m.getAttribute('name') || '')).forEach(remove);
  files[source.modelPath] = serialize(a.doc);
  files['Metadata/rolling_brim.json'] = strToU8(JSON.stringify({version:1,settings:result.settings,sampleZ:result.settings.height/2,printOrder:'Determined by PrusaSlicer; brim-first is not guaranteed.'}));
  return zipSync(files,{level:6});
}
