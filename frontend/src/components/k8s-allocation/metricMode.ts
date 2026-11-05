// 자원 수치 표기 방식 — 사용량(기본: 1.5코어 · 3.2Gi) ↔ 사용률(%) 전환.
// 페이지 헤더의 토글이 값을 정하고, 표·게이지·요약 칩이 컨텍스트로 읽는다(prop drilling 방지).
import { createContext, useContext } from 'react';
import { fmtCores, fmtGi, pctText } from './format';

export type MetricMode = 'usage' | 'rate';
export const METRIC_MODES: MetricMode[] = ['usage', 'rate'];

const KEY = 'pep.k8s-allocation.metricMode';
export function readMetricModePref(): MetricMode {
  try { return localStorage.getItem(KEY) === 'rate' ? 'rate' : 'usage'; } catch { return 'usage'; }
}
export function writeMetricModePref(v: MetricMode) {
  try { localStorage.setItem(KEY, v); } catch { /* ignore */ }
}

export const MetricModeContext = createContext<MetricMode>('usage');
export const useMetricMode = () => useContext(MetricModeContext);

export type MetricUnit = 'cpu' | 'mem';
export const fmtAmount = (unit: MetricUnit, v: number) => (unit === 'cpu' ? fmtCores(v) : fmtGi(v));

/** 모드에 맞춘 값 표기 — usage: part 의 절대량, rate: part ÷ whole %. */
export function fmtMetric(mode: MetricMode, unit: MetricUnit, part: number, whole: number): string {
  return mode === 'usage' ? fmtAmount(unit, part) : pctText(part, whole);
}
