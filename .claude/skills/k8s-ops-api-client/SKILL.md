---
name: k8s-ops-api-client
description: K8s(또는 외부 관리 API) 클라이언트 계층을 설계·리팩터링할 때 사용. KM(K8s Manager) 클라이언트 계층 패턴 — 리소스 경로 객체(경로만 정의하면 동사 메서드 제공), 읽기/쓰기 속성 구분(읽기 전용 필드 직렬화 제외), GET 타임아웃만 재시도, JSON 오류 본문 정규화, 최소 API 버전 게이트, 일괄 실행(하나 실패 시 전체 롤백)을 적용한다.
---

# API client layer (KM 클라이언트 계층)

> 레퍼런스 구현: [`reference.py`](reference.py) — `ApiError.from_response` / `retry_idempotent` / `requires` /
> `ro()`·`to_payload`·`from_dict` / `run_batch`(보상 롤백). 분석 배경: `docs/03-analysis/km-borrow-analysis.md` §8.

## KM 패턴
| KM 개념 | 의미 | K8s 적용 |
|---|---|---|
| 리소스 GET 재시도 — **GET + timeout 일 때만** | 변경 요청은 자동 재시도하지 않음 | 중복 생성·이중 적용 방지. 429/503/504 + 타임아웃만, 지수 백오프 |
| 오류 정규화 — 본문 JSON 의 `message` 추출 | 사람이 읽는 오류 | K8s `Status.message`/`reason` → 화면에 그대로. **빈 500 금지** |
| 읽기/쓰기 속성 vs 읽기 전용 속성 | 서버 계산 필드는 쓰기 payload 에서 제외 | `status`, `metadata.resourceVersion` 등 RO 필드 보호 |
| 역직렬화 시 미지 필드 무시 | 서버 버전 차이에 관대 | 신버전 K8s 필드가 와도 깨지지 않음 |
| 최소 API 버전 확인 | 호출 전 버전 게이트 | 대상 K8s minor 가 기능 지원하는지(예: 1.29+ 사이드카) 호출 전에 명확한 오류 |
| 리소스 객체는 `_path()` 만 정의 + 공통 `_get/_post/_cmd` | 리소스 경로만 정의 | 새 리소스 래퍼 추가 비용 최소화 |
| 일괄 실행 — 하나 실패 시 전체 롤백 | 다중 변경 원자성 | K8s 엔 트랜잭션이 없으므로 **보상 트랜잭션**(undo) 으로 |

## 규칙
1. 자동 재시도는 멱등 조회에만. 변경은 실패를 그대로 올리고 사용자가 재시도(명령 retry).
2. 외부 호출 오류는 `ApiError(status, message)` 로 정규화 → 라우터는 `HTTPException(status, detail=message)`.
   외부 서비스(Prometheus 등) 호출은 예외 대신 offline dict(fail-safe 규칙) — 둘을 섞지 않는다.
3. 쓰기 payload 는 `to_payload`(RO·None 제외)로만 만든다. 서버 응답 dict 를 그대로 되돌려 보내지 않는다.
4. 버전 의존 기능은 `@requires((major, minor))` 로 게이트, UI 에는 미지원 사유를 표시.
5. 다중 변경은 `run_batch` — 각 요소에 undo 를 정의하고, undo 불가 요소는 결과에 `rollback_unsupported` 로 드러낸다.
   batch 결과 리스트를 그대로 실행 로그에 남긴다.

## PEP 적용 지점
- 클라이언트 풀·동시성: `services/k8s_client_pool.py`, `services/k8s_concurrency.py`, 목록 캐시 `k8s_list_cache.py`,
  페이지 조회 `k8s_paging.py`(apiserver 보호 — `docs/K8S_APISERVER_PROTECTION.md`). 재시도 정책을 여기에 일원화.
- raw 호출: `services/k8s_raw.py` — `ApiError.from_response` 정규화 적용 후보.
- 다중 리소스 적용: `ns_migration`, `k8s_rbac_service`(SA·Role·Binding 한 묶음) — 보상 배치 적용 후보.

## 체크리스트
- [ ] 재시도 = 조회 + (타임아웃|429|503|504) 만
- [ ] 오류 메시지 정규화, 빈 500 없음
- [ ] RO 필드 쓰기 제외, 미지 필드 관대
- [ ] 버전 게이트 + UI 사유
- [ ] 다중 변경 보상 배치 + 결과 로그
