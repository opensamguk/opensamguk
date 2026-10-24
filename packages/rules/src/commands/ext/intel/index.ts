import { intelSlice, spyBinding } from './record';
import { spy } from './spy';

export const intelCommands = [spy] as const;
export const intelSlices = [intelSlice] as const;
export const intelBindings = [spyBinding] as const;
