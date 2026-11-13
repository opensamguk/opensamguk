import { BALANCE } from '../balance';

export function canDefend(troops: number, training: number, morale: number) {
  return troops > 0 && training >= BALANCE.DEFEND_TRAIN && morale >= BALANCE.DEFEND_ATMOS;
}
