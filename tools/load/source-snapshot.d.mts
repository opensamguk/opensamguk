export type GitCommand = (args: readonly string[]) => Promise<string>;
export type SourceEntry = {
  name: string;
  mode?: string | undefined;
  kind: string;
  bytes: Uint8Array;
  rootReal: string;
  fileReal: string;
  platform: string;
  linkBlob?: string;
  actualLinkText?: string | undefined;
  target?: { name: string; real: string; mode?: string | undefined; kind: string } | undefined;
};
export function parseGitTree(raw: string): Map<string, { mode: string; oid: string }>;
export function sourceEntryHash(input: SourceEntry): string;
export function snapshotSource(
  root: string,
  git: GitCommand,
  signal: AbortSignal,
): Promise<{ head: string; sha256: string; files: number }>;
