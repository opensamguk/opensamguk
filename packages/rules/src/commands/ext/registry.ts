import type { CommandDef } from '../types';
import { stratagemCommands } from './stratagem';

export const extensionCommands: readonly CommandDef[] = [...stratagemCommands];
