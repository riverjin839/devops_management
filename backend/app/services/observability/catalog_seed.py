"""관측 모듈/지표 카탈로그 기본값.

여기 있는 값은 **초기 1회 seed 용 기본값**일 뿐이다. 운영자가 화면(/observability → 지표 편집)
에서 PromQL·임계값·라벨을 자유롭게 고칠 수 있고, 고친 값이 원천이 된다(CLAUDE.md §UI-First).
새 모듈(alert-forwarder / opensearch-stack / fluent-operator)을 활성화할 때도 코드가 아니라
지표 행을 추가하면 된다.

kube-prometheus-stack 지표는 스택이 **자기 자신을 노출하는 메트릭**(prometheus_*,
alertmanager_*, up{job=...}) 기준이라 배포마다 job 라벨이 다를 수 있다 — 그래서 정규식
매처(`job=~".*prometheus.*"`)를 기본값으로 쓰고, 안 맞으면 화면에서 고치도록 help 에 적어둔다.
"""
from __future__ import annotations

import logging

_log = logging.getLogger(__name__)

KUBE_PROM = "kube-prometheus-stack"

MODULES: list[dict] = [
    {
        "key": KUBE_PROM,
        "label": "kube-prometheus-stack",
        "description": "Prometheus Operator 기반 메트릭 수집·알람 스택 (Prometheus / Alertmanager / node-exporter / kube-state-metrics)",
        "icon": "Activity",
        "status": "active",
        "sort_order": 0,
    },
    {
        "key": "alert-forwarder",
        "label": "alert-forwarder",
        "description": "Alertmanager 알람을 사내 메신저(cube) 등으로 전달하는 포워더. 지표를 등록하면 활성화된다.",
        "icon": "Send",
        "status": "planned",
        "sort_order": 1,
    },
    {
        "key": "opensearch-stack",
        "label": "opensearch-stack",
        "description": "로그 저장·검색 스택(OpenSearch / Dashboards). 지표를 등록하면 활성화된다.",
        "icon": "Search",
        "status": "planned",
        "sort_order": 2,
    },
    {
        "key": "fluent-operator",
        "label": "fluent-operator",
        "description": "Fluent Bit / Fluentd 로그 수집 파이프라인 오퍼레이터. 지표를 등록하면 활성화된다.",
        "icon": "Waves",
        "status": "planned",
        "sort_order": 3,
    },
]

_PROM_JOB = 'job=~".*prometheus.*"'
_AM_JOB = 'job=~".*alertmanager.*"'

