# 09. 구조화 결과 판정 (Reliable State And Result Checks)

## 원형 (KM)
- KM 작업 규칙 §Reliable State And Result Checks:
  - 로그 메시지·사람용 CLI 출력·키워드·퍼지 문자열로 상태/성공/권한/버전을 추론하지 않는다
  - 권위 있는 API 필드, 타입 있는 결과, 문서화된 상태/오류 코드, 정확한 식별자로 판단
  - 프로세스 exit 0 만으로 업무 작업 완료를 증명하지 않는다 — 결과와 요청/작업 ID 계보 확인
  - 누락·손상·모호·불일치 결과는 성공이 될 수 없다 → 명시적 실패 또는 unresolved 로 보존
  - 테스트는 진단 잡음·누락·오래된 작업 ID 등 실패 경로를 다뤄야 함

## PEP 이식 (관례 → 리뷰 기준)
- kubectl 은 `-o json` 으로 받아 필드 비교. `"Running" in stdout` 류 금지.
- SSH 실행은 exit code + **후속 확인**(예: `systemctl is-active` 가 아니라 `systemctl show -p ActiveState --value`
  정확 비교, etcd 는 `endpoint health -w json` 의 `health` 필드).
- run 상태 enum 에 `unresolved` 를 허용(확인 불가 ≠ 성공). 화면은 중립 아닌 경고색.
- 테스트: 정상 경로 + 잡음 섞인 출력 + 빈 출력 + 다른 run ID 결과 4종.
- 채택 시 CLAUDE.md §Key Conventions 에 한 줄 규칙으로 승격 검토.

## 체크리스트
- [ ] 새 체커/적용 단계에서 판정 근거 필드를 로그에 그대로 출력
- [ ] 문자열 매칭이 불가피하면(레거시 CLI) 주석으로 사유 + 실패 시 unresolved
