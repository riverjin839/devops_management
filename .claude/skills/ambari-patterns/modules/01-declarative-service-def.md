# 01. 선언형 서비스 정의

## 원형 (Ambari)
- `ambari-server/src/main/resources/stacks/BIGTOP/3.2.0/services/<SERVICE>/` — 서비스 1개 = 폴더 1개
  - `metainfo.xml` 컴포넌트·분류(MASTER/SLAVE/CLIENT)·카디널리티(`1+`)·명령 스크립트·타임아웃·커스텀 명령
  - `configuration/*.xml` 설정 타입과 기본값 · `service_advisor.py` 추천/검증
  - `alerts.json` · `telemetry.json` · `role_command_order.json` · `quicklinks/` · `themes/`
- `3.3.0/metainfo.xml` 의 `<extends>3.2.0</extends>` — 바뀐 부분만 덮어쓰는 상속

## 핵심 계약
엔진(Server/Agent)은 서비스 이름을 모른다. 서비스 지식 = 선언 파일. 새 서비스 추가 = 폴더 추가(또는 mpack).

## PEP 이식
- 대응: `services/service_config/catalog_seed.py`(`ServiceConfigItem`·`ServiceConfigRule` 시드) + `apply.py` 의
  `_CMD_KEYS`(서비스별 health/restart 명령) — 이미 "DB 행 + 화면 편집" 이지만 **서비스 메타(분류·카디널리티·
  명령·타임아웃·quicklink)** 는 코드 dict 에 흩어져 있다.
- 이식안: `ServiceDefinition` 개념을 AppSetting(`service_config.definitions`) 또는 테이블로 모은다.
  - 필드: `service`, `components[{name, category, cardinality, health_cmd, restart_cmd, timeout_s}]`,
    `quicklinks[{label, url_template}]`(예: `https://{{node}}:2379/health`), `extends`(기본 정의 키)
  - 값 참조 문법은 Ambari 처럼 `{{config_type/key}}` — 현재 설정 버전 값으로 렌더(코드 eval 금지, 치환만).
- 화면: `/k8s-services` 서비스 레일의 서비스 상세에 "정의" 탭(조회 + operator 편집).

## 체크리스트
- [ ] 시드는 첫 부팅에만 insert, 이후 운영자 편집이 우선 (`_seed_*` 패턴, 덮어쓰기 금지)
- [ ] 상속 해석 결과(실효 정의)를 화면에서 볼 수 있게 — 어떤 값이 어디서 왔는지 출처 표시
- [ ] `check_matrix_runbook.py` 처럼 실제 나가는 명령을 렌더해 미리보기 (UI-First 4번)

## 함정
- 상속 단계가 깊으면 실효 값 추적이 어렵다 → 상속은 1단계(기본 → 클러스터 오버라이드)로 제한.
- 템플릿 치환에 셸 문자가 들어가면 명령 주입 — 값은 `shlex.quote` 후 치환.
