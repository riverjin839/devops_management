## 개인화 설정 상용화 수준 검토 (2026-10)

배포 후 사이드바 설치 목록이 통째로 다시 채워지는 버그를 고치면서, 사용자 개인화 저장 구조 전체를
상용 SaaS 기준으로 다시 점검했다. 이번 PR 에서 고친 것(P0)과 남은 과제(P1~P2)를 나눠 적는다.

## 1. 버그 — 배포하면 사이드바 셋업이 다 추가된다

### 증상

- 개인화를 한 번도 안 한 계정: 배포 직후 사이드바에 앱 42개가 전부 설치된다.
- 개인화한 계정: 직접 고른 상단바 항목(`/wbs`, 즐겨찾기 등)이 사라진다.

### 근본 원인

`main.py` 부팅 단계의 설치 목록 이관 3종(1단계 그룹 백필 → 2단계 leaf 치환 + grandfather →
3단계 상단바 정리)이 **`app_settings` 의 전역 sentinel 3개**로 "1회만" 실행을 보장했다.
표식(app_settings)과 데이터(user_settings)가 떨어져 있어, 표식만 사라지면 다음 부팅에서
세 단계가 처음부터 다시 돈다.

- 1단계는 home_prefs 행이 **없는** 계정에도 행을 만들어 전 그룹을 넣는다 → 2단계가 leaf 42개로 펼친다.
- 3단계는 **뺄셈**이라 사용자가 고른 상단바 항목까지 지운다.

### 표식이 사라지는 경로

| 경로 | 설명 |
|---|---|
| **운영 DB 를 가리킨 pytest** | `tests/conftest.py` 가 `DATABASE_URL` 을 `setdefault` 로만 넣어, 이미 설정된 환경(backend 파드 `kubectl exec`, 운영 접속 정보가 env 로 있는 Jenkins 에이전트)에서는 그 DB 를 그대로 쓴다. 이관 테스트 3종의 cleanup 이 sentinel 을 **삭제**한다. `Jenkinsfile` 의 Backend Test 단계는 배포 파이프라인 안에서 돌고 실패해도 `|| echo WARNING` 으로 통과한다 — "배포할 때마다" 와 정확히 맞물린다. |
| 구 백업 replace 복원 | sentinel 이 생기기 전 백업을 replace 로 복원하면 app_settings 가 통째로 교체된다. |
| app_settings 수동 정리 | 운영자가 "쓸모없어 보이는" 키를 지우는 경우. |

로컬 PostgreSQL 에서 재현했다: sentinel 삭제 후 부팅 1회 → 미개인화 계정 `installed_apps` 42개,
개인화 계정 `['/k9s','/tasks-mgmt','/wbs']` → `['/k9s','/tasks-mgmt']`.

### 운영 환경 확인 방법

```sql
-- 표식이 없으면 이번 수정 전 버전에서는 다음 부팅에 재실행된다
SELECT key, created_at FROM app_settings WHERE key LIKE 'installed_%';
```

부팅 로그에 `backfilled installed_apps default for N user(s)` / `migrated installed_apps to leaf paths`
가 N>0 으로 **두 번 이상** 찍혔으면 재실행된 것이다.

## 2. 이번 PR 에서 고친 것 (P0)

| 항목 | 내용 |
|---|---|
| 행 단위 버전 이관 | 3종 이관을 `_migrate_home_prefs_layout()` 하나로 대체. 표식은 `home_prefs.layout_version`(행 자체)에 있어 백업·복원과 함께 움직이고, 몇 번을 다시 돌아도 결과가 같다. |
| 뺄셈 금지 | 버전 없는 행은 모양으로만 판정한다. legacy 모양만 변환하고, 이미 leaf 모양이면 목록은 손대지 않고 버전만 찍는다. |
| 행 생성 금지 | home_prefs 행이 없는 계정은 만들지 않는다 — API 기본값(`/tasks-mgmt`)을 쓴다. 부트스트랩 admin 순서 제약도 사라졌다. |
| PUT 버전 위조 방지 | 버전 없는 기존 행을 PUT 해도 최신 버전을 찍지 않는다(이관 전 옛 그룹 id 가 변환 없이 굳는 것 방지). |
| 테스트 DB 가드 | DB 이름에 `test` 가 없으면 pytest 가 수집 전에 중단한다(`PEP_TESTS_ALLOW_NON_TEST_DB=1` 로 명시적 우회). |
| 프론트 덮어쓰기 차단 | 설정 로딩 전·오류 시 `[]` 폴백 상태에서 앱 토글하면 `[id]` 하나로 서버 목록 전체를 덮어쓰던 경로를 막았다. |

