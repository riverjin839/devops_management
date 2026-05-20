// Shared types and pure helpers for CreateBatchJobWizard steps.
// Kept in a .ts file (not .tsx) to avoid react-refresh/only-export-components warnings.

export interface WizardState {
  clusterId: string;
  jobType: string;
  name: string;
  description: string;
  defaultHost: string;
  hostSelectedName: string;
  hostCustom: string;
  defaultPort: number;
  defaultUsername: string;
  paramsJson: string;
  cron: string;
  savedPassword: string;
  savedPrivateKey: string;
}

export const EMPTY_WIZARD: WizardState = {
  clusterId: '',
  jobType: '',
  name: '',
  description: '',
  defaultHost: '',
  hostSelectedName: '',
  hostCustom: '',
  defaultPort: 22,
  defaultUsername: 'root',
  paramsJson: '{}',
  cron: '',
  savedPassword: '',
  savedPrivateKey: '',
};

export function isStepTypeValid(state: WizardState): boolean {
  return !!state.clusterId && !!state.jobType && state.name.trim().length > 0;
}

export function isStepHostValid(state: WizardState): boolean {
  // params JSON 파싱 가능 여부만 검증. host 는 비워두고 실행 시 입력해도 됨.
  try {
    if (state.paramsJson.trim()) JSON.parse(state.paramsJson);
    return true;
  } catch {
    return false;
  }
}

/** Step3 은 항상 통과 가능 — 경고만 표시. */
export function isStepScheduleValid(): boolean {
  return true;
}
