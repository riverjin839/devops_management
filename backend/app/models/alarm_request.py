"""알람 등록 요청 — 서비스 담당자가 운영 알람 추가·임계치 변경을 요청하고 관리자가 검토·반영한다.

- ``AlarmCatalogItem``: 서비스별 알람 항목(metric 명)과 의미·기본 임계치. 시드 행이지만 DB 행이라
  화면(관리자 카탈로그 편집)에서 고친다(UI-First). 요청이 「반영 완료」되면 그 요청의 수정 임계치가
  카탈로그 기본 임계치가 된다(없는 항목이면 새로 만든다).
- ``AlarmRequest``: 요청 1건. 임계치는 심각도별 행 목록(JSONB) — 행마다 기본(expr·for) / 수정(expr·for).
  적용 클러스터는 id + 이름 스냅샷(클러스터가 지워져도 요청서는 읽혀야 한다). 처리 이력은 append-only JSONB.
"""
from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB

from app.database import Base


class AlarmCatalogItem(Base):
    __tablename__ = "alarm_catalog_items"

    id = Column(Integer, primary_key=True, autoincrement=True)
    service = Column(String(50), nullable=False, index=True)        # k8s / cilium / aistor / cnpg …
    metric_name = Column(String(200), nullable=False)               # 알람 항목(alertname)
    meaning = Column(Text, nullable=True)                           # 알람 의미
    # [{"severity": "warning", "expr": "...", "for": "5m"}]
    thresholds = Column(JSONB, nullable=False, default=list)
    enabled = Column(Boolean, nullable=False, default=True)
    updated_by = Column(String(100), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class AlarmRequest(Base):
    __tablename__ = "alarm_requests"

    id = Column(Integer, primary_key=True, autoincrement=True)      # 화면 번호 AR-0001
    # requested / reviewing / approved / applied / rejected
    status = Column(String(20), nullable=False, default="requested", index=True)
    service = Column(String(50), nullable=False, index=True)
    metric_name = Column(String(200), nullable=False)
    meaning = Column(Text, nullable=True)
    catalog_item_id = Column(Integer, nullable=True)                # 카탈로그 항목에서 시작했으면 그 id(FK 없음)
    # [{"severity", "base_expr", "base_for", "new_expr", "new_for"}]
    thresholds = Column(JSONB, nullable=False, default=list)
    # [{"id": "<cluster uuid>", "name": "<표시 이름 스냅샷>"}]
    clusters = Column(JSONB, nullable=False, default=list)
    note = Column(Text, nullable=True)

    requested_by = Column(String(100), nullable=False, index=True)  # 소유권 판정용 username
    requester_name = Column(String(100), nullable=True)             # 표시명 스냅샷
    review_comment = Column(Text, nullable=True)
    reviewed_by = Column(String(100), nullable=True)
    reviewed_at = Column(DateTime, nullable=True)
    applied_at = Column(DateTime, nullable=True)
    # [{"at": iso, "by": "표시명", "action": "created|updated|reviewing|approved|rejected|applied", "comment": "..."}]
    history = Column(JSONB, nullable=False, default=list)
    # PrometheusRule 자동 적용 실행 기록(최근 N건, 최신이 앞) —
    # [{"at", "by", "ok", "results": [{cluster_id, cluster_name, namespace, name, status, message}], "log": [[ts, level, msg]]}]
    # log 의 level="cmd" 줄(실제 K8S API 호출)은 조회 때 관리자가 아니면 뺀다.
    apply_runs = Column(JSONB, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
