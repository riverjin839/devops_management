import { homePrefsApi } from '@/services/api';
import { replacePersonal, snapshotPersonal } from './personalStorage';

/**
 * 개인 설정 파일(.json) 만들기/적용하기 — 환경 이전(새 클러스터 배포·새 PC) 때 내 설정만 옮긴다.
 *
 * 파일 = 서버 저장 개인 설정(`server`, 백엔드 services/personal_settings.py 허용 목록) +
 *        브라우저 로컬 개인 설정(`local`, lib/personalStorage.ts 의 개인 키).
 * 비밀(MinIO 별칭 비밀번호·Jira 자격증명·로그인 토큰)은 어느 쪽에도 담기지 않는다.
 */

const FORMAT = 'pep-personal-settings';

interface SettingsFile {
  format: string;
  version: number;
  exported_at?: string;
  username?: string;
  server?: Record<string, unknown>;
  local?: Record<string, unknown>;
}

export async function exportPersonalSettings(): Promise<string> {
  const { data } = await homePrefsApi.exportSettings();
  const doc = JSON.parse(data.document) as SettingsFile;
  const file: SettingsFile = { ...doc, local: snapshotPersonal() };
  const name = `pep-settings-${doc.username ?? 'me'}-${new Date().toISOString().slice(0, 10)}.json`;
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
  return name;
}

export interface ImportResult {
  applied: string[];
  skipped: string[];
  localCount: number;
}

/** 파일을 읽어 서버·로컬 개인 설정을 교체한다. 호출부가 이후 새로 고침해야 화면에 반영된다. */
export async function importPersonalSettings(file: File): Promise<ImportResult> {
  let parsed: SettingsFile;
  try {
    parsed = JSON.parse(await file.text()) as SettingsFile;
  } catch {
    throw new Error('JSON 파일이 아닙니다.');
  }
  if (parsed?.format !== FORMAT) throw new Error('PEP 개인 설정 파일이 아닙니다.');
  const { data } = await homePrefsApi.importSettings(
    JSON.stringify({ format: parsed.format, version: parsed.version, server: parsed.server ?? {} }),
  );
  const localCount = parsed.local && typeof parsed.local === 'object' ? replacePersonal(parsed.local) : 0;
  return { applied: data.applied, skipped: data.skipped, localCount };
}
