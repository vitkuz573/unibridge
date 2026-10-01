import * as opencode from './opencode.ts';
import * as kilocode from './kilocode.ts';
import * as mimocode from './mimocode.ts';
import * as openai from './openai.ts';
import type { BackendModule } from './registry.ts';

/**
 * Every backend module, in the order they are registered.
 *
 * The element type is named rather than inferred: `import * as` gives each
 * namespace a distinct structural type, and spelling the union out is what lets
 * a caller see which optional methods a given backend actually implements.
 */
export const allBackends: readonly BackendModule[] = [opencode, kilocode, mimocode, openai];
export type { opencode, kilocode, mimocode, openai };