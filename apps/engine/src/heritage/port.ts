import type {
  HeritageActivityInput,
  HeritageCreationSpend,
  HeritageCreationRecord,
  SeasonHeritageInput,
} from '@opensamguk/rules';

export interface HeritageEntryWrite {
  userId: string;
  worldId: string | null;
  key: string;
  kind: 'SEASON_CREDIT' | 'CREATION_SPEND' | 'CREATION_REFUND' | 'FORFEIT';
  delta: number;
  detail: Record<string, unknown>;
}

export interface HeritageRepository {
  lockUser(userId: string): Promise<'OPEN' | 'WITHDRAWN' | null>;
  activity(worldId: string, endedSequence: number): Promise<HeritageActivityInput[]>;
  append(entry: HeritageEntryWrite): Promise<boolean>;
  spend(input: {
    worldId: string;
    userId: string;
    sequence: number;
    allocation: HeritageCreationRecord;
  }): Promise<boolean>;
  creationSpends(worldId: string): Promise<HeritageCreationSpend[]>;
  refundKeys(worldId: string): Promise<ReadonlySet<string>>;
}

export interface HeritageSeason extends Omit<SeasonHeritageInput, 'activity'> {
  worldId: string;
  finalStateHash: string;
}
