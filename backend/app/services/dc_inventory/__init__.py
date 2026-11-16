"""DC 인벤토리 서비스 패키지 — 설계는 ``docs/dc-inventory/DESIGN.md``.

- ``crud``            리소스 공통 생성·수정·삭제(제약 검증 + 변경 이력, 커밋은 호출자)
- ``validation``      U 겹침 · 케이블 중복 · IP ∈ Prefix 등 제약 검증
- ``changelog``       ``dc_change_logs`` 기록
- ``device_registry`` 서버 단일 원본 — 노드 서버스펙·인프라 토폴로지와의 연결·미러
- ``bulk``            화면 안 일괄 작업
- ``importer`` / ``exporter``  Excel·CSV 일괄 등록과 내보내기
"""
