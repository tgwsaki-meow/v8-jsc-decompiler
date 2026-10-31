// Moved to src/load/index.mjs.
//
// This file was the ".jsc + profile -> FunctionUnits + ScopeInfo map" loader.
// It had to live under tools/ while src/heap was being built; now that src/cli
// and the W3 layers need it, it is in src/ (a `src/` module importing from
// `tools/` is the wrong direction -- ARCHITECTURE.md 11.0).
//
// Kept as a re-export so every existing tools/ and tests/ caller keeps working
// under the old names. New code should import src/load/index.mjs directly.

import {
  loadUnits, loadUnitsFromAnyProfile, environmentFor,
} from '../../src/load/index.mjs';

export const unitsFromCache = loadUnits;
export const unitsFromAnyProfile = loadUnitsFromAnyProfile;
export { environmentFor, loadUnits, loadUnitsFromAnyProfile };

export default { unitsFromCache, unitsFromAnyProfile, environmentFor };
