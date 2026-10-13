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
| **운영 DB 를 가리킨 pytest** | `tests/conftest.py` 가 `DATABASE_URL` 을 `setdefault` 로만 넣어, 이미 설정된 환경(운영 DB 접속 정보가 셸 env 에 있는 개발 PC, backend 파드 `kubectl exec`)에서는 그 DB 를 그대로 쓴다. 이관 테스트 3종의 cleanup 이 sentinel 을 **삭제**한다. `Jenkinsfile` 의 Backend Test 단계도 의심했지만, `requirements.txt` 에 pytest 가 없어 그 venv 에서는 테스트가 실제로 돌지 못했을 가능성이 높다 — 실제 경로는 운영 환경 로그로 확인해야 한다. |
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

## 3. P1 — 후속 PR 에서 처리한 것

| # | 과제 | 처리 |
|---|---|---|
| 1 | 전체 목록 PUT → 원자적 연산 | `installed_apps_add` / `installed_apps_remove` 델타 연산 + 라우터가 `SELECT … FOR UPDATE` 행 잠금 아래에서 읽기-수정-쓰기. 첫 INSERT 경합은 유니크 위반 시 1회 재시도. 화면(사이드바·상단바)은 델타만 보낸다. |
| 2 | Jenkins Backend Test | `TEST_DATABASE_URL` 이 있을 때만 그 DB 로 돌고(conftest 가드로 이름에 `test` 필수), 실패하면 파이프라인을 멈춘다. 미설정이면 명시적으로 SKIP. pytest 를 명시 설치한다. |
| 3 | 사용자 삭제 시 설정 정리 | `DELETE /auth/users/{id}` 가 `user_settings` 행도 지우고 지운 개수를 감사 로그 details 에 남긴다. |
| 4 | 이관 감사 | `_migrate_home_prefs_layout()` 가 목록을 바꾼 행마다 `home_prefs.layout_migrate`(actor `system`, before/added/removed)를 남긴다. 버전만 찍은 행은 기록하지 않는다. |
| 5 | 기본값 따름 vs 사용자 지정 | `installed_apps: null` = 조직 기본값 따름, 리스트 = 사용자 지정. 조직 기본값은 `app_settings.home_prefs_defaults`(admin, Settings → 화면 UI 설정 → "기본 앱 구성", 변경 감사). 응답에 `installed_apps_customized` 를 실어 화면이 구분한다. |
| 6 | 기본값으로 초기화 | "앱 추가" 창 하단 버튼(두 번 눌러 확인) → `installed_apps_reset`. |

기존 계정은 전부 "사용자 지정"으로 남는다 — 지금 목록이 내장 기본값과 같아도 일부러 고른 것인지
구분할 수 없어서, 이관으로 "기본값 따름"으로 바꾸지 않았다(사용자 선택을 바꾸지 않는 원칙). 조직
기본값을 따르게 하려면 각자 초기화하면 된다.

## 4. P2 — 후속 PR 에서 처리한 것

| # | 과제 | 처리 |
|---|---|---|
| 7 | 로컬 개인 설정이 계정 간에 섞임 | 40여 호출부를 고치는 대신 로그인 시점에 바꿔 끼운다(`lib/personalStorage.ts`). `pep:profile-owner` 가 지금 깔린 개인 키의 주인이고, 다른 계정이 로그인하면 현재 키를 `pep:profile:{주인}` 으로 보관·삭제한 뒤 로그인한 계정의 보관본을 풀고 새로 고친다. 기기 설정(로그인 토큰, 키에 `width` 가 든 폭 값)은 대상 아님. 보관이 quota 로 실패하면 아무것도 지우지 않는다. 첫 로그인(주인 없음)은 현재 값을 그 계정 것으로 인정해 혼자 쓰던 브라우저에서 설정이 사라지지 않는다. 덤으로 로그아웃·세션 만료 시 탭에 기억된 플레이북 SSH 자격증명(sessionStorage)을 지운다 — 대시보드가 캐시된 자격증명으로 바로 실행하므로 다음 사람이 이전 사람 권한으로 실행할 수 있었다. |
| 8 | 개인 설정 내보내기/가져오기 | 사용자 메뉴에서 JSON 파일로. 서버 몫은 허용 키(`home_prefs`, `terminal_appearance`, `jira_provision_preset`)만, 각 기능의 정규화 함수를 거쳐 저장. `mc_presets`(비밀번호 포함)·Jira 자격증명은 제외. 브라우저 몫은 개인 키 스냅샷. 문서는 JSON 문자열로 감싸 주고받는다(axios 키 자동 변환이 값 안의 키를 바꾸지 못하게). 가져오기는 감사 로그. |
| 9 | 순서 변경 | "앱 추가" 창 상단 드래그 정렬(키보드 지원). 저장은 한 항목 이동 델타라 동시 편집에 안전. |

### 남은 한계

- 보관된 다른 계정의 로컬 설정(`pep:profile:*`)은 그 브라우저에 남는다 — 공용 PC 에서 민감 정보는 아니지만, 계정 삭제 시
  자동으로 지워지지는 않는다.
- 테마·강조색은 서버 저장으로 올렸다(아래 §4-1). 나머지 브라우저 개인 설정(그룹 접힘·화면별 보기 모드 등)은 계정별로
  분리되지만 기기별이다 — 다른 PC 로는 내보내기/가져오기로 옮긴다.

### 4-1. 테마·강조색 서버 저장 (후속)

- `home_prefs.theme`/`accent` 가 원천, localStorage 는 첫 화면 캐시. `hooks/useThemeSync` 가 서버 → 화면 적용,
  화면에서 **바꾼 순간**만 서버 저장. 서버가 비어 있으면(이 기능 이전 계정) 로그인 직후 지금 값을 한 번 올린다.
- 서버는 테마 id 모양만 검사한다(테마 추가 때 서버 배포 불필요). 이 앱이 모르는 테마 id 가 서버에 있으면(더 새 버전이
  저장) 적용하지도 덮어쓰지도 않는다. 저장된 값이 깨져 있으면 그 둘만 버리고 나머지 설정은 정상으로 읽는다.
- 브라우저 확인: 기기 A 에서 테마를 바꾸면 서버에 저장되고, 빈 브라우저(기기 B)로 로그인하면 같은 테마가 적용·유지된다
  (Playwright 로 확인).

## 5. 앞으로 레이아웃을 바꿀 때의 규칙

- `HOME_PREFS_LAYOUT_VERSION` 을 올리고 `_migrate_home_prefs_layout()` 에 "이전 버전 → 새 모양" 변환을 **추가 전용**으로 넣는다.
- 사용자가 고른 항목을 빼는 이관은 쓰지 않는다. 노출을 줄여야 하면 조직 기본값(Settings → 기본 앱 구성)만 바꾼다 — 기본값을 따르는 계정에만 반영된다.
- 개인 데이터 이관의 "실행 여부" 표식을 전역 테이블에 두지 않는다 — 표식은 그 데이터 행에 둔다.
