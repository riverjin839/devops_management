#!/usr/bin/env python3
"""로컬(집) 테스트용 샘플 데이터 시드 스크립트.

담당자 ~10명 + 약 1달치 다양한 업무(work_items)를 생성해 대시보드/담당자별 진행현황/
월간 캘린더/주간 타임라인을 실제처럼 확인할 수 있게 한다.

특징
- **DB 직접 삽입**(app.database.SessionLocal + ORM) — 인증 불필요. 로컬 docker-compose 에 적합.
- **재실행 안전** — 생성한 업무에 created_by="seed-sample" 마커를 달아 --reset 으로만 정리.
  (실제 데이터는 건드리지 않는다.)
- 다양성: type(task/issue/meeting/training/etc) · 기능(type_label) · 업무영역(category) ·
  서비스(service) · 상태(kanban_status) · 우선순위 · 날짜(과거~미래) · primary/secondary 담당.

실행 (docker-compose):
    docker-compose exec backend python scripts/seed_sample_data.py
    docker-compose exec backend python scripts/seed_sample_data.py --reset   # 기존 시드 지우고 재생성

실행 (네이티브, backend/ 에서):
    DATABASE_URL=postgresql://postgres:postgres@localhost:5432/k8s_monitor \
      python scripts/seed_sample_data.py

옵션:
    --reset              기존 시드(work_items, created_by=seed-sample) 삭제 후 재생성
    --per-assignee N     담당자 1명당 생성할 업무 수 (기본 14)
    --days-back N        과거 며칠부터 (기본 28)
    --days-ahead N       미래 며칠까지 (기본 7)
    --keep-assignees     담당자 목록(app_settings)은 건드리지 않음 (업무만 생성)
    --seed N             난수 시드(재현용)
"""
from __future__ import annotations

import argparse
import os
import random
import sys
import uuid
from datetime import datetime, timedelta

# backend/ 를 import 경로에 추가 (scripts/ 의 상위) → `import app...` 가능
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database import SessionLocal  # noqa: E402
import app.models  # noqa: F401,E402  (모든 ORM 매퍼 등록 — 관계 resolve)
from app.models.work_item import WorkItem  # noqa: E402
from app.models.app_setting import AppSetting  # noqa: E402
from app.models.cluster import Cluster  # noqa: E402

SEED_MARKER = "seed-sample"  # created_by — 정리(--reset) 식별용

# ── 담당자 10명 (이름·사번·역할) ────────────────────────────────────────────────
ASSIGNEES = [
    {"name": "김도현", "employeeId": "E1001", "primaryRole": "Platform",   "secondaryRole": "SRE"},
    {"name": "이서연", "employeeId": "E1002", "primaryRole": "SRE",        "secondaryRole": "Security"},
    {"name": "박지훈", "employeeId": "E1003", "primaryRole": "Backend",    "secondaryRole": "Platform"},
    {"name": "최수아", "employeeId": "E1004", "primaryRole": "Frontend",   "secondaryRole": "Docs"},
    {"name": "정민준", "employeeId": "E1005", "primaryRole": "Network",    "secondaryRole": "Platform"},
    {"name": "강하은", "employeeId": "E1006", "primaryRole": "Security",   "secondaryRole": "SRE"},
    {"name": "윤재원", "employeeId": "E1007", "primaryRole": "Storage",    "secondaryRole": "Backend"},
    {"name": "임채린", "employeeId": "E1008", "primaryRole": "Data",       "secondaryRole": "Backend"},
    {"name": "한지오", "employeeId": "E1009", "primaryRole": "DevOps",     "secondaryRole": "Network"},
    {"name": "오세훈", "employeeId": "E1010", "primaryRole": "QA",         "secondaryRole": "Docs"},
]
for a in ASSIGNEES:
    a["email"] = f"{a['employeeId'].lower()}@example.com"
    a["ip"] = None

# ── 다양성 풀 ───────────────────────────────────────────────────────────────────
CATEGORIES = ["모니터링", "배포/릴리스", "장애 대응", "보안 점검", "인프라 구축",
              "문서화", "성능 튜닝", "백업/복구", "네트워크", "교육/온보딩"]
