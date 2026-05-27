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

/**
 * Design Ref: §2.4.1 — shared invariant for Wizard + EditForm.
 * Backend 의 _require_cron_credentials 와 의미 동일.
 *
 * cron 식이 비어있지 않고 자격증명도 둘 다 비어있으면 true.
 * true 면 등록/저장 버튼을 disabled 해야 한다 — 그대로 보내면 422.
 *
 * EditForm 처럼 partial update 일 경우 caller 가 미리 머지한
 * 최종 자격증명 상태(`finalHasPassword`, `finalHasPrivateKey` 의미)
 * 를 password/key 인자로 전달해야 한다.
 */
export function cronRequiresCredentials(
  cron: string | null | undefined,
  savedPassword: string | null | undefined,
  savedPrivateKey: string | null | undefined,
): boolean {
  if (!cron || !cron.trim()) return false;
  return !savedPassword && !savedPrivateKey;
}
