/** The ELK layout worker as its own file next to the app. The export build swaps in `elkWorker.inline.ts`. */
export const createElkWorker = (): Worker => new Worker(new URL('./elk.worker.ts', import.meta.url), { type: 'module' });