SERVICES = ["k8s", "monitoring", "ci-cd", "storage", "network", "security", "database", "logging"]
TYPE_LABELS = ["feature", "bug", "chore", "docs", "security"]
KANBAN = ["backlog", "todo", "in_progress", "review_test", "done"]
PRIORITIES = ["high", "medium", "low"]

# type 별 제목 템플릿 (업무 종류별로 자연스럽게)
TASK_ACTIONS = [
    "배포 자동화", "리소스 점검", "매니페스트 정리", "HPA 튜닝", "인증서 갱신",
    "로그 파이프라인 구성", "대시보드 개선", "알림 룰 정비", "백업 스케줄 점검",
    "노드 라벨링", "네트워크 정책 적용", "PV/PVC 정리", "이미지 취약점 스캔",
]
ISSUE_SYMPTOMS = [
    "Pod CrashLoopBackOff", "노드 NotReady", "etcd 응답 지연", "OOMKilled 다발",
    "PVC Pending", "인증서 만료 임박", "Ingress 5xx 급증", "DNS 해석 실패",
]
MEETING_TITLES = ["주간 운영 회의", "스프린트 플래닝", "장애 회고(포스트모템)", "아키텍처 리뷰"]
TRAINING_TITLES = ["신규 입사자 온보딩", "Cilium 핸즈온", "보안 정기 교육", "kubeadm 실습"]
ETC_TITLES = ["분기 점검 준비", "라이선스 갱신", "벤더 미팅 정리", "위키 정리"]

# type 분포 (task 위주, issue 다음, 나머지 소량)
TYPE_WEIGHTS = [("task", 0.55), ("issue", 0.25), ("meeting", 0.1), ("training", 0.05), ("etc", 0.05)]


def weighted_choice(pairs):
    r = random.random()
    acc = 0.0
    for value, w in pairs:
        acc += w
        if r <= acc:
            return value
    return pairs[-1][0]


def make_title(wtype: str, service: str, category: str) -> str:
    if wtype == "task":
        return f"[{service}] {random.choice(TASK_ACTIONS)}"
    if wtype == "issue":
        return f"[장애][{service}] {random.choice(ISSUE_SYMPTOMS)}"
    if wtype == "meeting":
        return random.choice(MEETING_TITLES)
    if wtype == "training":
        return random.choice(TRAINING_TITLES)
    return random.choice(ETC_TITLES)


def pick_status(started: datetime, today: datetime) -> str:
    """날짜에 맞는 그럴듯한 상태 분포.
    과거: 완료 위주 + 미완료 일부(지연 버킷) / 오늘: 진행·예정 / 미래: 대기·예정."""
    d0 = started.date()
    t0 = today.date()
    if d0 < t0:
        return weighted_choice([("done", 0.55), ("in_progress", 0.2), ("review_test", 0.1), ("todo", 0.15)])
    if d0 == t0:
        return weighted_choice([("in_progress", 0.4), ("todo", 0.3), ("review_test", 0.15), ("done", 0.15)])
    return weighted_choice([("backlog", 0.4), ("todo", 0.6)])


def random_datetime_in(day: datetime) -> datetime:
    """해당 날짜에 업무 시간대(09~18시) 랜덤 시각."""
    return day.replace(hour=random.randint(9, 18), minute=random.choice([0, 15, 30, 45]),
                       second=0, microsecond=0)


