// 실행 로그 버퍼 — "실행" 버튼마다 단계·결과·오류를 시각과 함께 쌓는다(D-089).
// 서버가 SSE 로 단계를 흘려주는 실행은 그 이벤트를 그대로 쌓고(appendServer), 단건 요청형 실행은
// 화면이 요청 시작·응답 요약·오류를 직접 기록한다(log). 보여줄지는 RunLogPanel 의 "로그 보기" 가 정한다.
import { useCallback, useState } from 'react';

export type RunLogLevel = 'info' | 'warn' | 'error';
export interface RunLogLine { ts: string; level: RunLogLevel; message: string }
export type RunStepStatus = 'running' | 'done' | 'failed';
export interface RunStep { name: string; label: string; status: RunStepStatus }

export interface RunLog {
  /** 이번 실행의 이름(예: "K8s 동기화") — 패널 헤더에 표시. */
  title: string;
  lines: RunLogLine[];
  steps: RunStep[];
  running: boolean;
  begin: (title: string, firstMessage?: string) => void;
  log: (level: RunLogLevel, message: string) => void;
  setStep: (name: string, label: string, status: RunStepStatus) => void;
  end: () => void;
  clear: () => void;
}

const LEVELS: RunLogLevel[] = ['info', 'warn', 'error'];

export function toRunLogLevel(v: unknown): RunLogLevel {
  return LEVELS.includes(v as RunLogLevel) ? (v as RunLogLevel) : 'info';
}

export function useRunLog(): RunLog {
  const [title, setTitle] = useState('');
  const [lines, setLines] = useState<RunLogLine[]>([]);
  const [steps, setSteps] = useState<RunStep[]>([]);
  const [running, setRunning] = useState(false);

  const log = useCallback((level: RunLogLevel, message: string) => {
    setLines((prev) => [...prev, { ts: new Date().toISOString(), level, message }]);
  }, []);

  const begin = useCallback((t: string, firstMessage?: string) => {
    setTitle(t);
    setSteps([]);
    setRunning(true);
    setLines(firstMessage ? [{ ts: new Date().toISOString(), level: 'info', message: firstMessage }] : []);
  }, []);

  const setStep = useCallback((name: string, label: string, status: RunStepStatus) => {
    setSteps((prev) => {
      const i = prev.findIndex((s) => s.name === name);
      if (i < 0) return [...prev, { name, label, status }];
      const next = [...prev];
      next[i] = { name, label: label || next[i].label, status };
      return next;
    });
  }, []);

  const end = useCallback(() => setRunning(false), []);
  const clear = useCallback(() => {
    setTitle('');
    setLines([]);
    setSteps([]);
    setRunning(false);
  }, []);

  return { title, lines, steps, running, begin, log, setStep, end, clear };
}

/** LogViewer 에 넘길 텍스트 — `HH:MM:SS LEVEL message`. LogViewer 가 ERROR/WARN 키워드로 색을 입힌다. */
export function formatRunLog(lines: RunLogLine[]): string {
  return lines
    .map((l) => {
      const t = new Date(l.ts);
      const hhmmss = Number.isNaN(t.getTime()) ? l.ts : t.toLocaleTimeString('ko-KR', { hour12: false });
      return `${hhmmss} ${l.level.toUpperCase().padEnd(5)} ${l.message}`;
    })
    .join('\n');
}
