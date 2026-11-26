"""Cilium 데이터패스(eBPF) — Rust 노드 에이전트 보고 처리·맵 사용률 판정·수동 수집 실행.

- ``settings`` : AppSetting ``cilium_datapath.settings`` (임계치·주기·시간 예산·권한 — UI-First)
- ``catalog``  : 맵 그룹 → 화면 라벨·cilium-config 키(설정 추천)
- ``service``  : 에이전트 보고 처리(upsert·알람)·화면 조회 모델
- ``runs``     : 「지금 수집」 실행 — 작업 전달(long-poll)·로그 수신·완료 판정
- ``manifest`` : 에이전트 설치 매니페스트(DaemonSet) 렌더링
"""
