import { strFromU8, unzipSync } from 'fflate';
import { Matrix4 } from 'three';
import { loadStl } from './mesh';
import { importObj } from './obj';
import { importPrusaProject, exportPrusaProject } from './prusa-3mf';
import { importNativeProject, exportNativeProject } from './bambu-3mf';
import { detectThreeMfDialect, type ThreeMfDialect } from './three-mf-dialect';
import { importPrusa3Project, exportPrusa3Project } from './prusa3-3mf';
import { xml, children, safePath, type Doc } from './three-mf-xml';
import type { BrimResult, Project, SlicerFormat } from './types';

type Archive = NonNullable<Project['source']> & { document: Doc };
interface ThreeMfAdapter {
  read(name: string, archive: Archive): Project;
  write(project: Project, result: BrimResult, format: SlicerFormat, document?: Doc): Uint8Array;
}
const legacyAdapter: ThreeMfAdapter = {
  read(name, archive) {
    return importPrusaProject(name, archive.files, archive.modelPath, archive.document);
  },
  write(project, result, format, document) {
    if (format === 'prusa3') throw new Error('PrusaSlicer 3 output requires a supported native alpha12 project.');
    return format === 'prusa' ? exportPrusaProject(project, result, document) : exportNativeProject(project, result, format);
  },
};
// Dialect-specific metadata stays behind this boundary so the worker and brim
// engine use the same whole-project contract for every slicer.
const adapters: Record<ThreeMfDialect, ThreeMfAdapter> = {
  generic: legacyAdapter,
  prusa2: legacyAdapter,
  prusa3: {
    read: (name, archive) => importPrusa3Project(name,archive.files,archive.modelPath,archive.document),
    write: (project,result,_format,document) => exportPrusa3Project(project,result,document),
  },
  'bambu-orca': {
    read: (name, archive) => importNativeProject(name, archive.files, archive.modelPath, archive.document),
    write: exportNativeProject,
  },
};
function readArchive(source: NonNullable<Project['source']>) {
  if (!source.files[source.modelPath]) throw new Error('The 3MF model resource is missing.');
  const document = xml(strFromU8(source.files[source.modelPath]));
  const dialect = detectThreeMfDialect(source.files, document.documentElement);
  return { archive: { ...source, document }, adapter: adapters[dialect] };
}
export function importProject(name: string, bytes: ArrayBuffer): Project {
  if (bytes.byteLength > 200_000_000) throw new Error('Choose a file smaller than 200 MB.');
  if (/\.obj$/i.test(name)) return importObj(name, bytes);
  if (/\.stl$/i.test(name)) {
    const mesh = loadStl(bytes);
    return { name, objects: [{ id: 'object-0', name: name.replace(/\.stl$/i, ''), resourceId: '1', buildIndex: 0, transform: new Matrix4().toArray(), parts: [{ name, kind: 'ModelPart', mesh }] }], warnings: ['STL units are assumed to be millimetres. The model was placed on Z=0; disconnected shells remain one object.'] };
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
  const { archive, adapter } = readArchive({ files, modelPath });
  return adapter.read(name, archive);
}
export function exportProject(project: Project, result: BrimResult, format: SlicerFormat = project.format && project.format !== 'generic' ? project.format : 'prusa'): Uint8Array {
  const input = project.source ? readArchive(project.source) : undefined;
  const adapter = input?.adapter || legacyAdapter;
  if (project.format && project.format !== 'generic' && project.format !== format) throw new Error('Native projects must be exported to their original slicer.');
  return adapter.write(project, result, format, input?.archive.document);
}
