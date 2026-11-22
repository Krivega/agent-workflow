import type { H01TemporalServices } from './comparisonH01Temporal.js';
import { createH04NativeAdapter } from './comparisonH04NativeOperation.js';

export function createH04NativeTemporalAdapter(services: H01TemporalServices) {
  return createH04NativeAdapter('temporal', services);
}