# 값이 낮을수록 나쁨(invert=True) 인 지표는 up / 성공여부 계열이다.
METRICS: list[dict] = [
    # ── Prometheus 서버 ─────────────────────────────────────────────────────
    {
        "key": "prometheus_up", "label": "Prometheus 기동", "category": "prometheus",
        "promql": f"min(up{{{_PROM_JOB}}})", "unit": "", "display_type": "bool",
        "thresholds": "critical:1", "invert": True,
        "help": "Prometheus 인스턴스의 up 값(1=정상). job 라벨이 다르면 PromQL 의 정규식을 환경에 맞게 수정한다.",
    },
    {
        "key": "prometheus_tsdb_head_series", "label": "TSDB head 시계열 수", "category": "prometheus",
        "promql": f"max(prometheus_tsdb_head_series{{{_PROM_JOB}}})", "unit": "count",
        "display_type": "value", "thresholds": "warning:4000000,critical:8000000", "invert": False,
        "help": "메모리에 올라와 있는 활성 시계열 수. 급증하면 카디널리티 폭발을 의심한다.",
    },
    {
        "key": "prometheus_tsdb_head_chunks", "label": "TSDB head 청크 수", "category": "prometheus",
        "promql": f"max(prometheus_tsdb_head_chunks{{{_PROM_JOB}}})", "unit": "count",
        "display_type": "value", "thresholds": None, "invert": False,
        "help": "head 블록의 청크 수. 시계열 수와 함께 메모리 사용량을 좌우한다.",
    },
    {
        "key": "prometheus_wal_corruptions", "label": "WAL 손상 횟수", "category": "prometheus",
        "promql": f"sum(prometheus_tsdb_wal_corruptions_total{{{_PROM_JOB}}}) OR on() vector(0)",
        "unit": "count", "display_type": "value", "thresholds": "warning:1,critical:1", "invert": False,
        "help": "0 이 아니면 WAL 이 손상된 적이 있다는 뜻 — 디스크/재시작 이력을 확인한다.",
    },
    {
        "key": "prometheus_config_reload_ok", "label": "설정 reload 성공", "category": "prometheus",
        "promql": f"min(prometheus_config_last_reload_successful{{{_PROM_JOB}}})", "unit": "",
        "display_type": "bool", "thresholds": "critical:1", "invert": True,
        "help": "0 이면 마지막 설정 적용이 실패한 상태 — ServiceMonitor/rule 문법 오류를 의심한다.",
    },
    {
        "key": "prometheus_rule_eval_failures", "label": "규칙 평가 실패(5m)", "category": "prometheus",
        "promql": f"sum(rate(prometheus_rule_evaluation_failures_total{{{_PROM_JOB}}}[5m])) OR on() vector(0)",
        "unit": "/s", "display_type": "value", "thresholds": "warning:0.01,critical:0.1", "invert": False,
        "help": "알람/기록 규칙 평가가 실패하는 비율. 0 이 아니면 해당 규칙이 동작하지 않는다.",
    },
    {
        "key": "prometheus_rule_group_delay", "label": "규칙 그룹 평가 지연", "category": "prometheus",
        "promql": f"max(prometheus_rule_group_last_duration_seconds{{{_PROM_JOB}}})", "unit": "s",
        "display_type": "duration", "thresholds": "warning:10,critical:30", "invert": False,
        "help": "가장 오래 걸린 규칙 그룹의 평가 시간. 평가 주기를 넘기면 알람이 늦어진다.",
    },
    {
        "key": "prometheus_dropped_samples", "label": "스크레이프 샘플 drop(5m)", "category": "prometheus",
        "promql": (
            "sum(rate(prometheus_target_scrapes_sample_out_of_order_total[5m])) "
            "+ sum(rate(prometheus_target_scrapes_sample_duplicate_timestamp_total[5m])) OR on() vector(0)"
        ),
        "unit": "/s", "display_type": "value", "thresholds": "warning:0.01,critical:1", "invert": False,
        "help": "순서 역전/중복 타임스탬프로 버려진 샘플 비율. 중복 스크레이프 설정을 의심한다.",
    },
    {
        "key": "prometheus_sd_failures", "label": "대상 sync 실패(5m)", "category": "prometheus",
        "promql": "sum(rate(prometheus_target_sync_failed_total[5m])) OR on() vector(0)",
        "unit": "/s", "display_type": "value", "thresholds": "warning:0.01,critical:0.1", "invert": False,
        "help": "서비스 디스커버리 동기화 실패 비율. RBAC/네트워크 문제일 수 있다.",
    },
    {
        "key": "prometheus_remote_write_lag", "label": "원격쓰기 지연", "category": "prometheus",
        "promql": (
            "max(prometheus_remote_storage_highest_timestamp_in_seconds "
            "- ignoring(remote_name, url) prometheus_remote_storage_queue_highest_sent_timestamp_seconds) "
            "OR on() vector(0)"
        ),
        "unit": "s", "display_type": "duration", "thresholds": "warning:60,critical:300", "invert": False,
        "help": "remote_write 를 쓰지 않는 구성이면 0 으로 나온다.",
    },
    {
        "key": "prometheus_storage_retention", "label": "TSDB 보존 한계 도달", "category": "prometheus",
        "promql": f"max(prometheus_tsdb_retention_limit_bytes{{{_PROM_JOB}}}) OR on() vector(0)",
        "unit": "bytes", "display_type": "bytes", "thresholds": None, "invert": False,
        "help": "size 기반 보존을 쓰지 않으면 0. 시간 기반 보존은 Prometheus CR 의 retention 필드를 본다.",
    },

    # ── Alertmanager ────────────────────────────────────────────────────────
    {
        "key": "alertmanager_up", "label": "Alertmanager 기동", "category": "alertmanager",
        "promql": f"min(up{{{_AM_JOB}}})", "unit": "", "display_type": "bool",
        "thresholds": "critical:1", "invert": True,
        "help": "Alertmanager 인스턴스 up 값. 0 이면 알람이 어디로도 나가지 않는다.",
    },
    {
        "key": "alertmanager_peers", "label": "클러스터 peer 수", "category": "alertmanager",
        "promql": "max(alertmanager_cluster_members) OR on() vector(0)", "unit": "count",
        "display_type": "value", "thresholds": None, "invert": True,
        "help": "HA 구성일 때 기대 replica 수와 일치해야 한다. 단일 인스턴스면 1.",
    },
    {
        "key": "alertmanager_alerts_active", "label": "현재 활성 알람", "category": "alertmanager",
        "promql": 'sum(alertmanager_alerts{state="active"}) OR on() vector(0)', "unit": "count",
        "display_type": "value", "thresholds": "warning:10,critical:50", "invert": False,
        "help": "Alertmanager 가 보유 중인 active 알람 수.",
    },
    {
        "key": "alertmanager_silences", "label": "활성 silence", "category": "alertmanager",
        "promql": 'sum(alertmanager_silences{state="active"}) OR on() vector(0)', "unit": "count",
        "display_type": "value", "thresholds": "warning:5", "invert": False,
        "help": "silence 가 많으면 실제 장애가 가려질 수 있다 — 만료일 관리를 확인한다.",
    },
    {
        "key": "alertmanager_notify_failures", "label": "알림 전송 실패(5m)", "category": "alertmanager",
        "promql": "sum(rate(alertmanager_notifications_failed_total[5m])) OR on() vector(0)",
        "unit": "/s", "display_type": "value", "thresholds": "warning:0.01,critical:0.1", "invert": False,
        "help": "cube/PEP 등 receiver 로의 전송 실패 비율. 0 이 아니면 알람이 유실되고 있다.",
    },
    {
        "key": "alertmanager_config_reload_ok", "label": "설정 reload 성공", "category": "alertmanager",
        "promql": "min(alertmanager_config_last_reload_successful) OR on() vector(1)", "unit": "",
        "display_type": "bool", "thresholds": "critical:1", "invert": True,
        "help": "0 이면 receiver/route 설정이 반영되지 않은 상태다.",
    },

    # ── Exporter ────────────────────────────────────────────────────────────
    {
        "key": "node_exporter_up", "label": "node-exporter 정상 비율", "category": "exporter",
        "promql": (
            'sum(up{job=~".*node-exporter.*"}) / count(up{job=~".*node-exporter.*"}) * 100 '
            "OR on() vector(0)"
        ),
        "unit": "%", "display_type": "ratio", "thresholds": "warning:99,critical:90", "invert": True,
        "help": "노드 지표를 못 걷는 노드가 있으면 100% 미만이 된다.",
    },
    {
        "key": "kube_state_metrics_up", "label": "kube-state-metrics 기동", "category": "exporter",
        "promql": 'min(up{job=~".*kube-state-metrics.*"}) OR on() vector(0)', "unit": "",
        "display_type": "bool", "thresholds": "critical:1", "invert": True,
        "help": "0 이면 파드/디플로이먼트 상태 기반 알람이 전부 멈춘다.",
    },
    {
        "key": "kubelet_scrape_up", "label": "kubelet 스크레이프 정상 비율", "category": "exporter",
        "promql": 'sum(up{job=~".*kubelet.*"}) / count(up{job=~".*kubelet.*"}) * 100 OR on() vector(0)',
        "unit": "%", "display_type": "ratio", "thresholds": "warning:99,critical:90", "invert": True,
        "help": "cAdvisor/kubelet 지표 수집 성공 비율.",
    },
    {
        "key": "scrape_duration_p99", "label": "스크레이프 소요 p99", "category": "exporter",
        "promql": "quantile(0.99, scrape_duration_seconds)", "unit": "s", "display_type": "duration",
        "thresholds": "warning:5,critical:10", "invert": False,
        "help": "느린 타겟이 있으면 스크레이프 타임아웃으로 이어진다.",
    },

    # ── Operator ────────────────────────────────────────────────────────────
    {
        "key": "prometheus_operator_up", "label": "prometheus-operator 기동", "category": "operator",
        "promql": 'min(up{job=~".*prometheus-operator.*"}) OR on() vector(0)', "unit": "",
        "display_type": "bool", "thresholds": "critical:1", "invert": True,
        "help": "0 이면 CR 변경(ServiceMonitor/PrometheusRule)이 반영되지 않는다.",
    },
    {
        "key": "operator_reconcile_errors", "label": "reconcile 에러(5m)", "category": "operator",
        "promql": "sum(rate(prometheus_operator_reconcile_errors_total[5m])) OR on() vector(0)",
        "unit": "/s", "display_type": "value", "thresholds": "warning:0.01,critical:0.1", "invert": False,
        "help": "0 이 아니면 오퍼레이터가 리소스를 반영하지 못하고 있다.",
    },
    {
        "key": "operator_managed_resources", "label": "관리 중 리소스 수", "category": "operator",
        "promql": "sum(prometheus_operator_managed_resources) OR on() vector(0)", "unit": "count",
        "display_type": "value", "thresholds": None, "invert": False,
        "help": "오퍼레이터가 관리 중인 CR 총합(Prometheus/Alertmanager/ServiceMonitor 등).",
    },
    {
        "key": "operator_watch_errors", "label": "watch 에러(5m)", "category": "operator",
        "promql": "sum(rate(prometheus_operator_watch_operations_failed_total[5m])) OR on() vector(0)",
        "unit": "/s", "display_type": "value", "thresholds": "warning:0.01", "invert": False,
        "help": "API 서버 watch 실패 비율. RBAC/네트워크 문제일 수 있다.",
    },

    # ── 알람 규칙 ────────────────────────────────────────────────────────────
    {
        "key": "rules_total", "label": "알람 규칙 수", "category": "rules",
        "promql": f"max(prometheus_rule_group_rules{{{_PROM_JOB}}}) OR sum(prometheus_rule_group_rules) OR on() vector(0)",
        "unit": "count", "display_type": "value", "thresholds": None, "invert": False,
        "help": "로드된 규칙 총 개수. 갑자기 줄면 PrometheusRule 이 사라진 것이다.",
    },
    {
        "key": "alerts_firing", "label": "발화 중 알람", "category": "rules",
        "promql": 'sum(ALERTS{alertstate="firing"}) OR on() vector(0)', "unit": "count",
        "display_type": "value", "thresholds": "warning:1,critical:10", "invert": False,
        "help": "현재 firing 상태인 알람 수.",
    },
    {
        "key": "alerts_pending", "label": "대기 중 알람", "category": "rules",
        "promql": 'sum(ALERTS{alertstate="pending"}) OR on() vector(0)', "unit": "count",
        "display_type": "value", "thresholds": "warning:5", "invert": False,
        "help": "for 구간을 채우는 중인 알람 수 — 곧 firing 될 후보.",
    },
    {
        "key": "alerts_critical_firing", "label": "Critical 발화", "category": "rules",
        "promql": 'sum(ALERTS{alertstate="firing", severity="critical"}) OR on() vector(0)',
        "unit": "count", "display_type": "value", "thresholds": "warning:1,critical:1", "invert": False,
        "help": "severity=critical 라벨이 붙은 발화 알람. 라벨 규약이 다르면 PromQL 을 수정한다.",
    },
]


