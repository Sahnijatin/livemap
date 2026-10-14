/**
 * The ELK layout worker. elkjs's worker script answers elk-api's layout messages on `self`; Vite
 * bundles it locally, so no script loads from another origin. (elk.bundled.js would do the same when
 * imported in a worker, since it detects the worker context and takes over `self.onmessage`, but it
 * also carries the main-thread API this worker does not need.)
 */
import 'elkjs/lib/elk-worker.min.js';
