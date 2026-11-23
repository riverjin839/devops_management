---
name: k8s-ops-staged-rollout
description: 애드온·이미지·바이너리 새 버전을 "받기 → 노드에 미리 뿌리기 → 전환(활성화)" 단계로 나눠 배포하는 기능을 만들 때 사용(특히 폐쇄망). KM(K8s Manager) 패키지 라이프사이클(AVAILABLE_REMOTELY→DOWNLOADING→DOWNLOADED→DISTRIBUTING→DISTRIBUTED→ACTIVATED, 단계별 cancel/remove, progress·count/totalCount·warnings·errors) 상태 기계를 적용한다.
---

# Staged rollout (KM 패키지 라이프사이클)

> 레퍼런스 구현: [`reference.py`](reference.py) — `Stage`/`ACTIONS` 상태 기계, `begin`/`report`/`complete`/`fail`,
> `allowed_actions()`. 분석 배경: `docs/03-analysis/km-borrow-analysis.md` §6.

## KM 패턴
| KM 패키지 동작 | 의미 | K8s 적용 |
|---|---|---|
| `stage` + 허용 동작 | 지금 가능한 버튼만 활성 | `allowed_actions()` 로 버튼 enable |
| `start_download` / `cancel_download` / `remove_download` | 중앙 저장소로 받기 | 번들 → 내부 레지스트리 push(Harbor/Nexus) |
| `start_distribution` / `cancel_distribution` / `start_removal_of_distribution` | 모든 노드에 미리 배포 | pre-pull DaemonSet / `crictl pull` — 서비스 영향 0 |
| `activate` / `deactivate` | 버전 전환(같은 제품은 하나만 활성) | 이미지 태그 전환·Helm upgrade(→ `k8s-ops-rolling-ops`), 되돌리기 빠름 |
| `state{progress,totalProgress,count,totalCount,warnings,errors}` | 단계 진행률 | 노드 완료 수/전체, 바이트 진행률 |

## 규칙
1. 단계마다 독립 명령(`k8s-ops-command-tracking`) — 취소·재시도·실시간 로그가 단계 단위.
2. 전환 전 단계(받기·뿌리기)는 **운영 영향 0** 이어야 한다. 영향이 있는 작업은 activate 로만.
3. 같은 (제품, 클러스터)에서 ACTIVATED 는 하나 — activate 가 기존 활성 버전을 DISTRIBUTED 로 내린다.
4. 분배 완료 기준은 비율(`min_ratio`, UI 설정). 미달 노드는 errors 에 남기고 activate 를 막는다
   (또는 해당 노드를 롤링 대상에서 제외하는 정책을 UI 로 선택).
5. 실패하면 직전 stage 로 되돌려 재시도 가능하게(`fail`).
6. 이전 버전 이미지는 일정 기간 노드에 남겨 deactivate(롤백)를 빠르게 — 정리는 별도 단계.

## PEP 적용 지점
- 노드 이미지 사전 배포: `routers/node_images.py` `POST /distribute`, `services/k8s_node_image_service.py`
  → stage/progress(count/totalCount) 모델을 얹으면 "받기·뿌리기·전환" 화면이 된다.
- 폐쇄망 배포: `scripts/deploy/deploy-airgap.sh` 흐름(이미지 반입 → 레지스트리 push → 배포)이 같은 3단계.
- 버전 현황: `/versions` 화면(`routers/versions.py`).

## 체크리스트
- [ ] 패키지(제품·버전·클러스터)별 stage + progress 저장, 화면은 `allowed_actions()` 로 버튼 제어
- [ ] 단계별 명령·실시간 로그·로그 보기 토글·취소
- [ ] 분배 완료 비율·실패 노드 표시, activate 사전 조건
- [ ] activate = 롤링(배치·헬스 게이트), deactivate = 직전 버전 즉시 복귀
