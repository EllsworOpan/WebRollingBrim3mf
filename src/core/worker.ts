import { importProject, exportProject, selectPlate } from './three-mf';
import { generateBrims } from './brim';
import { maximizeDiameter } from './maximize-diameter';
import type { Project, WorkerRequest, WorkerResponse } from './types';
// This imported checkpoint stays unchanged. Each settings update and export
// generates a fresh brim; exported geometry never becomes the next input.
let project: Project | undefined;
let operation = 0;
self.onmessage = ({ data }: MessageEvent<WorkerRequest>) => {
  const current = ++operation;
  const send = (message: WorkerResponse) => self.postMessage(message);
  try {
    if (data.type === 'cancel') {
      send({ type: 'cancelled', id: data.id });
    } else if (data.type === 'load') {
      project = undefined;
      project = importProject(data.name, data.bytes);
      const { source: _source, ...publicProject } = project;
      send({ type: 'loaded', id: data.id, project: publicProject });
    } else if (data.type === 'plate') {
      if (!project) throw new Error('Load a model first.');
      project = selectPlate(project, data.plateId);
      const { source: _source, ...publicProject } = project;
      send({ type: 'loaded', id: data.id, project: publicProject });
    } else {
      if (!project) throw new Error('Load a model first.');
      if (data.type === 'maximize') {
        const search = maximizeDiameter(project, data.settings, data.enabled);
        void (async () => {
          try {
            while (current === operation) {
              const step = search.next();
              if (step.done) { send({ type: 'maximized', id: data.id, outcome: step.value }); return; }
              send({ type: 'maximizing', id: data.id, progress: step.value });
              // Let new settings, a replacement model or Cancel supersede this search.
              await new Promise(resolve => setTimeout(resolve, 0));
            }
          } catch (error) {
            if (current === operation) send({ type: 'error', id: data.id, message: error instanceof Error ? error.message : String(error) });
          } finally { search.return({ status: 'no-footprints' }); }
        })();
        return;
      }
      const result = generateBrims(project, data.settings, data.enabled);
      if (data.type === 'generate') send({ type: 'generated', id: data.id, result });
      else {
        const slicer = data.format || (project.format && project.format !== 'generic' ? project.format : 'prusa');
        const plateId = project.activePlateId, plate = project.plates?.find(p => p.id === plateId);
        const suffix = plate ? `-${plate.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').trim() || `plate-${plate.id}`}` : '';
        send({ type: 'exported', id: data.id, bytes: exportProject(project, result, slicer), slicer, filename: `${project.name.replace(/\.(stl|obj|3mf)$/i, '')}${suffix}-rolling-brim.3mf` });
      }
    }
  } catch (error) { send({ type: 'error', id: data.id, message: error instanceof Error ? error.message : String(error) }); }
};
