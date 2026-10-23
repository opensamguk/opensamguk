import { fire_attack } from './fire_attack';
import { sabotage } from './sabotage';
import { incite } from './incite';
import { plunder } from './plunder';

export const stratagemCommands = [fire_attack, sabotage, incite, plunder] as const;
