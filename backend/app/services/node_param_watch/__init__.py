"""노드 OS(커널) 파라미터 감시 — 에이전트 보고 처리·규칙 판정·설정·설치 매니페스트.

- ``rules``    : DB 없는 판정 로직(순수 함수)
- ``service``  : 보고 처리·상태 조회·무응답 워치독·기본 규칙 시드
- ``settings`` : AppSetting ``node_param_watch.settings``
- ``manifest`` : 에이전트 DaemonSet 설치 매니페스트 렌더링
"""