## 3. 상용화 관점 남은 과제

### P1 — 데이터 무결성

1. **전체 목록 PUT → 원자적 add/remove 연산.** 지금은 클라이언트가 계산한 배열 전체를 PUT 한다.
   두 기기·두 탭에서 동시에 바꾸면 나중 요청이 앞 요청을 덮는다(lost update). 서버에
   `installed_apps_add` / `installed_apps_remove` 델타 연산을 두거나, 응답에 `revision` 을 실어
   `If-Match` 로 낙관적 잠금을 건다.
2. **Jenkins Backend Test 단계 정리.** 실패해도 통과(`|| echo WARNING`)하고, 테스트 DB 를 명시하지 않는다.
   `DATABASE_URL=...k8s_monitor_test` 를 명시하고 실패 시 파이프라인을 멈춘다. (이번 conftest 가드로
   최소 방어는 됐다.)
3. **사용자 삭제 시 user_settings 정리.** `DELETE /auth/users/{id}` 가 `user_settings` 를 지우지 않는다
   (FK 없음 → 고아 행 누적, 같은 id 재사용 시 남의 설정 상속 가능성). 삭제 시 함께 지우거나 FK `ON DELETE CASCADE`.
4. **이관 이력 감사.** 부팅 이관이 개인 설정을 바꾸면 `audit_logs` 에 행 수·키를 남겨, "왜 내 메뉴가
   바뀌었나" 문의에 근거를 댈 수 있게 한다.

### P1 — 기본값 정책

5. **"사용자 지정" vs "기본값 따름" 구분.** 지금 기본값은 코드 상수(`["/tasks-mgmt"]`)다. 관리자가 조직
   기본 레이아웃을 바꾸려면 배포가 필요하고, 바꿔도 이미 행이 있는 계정엔 적용되지 않는다. 상용 제품은
   보통 `installed_apps: null` = 조직 기본값 따름, 배열 = 사용자 지정으로 구분하고, 조직 기본값은
   `app_settings`(admin UI 편집)에서 읽는다 — UI-First 원칙과도 맞는다.
6. **"기본값으로 초기화" 버튼.** 사용자가 스스로 레이아웃을 리셋할 수단이 없다.

### P2 — 저장 위치 일관성

7. **로컬 전용 개인화의 범위.** 테마(`k8s:theme`)·강조색·사이드바 폭·그룹 접힘 등 40여 개 화면이
   `localStorage` 에 저장한다 — 기기를 바꾸면 사라지고, 공용 PC 에서는 **사용자 간에 섞인다**(키가 사용자
   id 로 네임스페이스돼 있지 않다). 서버 저장(`user_settings`)으로 옮길 것과 기기 로컬로 남길 것(창 폭 등)을
   분류하고, 로컬 키는 `k8s:{userId}:...` 로 네임스페이스한다.
8. **개인 설정 내보내기/가져오기.** 환경 이전(신규 클러스터 배포) 때 개인 설정만 옮길 수단이 없다 —
   현재는 전체 DB 백업뿐이다.
9. **순서 변경(드래그 앤 드롭).** 설치 순서가 곧 표시 순서다. 재정렬 수요가 생기면 배열 순서 보존 방식을 그대로 쓴다.

## 4. 앞으로 레이아웃을 바꿀 때의 규칙

- `HOME_PREFS_LAYOUT_VERSION` 을 올리고 `_migrate_home_prefs_layout()` 에 "이전 버전 → 새 모양" 변환을 **추가 전용**으로 넣는다.
- 사용자가 고른 항목을 빼는 이관은 쓰지 않는다. 노출을 줄여야 하면 기본값(신규·미지정 계정)만 바꾼다.
- 개인 데이터 이관의 "실행 여부" 표식을 전역 테이블에 두지 않는다 — 표식은 그 데이터 행에 둔다.