def seed_observability_catalog() -> None:
    """모듈/지표 카탈로그를 최초 1회 seed 한다 (테이블이 비었을 때만).

    이미 행이 있으면 아무것도 하지 않는다 — 운영자가 편집한 값을 덮어쓰지 않기 위함.
    단, 모듈 행은 개별 key 기준으로 없는 것만 추가한다(모듈이 늘어난 릴리스 대응).
    """
    from app.database import SessionLocal
    from app.models.observability import ObservabilityMetric, ObservabilityModule

    db = SessionLocal()
    try:
        existing_modules = {m.key for m in db.query(ObservabilityModule.key).all()}
        added_modules = 0
        for mod in MODULES:
            if mod["key"] in existing_modules:
                continue
            db.add(ObservabilityModule(**mod))
            added_modules += 1

        added_metrics = 0
        if db.query(ObservabilityMetric).count() == 0:
            for idx, met in enumerate(METRICS):
                db.add(ObservabilityMetric(module_key=KUBE_PROM, sort_order=idx, **met))
                added_metrics += 1

        if added_modules or added_metrics:
            db.commit()
            _log.info(
                "seed: observability catalog — modules=%s metrics=%s", added_modules, added_metrics)
    except Exception as e:  # noqa: BLE001
        db.rollback()
        _log.warning("seed: observability catalog 실패 (%s) — 건너뜀", e)
    finally:
        db.close()
