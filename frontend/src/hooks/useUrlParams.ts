// 목록 화면의 탭·필터·검색어·정렬을 URL 쿼리에 두는 공용 훅 (D-029, D-053 패턴 공용화).
// 새로고침·링크 공유·상세에서 뒤로가기로 돌아왔을 때 같은 조건이 그대로 열린다.
//  - 값은 문자열. 기본값과 같으면 쿼리에서 지워 URL 을 짧게 유지한다.
//  - `replace` 로 바꿔 필터 조작이 히스토리에 쌓이지 않는다(뒤로가기는 화면 단위로 움직인다).
//  - 다른 쿼리와 현재 hash 를 보존한다 — 열린 모달의 뒤로가기 기록(`#modal-…`)을 깨지 않는다.
//    (react-router 의 setSearchParams 는 hash 를 지운다.)
//  - Your Island 패널 안에 임베드됐거나 `{ local: true }` 면 URL 대신 로컬 state 로 동작한다
//    (아일랜드 라우트의 쿼리와 섞이지 않게 — `useClusterRouteParam` 과 같은 규칙).
import { useCallback, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useIsIslandEmbedded } from '@/lib/islandEmbed';

type Patch<D> = Partial<Record<keyof D, string | null | undefined>>;

export function useUrlParams<D extends Record<string, string>>(
  defaults: D,
  opts: { local?: boolean } = {},
): [D, (patch: Patch<D>) => void] {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const embedded = useIsIslandEmbedded() || !!opts.local;
  const [localVals, setLocalVals] = useState<Record<string, string>>({});
  const defaultsRef = useRef(defaults);
  defaultsRef.current = defaults;
  const keySig = Object.keys(defaults).join('\u0000');

  const values = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [k, d] of Object.entries(defaultsRef.current)) {
      out[k] = (embedded ? localVals[k] : searchParams.get(k)) ?? d;
    }
    return out as D;
    // keySig: 키 구성이 바뀔 때만 다시 계산(기본값 객체는 렌더마다 새로 만들어도 된다)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, keySig, embedded, localVals]);

  const set = useCallback((patch: Patch<D>) => {
    if (embedded) {
      setLocalVals((prev) => {
        const next = { ...prev };
        for (const [k, v] of Object.entries(patch)) {
          if (v == null || v === defaultsRef.current[k]) delete next[k];
          else next[k] = v;
        }
        return next;
      });
      return;
    }
    // 같은 틱에 여러 번 불려도 앞선 변경을 잃지 않게 현재 주소에서 시작한다.
    const next = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === defaultsRef.current[k]) next.delete(k);
      else next.set(k, v);
    }
    const q = next.toString();
    navigate(
      { pathname: window.location.pathname, search: q ? `?${q}` : '', hash: window.location.hash },
      { replace: true },
    );
  }, [navigate, embedded]);

  return [values, set];
}

/** 쿼리 하나만 쓸 때. */
export function useUrlParam(
  key: string,
  defaultValue = '',
  opts: { local?: boolean } = {},
): [string, (v: string | null) => void] {
  const [values, set] = useUrlParams({ [key]: defaultValue }, opts);
  const setOne = useCallback((v: string | null) => set({ [key]: v }), [set, key]);
  return [values[key], setOne];
}

/** 쿼리 값을 허용 목록으로 좁힌다(알 수 없는 값은 기본값). */
export function pickParam<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}