def build_items(today: datetime, days_back: int, days_ahead: int, per_assignee: int, clusters):
    items = []
    start_day = (today - timedelta(days=days_back)).replace(hour=0, minute=0, second=0, microsecond=0)
    span = days_back + days_ahead

    for idx, person in enumerate(ASSIGNEES):
        name = person["name"]
        # 각 담당자에게 today/overdue 가 최소 1건씩 보장되도록 강제 날짜 일부 포함.
        forced_offsets = [days_back, days_back - random.randint(2, 5)]  # 오늘, 과거(지연 후보)
        for i in range(per_assignee):
            if i < len(forced_offsets):
                off = forced_offsets[i]
            else:
                off = random.randint(0, span)
            day = start_day + timedelta(days=off)
            started = random_datetime_in(day)

            wtype = weighted_choice(TYPE_WEIGHTS)
            service = random.choice(SERVICES)
            category = random.choice(CATEGORIES)
            status = pick_status(started, today)
            # 강제 과거건은 미완료로 둬서 '지연' 버킷에 보이게.
            if i == 1 and started.date() < today.date():
                status = random.choice(["todo", "in_progress"])

            # 협업자(secondary) 30% 확률로 다른 담당자.
            secondary = None
            if random.random() < 0.3:
                other = ASSIGNEES[(idx + random.randint(1, len(ASSIGNEES) - 1)) % len(ASSIGNEES)]["name"]
                secondary = other

            cl = random.choice(clusters) if clusters and random.random() < 0.7 else None
            done = status == "done"
            title = make_title(wtype, service, category)

            items.append(WorkItem(
                id=uuid.uuid4(),
                type=wtype,
                assignee=name,
                primary_assignee=name,
                secondary_assignee=secondary,
                cluster_id=(cl.id if cl else None),
                cluster_name=(cl.name if cl else None),
                title=title,
                category=category,
                content=f"{title} — 샘플 업무 내용입니다. ({category} / {service})",
                resolution=("처리 완료: 정상 확인" if done else None),
                started_at=started,
                closed_at=(started + timedelta(hours=random.randint(1, 6)) if done else None),
                priority=random.choice(PRIORITIES),
                kanban_status=status,
                type_label=random.choice(TYPE_LABELS) if wtype in ("task", "issue") else None,
                service=service,
                effort_hours=random.choice([1, 2, 4, 8, None]),
                remarks=("긴급" if random.random() < 0.15 else None),
                created_by=SEED_MARKER,
            ))
    return items


def main():
    ap = argparse.ArgumentParser(description="로컬 테스트용 샘플 데이터 시드")
    ap.add_argument("--reset", action="store_true", help="기존 시드 데이터 삭제 후 재생성")
    ap.add_argument("--per-assignee", type=int, default=14, help="담당자 1명당 업무 수 (기본 14)")
    ap.add_argument("--days-back", type=int, default=28, help="과거 며칠부터 (기본 28)")
    ap.add_argument("--days-ahead", type=int, default=7, help="미래 며칠까지 (기본 7)")
    ap.add_argument("--keep-assignees", action="store_true", help="담당자 목록은 변경하지 않음")
    ap.add_argument("--seed", type=int, default=None, help="난수 시드(재현용)")
    args = ap.parse_args()

    if args.seed is not None:
        random.seed(args.seed)

    db = SessionLocal()
    try:
        # 1) 담당자(app_settings) upsert
        if not args.keep_assignees:
            setting = db.query(AppSetting).filter(AppSetting.key == "assignees").first()
            if setting is None:
                setting = AppSetting(key="assignees", value=ASSIGNEES)
                db.add(setting)
            else:
                setting.value = ASSIGNEES
            db.commit()
            print(f"[seed] 담당자 {len(ASSIGNEES)}명 등록 (app_settings.assignees)")

        # 2) 기존 시드 정리(옵션)
        if args.reset:
            n = db.query(WorkItem).filter(WorkItem.created_by == SEED_MARKER).delete(synchronize_session=False)
            db.commit()
            print(f"[seed] 기존 시드 업무 {n}건 삭제 (created_by={SEED_MARKER})")

        # 3) 클러스터 조회(있으면 일부 업무에 연결)
        clusters = db.query(Cluster).all()
        if clusters:
            print(f"[seed] 클러스터 {len(clusters)}개 발견 → 일부 업무에 연결")
        else:
            print("[seed] 등록된 클러스터 없음 → 업무 cluster 는 비워둠")

        # 4) 업무 생성
        today = datetime.now().replace(microsecond=0)
        items = build_items(today, args.days_back, args.days_ahead, args.per_assignee, clusters)
        db.add_all(items)
        db.commit()

        # 5) 요약 출력
        by_status = {}
        by_type = {}
        for it in items:
            by_status[it.kanban_status] = by_status.get(it.kanban_status, 0) + 1
            by_type[it.type] = by_type.get(it.type, 0) + 1
        print(f"[seed] 업무 {len(items)}건 생성 "
              f"(기간 {args.days_back}일 전 ~ {args.days_ahead}일 후, 담당자 {len(ASSIGNEES)}명)")
        print(f"       상태별: {by_status}")
        print(f"       종류별: {by_type}")
        print("[seed] 완료 — 대시보드/담당자별 진행현황에서 확인하세요. (정리: --reset)")
    finally:
        db.close()


if __name__ == "__main__":
    main()
