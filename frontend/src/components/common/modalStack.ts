// 열린 모달의 쌓임 순서 — Escape·포커스 트랩을 "맨 위 모달"만 처리하게 하는 레지스트리.
//
// `useModalA11y` 는 모달마다 document capture 단계에 keydown 리스너를 단다. 같은 노드의 리스너는
// 등록 순서대로 불리고 `stopPropagation` 으로는 서로를 막지 못하므로, 부모 모달이 열린 채 확인 창
// (`ConfirmDialog`)을 열고 Escape 를 누르면 먼저 등록된 부모 리스너가 부모를 닫아 확인 창까지 함께
// 사라졌다. 그래서 열린 순서를 여기에 쌓아 두고, 리스너는 자기가 맨 위일 때만 Escape/Tab 을 처리한다.
//
// Base UI `Dialog` 래퍼(`ui/dialog`)도 열려 있는 동안 층을 하나 차지한다. 그래야 커스텀 모달 위에
// Base UI 다이얼로그가 떴을 때 아래 모달이 Escape 를 가로채지 않고, Base UI 가 자기 Escape 를 처리한다.
// 반대로 Base UI 다이얼로그 위에 확인 창이 떠 있으면 래퍼가 Base UI 의 Escape 닫기를 취소한다.
// 층을 등록하지 않는 UI(자체 Escape 리스너를 가진 팝오버 등)는 이 순서와 무관하게 예전처럼 동작한다.

import { useCallback, useEffect, useRef } from 'react';

const layers: symbol[] = [];

export interface ModalLayer {
  /** 지금 이 모달이 맨 위인가. */
  isTop: () => boolean;
  /** 모달이 닫히거나 언마운트될 때 부른다. */
  release: () => void;
}

/** 모달 층을 맨 위에 하나 올린다. */
export function pushModalLayer(): ModalLayer {
  const key = Symbol('modal-layer');
  layers.push(key);
  return {
    isTop: () => layers[layers.length - 1] === key,
    release: () => {
      const i = layers.indexOf(key);
      if (i >= 0) layers.splice(i, 1);
    },
  };
}

/**
 * `open` 인 동안 층을 하나 차지한다 — Escape 를 스스로 처리하는 UI(Base UI `Dialog` 래퍼)용.
 * 반환한 `isTop` 으로 "내 위에 다른 모달이 떠 있는가"를 판단해 자기 Escape 처리를 거른다.
 */
export function useModalLayer(open: boolean): () => boolean {
  const layerRef = useRef<ModalLayer | null>(null);
  useEffect(() => {
    if (!open) return;
    const layer = pushModalLayer();
    layerRef.current = layer;
    return () => {
      layer.release();
      if (layerRef.current === layer) layerRef.current = null;
    };
  }, [open]);
  return useCallback(() => layerRef.current?.isTop() ?? true, []);
}
