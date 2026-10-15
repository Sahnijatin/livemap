import source from 'elkjs/lib/elk-worker.min.js?raw';

let url: string | undefined;

/**
 * The ELK layout worker inlined into the page, for the single-file export (no worker file to load):
 * elkjs's worker script as plain text, run from a Blob URL (smaller than a base64 data URL).
 */
export const createElkWorker = (): Worker => {
  url ??= URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  return new Worker(url);
};
