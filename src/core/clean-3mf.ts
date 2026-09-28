import { strFromU8, strToU8 } from 'fflate';
import { NS, xml, serialize, safePath, type Doc, type El } from './three-mf-xml';
import { packageFiles } from './three-mf-package';
import type { Project } from './types';

type Data = Record<string, unknown>;
const pick = (value: unknown, keys: string[]): Data => {
  const data = value && typeof value === 'object' ? value as Data : {};
  return Object.fromEntries(keys.filter(key => Object.hasOwn(data,key)).map(key => [key,data[key]]));
};
const parse = (bytes: Uint8Array) => JSON.parse(strFromU8(bytes));
const encode = (value: unknown) => strToU8(JSON.stringify(value));
const elements = (node: El) => Array.from(node.childNodes).filter(n => n.nodeType === 1) as El[];

// This is an allowlist for a NEW archive, not a list of source features to fix.
// Copy mesh coordinates and ordered corners directly: preview meshes may have
// mirrored winding and compacted indices, which would detach partial-face paint.
const modelAttributes: Record<string,string[]> = {
  model:['unit','xml:lang'], resources:[], build:[],
  object:['id','name','type','pid','pindex'], components:[],
  component:['objectid','transform','p:path'], item:['objectid','transform','printable','p:path'],
  mesh:[], vertices:[], vertex:['x','y','z'], triangles:[],
  triangle:['v1','v2','v3','pid','p1','p2','p3','slic3rpe:mmu_segmentation','paint_color'],
  basematerials:['id'], base:['name','displaycolor'], colorgroup:['id'], color:['color'],
};
const versions = new Set(['Application','slic3rpe:Version3mf','slic3rpe:MmPaintingVersion','BambuStudio:3mfVersion','BambuStudio:MmPaintingVersion','OrcaSlicer:3mfVersion','OrcaSlicer:MmPaintingVersion']);
function copyModel(source: Doc, format: Project['format']): Doc {
  const doc = xml(`<model xmlns="${NS}"/>`);
  const copy = (input: El): El | undefined => {
    if (input.localName === 'metadata') {
      const name = input.getAttribute('name') || '';
      if (!versions.has(name)) return;
      const output = doc.createElementNS(NS,'metadata'); output.setAttribute('name',name);
      output.appendChild(doc.createTextNode(name === 'Application' && (format === 'bambu' || format === 'orca') ? 'RollingBrim-0.1.0' : input.textContent || ''));
      return output;
    }
    const allowed = modelAttributes[input.localName]; if (!allowed) return;
    const output = doc.createElementNS(input.namespaceURI || NS,input.nodeName);
    for (const a of Array.from(input.attributes)) {
      if (allowed.includes(a.name) || (a.localName === 'path' && ['component','item'].includes(input.localName))) output.setAttributeNS(a.namespaceURI,a.name,a.value);
      // Only namespace declarations used by geometry or color attributes.
      if (a.namespaceURI === 'http://www.w3.org/2000/xmlns/' && [NS,'http://schemas.slic3r.org/3mf/2017/06','http://schemas.microsoft.com/3dmanufacturing/production/2015/06','http://schemas.microsoft.com/3dmanufacturing/material/2015/02'].includes(a.value)) output.setAttributeNS(a.namespaceURI,a.name,a.value);
    }
    for (const element of elements(input)) { const c = copy(element); if (c) output.appendChild(c); }
    return output;
  };
  doc.replaceChild(copy(source.documentElement)!,doc.documentElement);
  if (format === 'bambu' || format === 'orca') {
    const hint = doc.createElementNS(NS,'metadata'); hint.setAttribute('name','RollingBrim:TargetSlicer'); hint.appendChild(doc.createTextNode(format)); doc.documentElement.appendChild(hint);
  }
  return doc;
}

function copyConfig(bytes: Uint8Array, native: boolean): Uint8Array {
  const input = xml(strFromU8(bytes)), doc = xml('<config/>');
  const allowed: Record<string,string[]> = native
    ? {config:[],object:['id'],part:['id','subtype'],plate:[],model_instance:[]}
    : {config:[],object:['id','instances_count'],volume:['firstid','lastid']};
  const metadata = native ? ['name','extruder','plater_id','plater_name','object_id','instance_id'] : ['name','extruder','volume_type','modifier'];
  const copy = (node: El): El | undefined => {
    if (node.localName === 'metadata') {
      if (!metadata.includes(node.getAttribute('key') || '')) return;
      const out = doc.createElement('metadata');
      for (const key of ['type','key','value']) if (node.hasAttribute(key)) out.setAttribute(key,node.getAttribute(key)!);
      return out;
    }
    const attrs = allowed[node.localName]; if (!attrs) return;
    const out = doc.createElement(node.localName);
    for (const key of attrs) if (node.hasAttribute(key)) out.setAttribute(key,node.getAttribute(key)!);
    for (const element of elements(node)) { const c = copy(element); if (c) out.appendChild(c); }
    return out;
  };
  doc.replaceChild(copy(input.documentElement)!,doc.documentElement); return serialize(doc);
}

