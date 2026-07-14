import { InitialSchema1000000000000 } from './1000000000000-InitialSchema';

// Explicit array, not a dist glob: nest build webpack-bundles to one file,
// so a `dist/migrations/*.js` glob resolves to nothing at runtime.
// Add new migrations below, in timestamp order.
export const migrations = [InitialSchema1000000000000];
