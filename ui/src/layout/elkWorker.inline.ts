import ElkWorker from './elk.worker.ts?worker&inline';

/** The ELK layout worker inlined into the page, for the single-file export (no worker file to load). */
export const createElkWorker = (): Worker => new ElkWorker();
