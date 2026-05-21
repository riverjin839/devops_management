import {
  Workflow, Zap, Layers, Database, BarChart3, BookOpen, PieChart, Library,
} from 'lucide-react';
import type { ComponentType } from 'react';

const ICON_MAP: Record<string, ComponentType<{ className?: string }>> = {
  airflow:    Workflow,    // 워크플로우 오케스트레이션
  spark:      Zap,         // 분산 컴퓨팅 — '번개'
  iceberg:    Layers,      // 테이블 포맷 — 레이어드
  trino:      Database,    // 분산 SQL — DB
  starrocks:  BarChart3,   // OLAP MPP — chart
  jupyterlab: BookOpen,    // notebook
  superset:   PieChart,    // BI 대시보드
  polaris:    Library,     // catalog — 책장
};

interface ServiceTypeIconProps {
  serviceType: string;
  className?: string;
}

export function ServiceTypeIcon({ serviceType, className = 'w-4 h-4' }: ServiceTypeIconProps) {
  const Icon = ICON_MAP[serviceType] ?? Database;
  return <Icon className={className} />;
}
