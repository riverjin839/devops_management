"""외부 서비스 엔드포인트 스냅샷 — 클러스터가 밖으로 노출한 도메인·IP:Port 목록.

클러스터당 1행(최신 수집 결과). 공개 화면(`/external-services`)은 이 행만 읽고 K8s 를 직접
조회하지 않는다 — 비인증 요청이 클러스터 API 를 때리지 않게.

- entries: [{kind, namespace, name, ip, hostname, port, protocol, ...}] — 수집기 산출물.
- ptr_cache: {ip: {names: [...], source: ssh|backend, host, resolved_at}} — IP → 도메인 역조회 결과.
  수집마다 덮지 않고 병합한다(SSH 로 한 번 찾은 이름이 다음 정기 수집(SSH 없음)에서도 남게).
- fwd_cache: {domain: {ips, source, error, checked_at}} — 도메인 정방향(A 레코드) 검증 결과.
- probe_results: {"scheme|host|ip|port": {reachable, method, http_status, latency_ms, error, source, checked_at}}
  — 엔드포인트 응답 확인 결과.
- 자격증명은 저장하지 않는다(SSH 역조회는 요청 시에만 쓰고 버린다).
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Column, DateTime, ForeignKey, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import backref, relationship

from app.database import Base


class ExternalServiceSnapshot(Base):
    __tablename__ = "external_service_snapshots"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id", ondelete="CASCADE"),
                        nullable=False, unique=True, index=True)
    entries = Column(JSONB, nullable=False, default=list)
    node_ips = Column(JSONB, nullable=True)          # NodePort 접근용 노드 주소 [{name, internal_ip, external_ip}]
    ptr_cache = Column(JSONB, nullable=False, default=dict)
    fwd_cache = Column(JSONB, nullable=True)
    probe_results = Column(JSONB, nullable=True)
    summary = Column(JSONB, nullable=True)
    resolver = Column(String(16), nullable=True)     # 마지막 수집의 역조회 방식: ssh | backend | none
    collected_by = Column(String(64), nullable=True)  # 사용자명 | schedule
    collected_at = Column(DateTime, nullable=True)
    error = Column(String(1000), nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    cluster = relationship("Cluster", backref=backref("external_service_snapshot", passive_deletes=True,
                                                      uselist=False))
