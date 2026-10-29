import type { AdmissionSample, AdmissionReason, LoadBudget } from './admission';
import type { DockerBinding } from './docker';
export function bootstrapSnapshot(
  root: string,
  native: (
    command: string,
    args: readonly string[],
    label: string,
    signal: AbortSignal,
    timeoutMs: number,
  ) => Promise<string>,
  signal: AbortSignal,
): Promise<{ head: string; sha256: string; files: number }>;
export const BOOTSTRAP_DOCKER: DockerBinding;
export const BUILD_BUDGET: LoadBudget;
export const BOOTSTRAP_LIMIT_MS: 300000;
export function findWorkerAncestor(
  pid: number,
  reader: {
    stat(pid: number): Promise<string>;
    exe(pid: number): Promise<string>;
    status(pid: number): Promise<string>;
  },
  actorUid: number,
): Promise<boolean>;
export function bootstrapDiagnostic(
  phase: unknown,
  error: unknown,
  admissionReason?: unknown,
): {
  phase: string;
  code: string;
  admissionReason: string | null;
};
export function parseBootstrapDiagnostic(line: unknown): ReturnType<typeof bootstrapDiagnostic> | null;
export function bootstrapReason(
  sample: AdmissionSample,
  options: { now: number; cpuPercent?: number; memoryPercent?: number; diskReserveMiB?: number },
): AdmissionReason | null;
export function requireDispatch(value: {
  repository: string | undefined;
  event: string | undefined;
  expectedSha: string | undefined;
  dispatchSha: string | undefined;
  head: string;
}): void;
export function assertBootstrapScope(value: {
  runId: string;
  uid: number;
  runnerWorkerAncestor: boolean;
  cgroupText: string;
  cpuMax: string;
  memoryMax: string;
  swapMax: string;
}): void;
