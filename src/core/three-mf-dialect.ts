import { children, type El } from './three-mf-xml';

// A slicer brand and its project dialect are separate concepts. PrusaSlicer 3
// has a new JSON project/painting format, not the 2.x XML volume-range format.
export type ThreeMfDialect = 'generic' | 'prusa2' | 'prusa3' | 'bambu-orca';

export function detectThreeMfDialect(files: Record<string, Uint8Array>, root: El): ThreeMfDialect {
  // Check archive contents before any legacy/native fallback, even when a file
  // carries old metadata as well. Do not parse unsupported JSON as a 2.x project.
  if (Object.keys(files).some(path => /^Metadata\/(?:PrusaSlicer3_project|Slic3r_facets_annotation)\.json$/i.test(path))) return 'prusa3';
  const applications = children(root, 'metadata').filter(m => m.getAttribute('name') === 'Application');
  if (applications.some(m => {
    const major = /^PrusaSlicer[-\s]+(\d+)(?:\.|$)/i.exec(m.textContent?.trim() || '')?.[1];
    return major !== undefined && Number(major) >= 3;
  })) return 'prusa3';
  if (files['Metadata/model_settings.config'] || files['Metadata/project_settings.config']) return 'bambu-orca';
  if (files['Metadata/Slic3r_PE_model.config'] || files['Metadata/Slic3r_PE.config']) return 'prusa2';
  return 'generic';
}
