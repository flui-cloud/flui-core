import { InitialSchema1000000000000 } from './1000000000000-InitialSchema';
import { AlertEvents1784400000000 } from './1784400000000-AlertEvents';
import { AppDeployOnPush1784500000000 } from './1784500000000-AppDeployOnPush';

// Explicit array, not a dist glob: nest build webpack-bundles to one file,
// so a `dist/migrations/*.js` glob resolves to nothing at runtime.
// Add new migrations below, in timestamp order.
export const migrations = [
  InitialSchema1000000000000,
  AlertEvents1784400000000,
  AppDeployOnPush1784500000000,
];