function colorContainer(container: Data): Data {
  const config = container.configuration as Data;
  const preset = container.preset as Data | undefined, hardware = preset?.hw_config as Data | undefined;
  if (!hardware) throw new Error('Clean export needs the PrusaSlicer material-slot definitions to retain color painting. Save the project in PrusaSlicer first.');
  // Alpha12 requires hardware slot descriptors to load a color container. Keep
  // its routing identity; rebuild preset records and discard all profile values.
  const descriptor = {name:'Choose a profile',id:'rolling-brim',root_id:'rolling-brim',conditions:[]};
  const hw = pick(hardware,['config_id','printer_id','vendor_id','repo_id','repo_version','config_name','config_short_name','technology','model','base_model','tool_count']);
  hw.features = {}; hw.sheet = {id:'',name:'',type:'',features:{}};
  hw.tools = Object.fromEntries(Object.entries(hardware.tools as Data).map(([address,value]) => {
    const tool = value as Data, out = pick(tool,['id','name','type']);
    if (tool.type) out.features = pick(tool.features,['nozzle_diameter','nozzle_high_flow']);
    if (tool.feeder) out.feeder = {...pick(tool.feeder,['id','type','model','base_model','slot_count']),features:{}};
    if (tool.slicer_material) out.slicer_material = {...pick(tool.slicer_material,['id','type']),features:{}};
    return [address,out];
  }));
  return {
    beds:(container.beds as Data[] || []).map(b => pick(b,['position_x','position_y'])),
    preset:{hw_config:hw,printer:descriptor,print:descriptor,tools:(preset!.tools as unknown[]).map(() => descriptor),materials:(preset!.materials as unknown[]).map(() => descriptor)},
    configuration:{
      printer_settings:{printer_technology:'FFF',...pick(config.printer_settings,['bed_shape'])},
      print_settings:{spiral_vase:false},toolprint_settings:{perimeters:(preset!.tools as unknown[]).map(() => null)},
      filament_settings:pick(config.filament_settings,['filament_colour']),
      project_settings:pick(config.project_settings,['extruder_colour']),
    },
    ...pick(container,['virtual_extruders']),
  };
}

/** Reconstruct just geometry/roles/placement/color into a fresh export checkpoint.
 * Existing writers add the current brim and its overrides to this new package.
 * No unrelated source file, setting, relationship or annotation is copied.
 */
export function cleanProject(project: Project): Project {
  if (!project.source) return project;
  const source = project.source, files = packageFiles(source.modelPath);
  const visit = (path: string) => {
    if (files[path]) return;
    const doc = copyModel(xml(strFromU8(source.files[path])),project.format);
    files[path] = serialize(doc);
    for (const node of Array.from(doc.getElementsByTagName('*'))) for (const a of Array.from(node.attributes)) if (a.localName === 'path') visit(safePath(a.value));
  };
  visit(source.modelPath);
  if (project.format === 'prusa3') {
    const path = 'Metadata/PrusaSlicer3_project.json', input = parse(source.files[path]);
    const objects = input.objects.map((o: Data) => ({...pick(o,['id','instances']),object_settings:pick(o.object_settings,['extruder']),volumes:(o.volumes as Data[]).map(v => ({...pick(v,['id','type']),volume_settings:pick(v.volume_settings,['extruder'])}))}));
    files[path] = encode({project:{id:'00000000-0000-4000-8000-000000000001',version:0},objects,config_containers:input.config_containers.map(colorContainer)});
    const paintPath = 'Metadata/Slic3r_facets_annotation.json';
    if (source.files[paintPath]) files[paintPath] = encode(parse(source.files[paintPath]).filter((p: Data) => p.mmSegmentationFacets).map((p: Data) => pick(p,['id','mmSegmentationFacetsVersion','mmSegmentationFacets'])));
  } else if (project.format === 'bambu' || project.format === 'orca') {
    files['Metadata/model_settings.config'] = copyConfig(source.files['Metadata/model_settings.config'],true);
    const path = 'Metadata/project_settings.config';
    if (source.files[path]) {
      const palette = pick(parse(source.files[path]),['filament_colour','extruder_colour']);
      if (project.format === 'orca' && Array.isArray(palette.filament_colour)) {
        // Orca's loader dereferences absent purge options when loading a partial
        // palette. Supply a fresh default scaffold, never the source purge data.
        const count = palette.filament_colour.length;
        palette.flush_volumes_matrix = Array.from({length:count*count},(_,i) => String(Math.floor(i/count) === i%count ? 0 : 280));
        palette.flush_volumes_vector = Array(count*2).fill('140');
      }
      files[path] = encode(palette);
    }
  } else {
    const path = 'Metadata/Slic3r_PE_model.config';
    if (source.files[path]) files[path] = copyConfig(source.files[path],false);
    const profile = source.files['Metadata/Slic3r_PE.config'];
    if (profile) files['Metadata/Slic3r_PE.config'] = strToU8(strFromU8(profile).split(/\r?\n/).filter(line => /^;?\s*(?:filament_colour|extruder_colour)\s*=/.test(line)).join('\n')+'\n');
  }
  return {...project,source:{modelPath:source.modelPath,files}};
}
