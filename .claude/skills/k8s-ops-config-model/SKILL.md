---
name: k8s-ops-config-model
description: 컴포넌트(kubelet·containerd·apiserver·애드온·앱) 설정을 화면에서 보고 고치고 노드에 반영하는 기능을 만들 때 사용. Cloudera cm_api 의 ApiConfig(view=summary|full, default·required·sensitive·validationState·relatedName), 서비스 + 역할 타입별 설정, role config group(그룹 단위 재정의), configStale/configStalenessStatus(FRESH·STALE_REFRESHABLE·STALE), None=재정의 삭제 의미론을 K8s 설정 관리로 옮긴다.
---

# Config model (cm_api `ApiConfig` / role config group / staleness 차용)

> 레퍼런스 구현: [`reference.py`](reference.py) — `effective`(계층 해석) / `view`(summary|full) /
> `apply_update`(None=삭제) / `staleness`. 분석 배경: `docs/03-analysis/cm-api-borrow-analysis.md` §3.

## 원본에서 가져오는 것
| cm_api | 의미 | K8s 적용 |
|---|---|---|
| `get_config(view=None)` → `{name: value}` | **summary**: 명시 설정된 값만 | 변경점만 보기 / export / diff |
| `get_config(view='full')` → `ApiConfig` | **full**: default·required·displayName·description·relatedName·sensitive·validationState/Message | 편집 폼의 원천(라벨·도움말·검증 메시지) |
| `update_config(svc_config, **rt_configs)` | 서비스 공통 + 역할 타입별 설정을 한 번에 | 컴포넌트 공통 + 노드 역할별 |
| role config group (`role_config_groups.py`) | 같은 설정을 공유하는 역할 묶음 | 노드 그룹(라벨/glob, **처음 일치 하나**) |
| role 단위 설정 | 인스턴스 재정의 | 노드 1대 재정의 |
| 값 `None` 으로 update | 재정의 삭제 → 상위/기본값 복귀 | "기본값으로 되돌리기" 버튼 |
| `sensitive` | 응답 마스킹 | 토큰·비밀번호 마스킹, 백업 `SENSITIVE_COLUMNS` |
| `configStale` / `configStalenessStatus` | 원하는 설정 ≠ 적용된 설정 | DB(desired) vs 노드 관측(applied) 비교, 재시작 필요 여부로 2단계 |
| `relatedName` | UI 이름과 실제 키 분리 | 화면 라벨 ↔ 실제 플래그/파일 키(`--max-pods`, `config.toml` 경로) |

## 규칙
1. 값 해석 순서 고정: **기본값 ← 서비스 ← 그룹(처음 일치 하나) ← 인스턴스**. full view 는 값마다 `source` 를 보여준다.
2. 키 메타데이터(`ParamSpec`)는 **DB 행**으로 두고 화면에서 편집 가능하게(UI-First). 코드는 시드만.
3. summary view 는 "기본값이 아닌 것"만 — diff/백업/템플릿 export 의 기준 포맷.
4. sensitive 값은 API 응답에서 항상 마스킹, 업데이트 시 마스크 문자열이 오면 "변경 없음"으로 취급.
5. 검증은 저장 시 서버에서(`validationState` ERROR 면 저장 거부, WARNING 은 저장 + 표시).
6. 적용 후 노드에서 다시 수집해 staleness 를 계산한다. STALE(재시작 필요) 대상은
   `k8s-ops-rolling-ops` 의 `stale_only=True` 롤링으로 처리.
7. 적용 이력은 버전 단위로 남긴다(imported/saved/applied) → 롤백 가능.

## PEP 적용 지점
- `service_config` 도메인(`models/service_config.py`: `ServiceConfigItem`/`Rule`/`Group`/`Version`/`ApplyRun`)이 이미
  이 구조에 가깝다: Group=role config group, Version=설정 버전. **staleness 3단계와 summary/full view,
  None=재정의 삭제 의미론**이 보강 후보.
- 현재 노드 값은 `config_snapshot` 에서 읽는다 → `staleness(desired, applied)` 의 applied 입력.

## 체크리스트
- [ ] 키 메타데이터(label/help/default/required/sensitive/restart_required/related_name)가 DB 에 있고 화면 편집 가능
- [ ] summary / full 두 view 제공, full 은 값별 출처 표시
- [ ] "기본값으로" = None 업데이트
- [ ] 저장 시 서버 검증, 마스킹 일관
- [ ] 적용 후 재수집 → FRESH / STALE_REFRESHABLE / STALE 배지, STALE 대상 롤링 재시작 진입점
