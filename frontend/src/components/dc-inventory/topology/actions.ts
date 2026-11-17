// 토폴로지 편집기 쓰기 보조 — 다이얼로그와 캔버스가 함께 쓴다.
import { dcApi } from '@/services/api';

/** 구간 아래 같은 이름의 열을 찾고, 없으면 만든다(랙은 열에 속한다). */
export async function ensureRackRow(zoneId: string, rowName: string): Promise<string> {
  const { data } = await dcApi.list<{ id: string; name: string }>('rack-rows', { hall_id: zoneId, limit: 500 });
  const found = data.items.find((r) => r.name === rowName);
  if (found) return found.id;
  return (await dcApi.create<{ id: string }>('rack-rows', { hallId: zoneId, name: rowName })).data.id;
}

/** 이름에 쓰기 좋은 짧은 꼴 — `R07` → `r07`. */
export function slug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'rack';
}

/** 연결선 선택 id — 상위|하위 장비 id. */
export const edgeKey = (e: { upperId: string; lowerId: string }) => `${e.upperId}|${e.lowerId}`;
