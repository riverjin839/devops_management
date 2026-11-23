---
name: k8s-ops-templates
description: 노드에 역할 묶음(라벨·테인트·설정 그룹)을 한 번에 입히는 "노드 프로파일", 또는 클러스터 구성을 변수화해 내보내고 다른 클러스터에 재현하는 "클러스터 청사진" 기능을 만들 때 사용. KM(K8s Manager) 노드 템플릿(configGroupRefs + apply(node_ids, start_roles))과 클러스터 템플릿(export / import, variables, hostNameRange, cardinality) 패턴을 적용한다.
---

# Templates (KM 노드 템플릿 / 클러스터 템플릿)

> 레퍼런스 구현: [`reference.py`](reference.py) — `plan_apply_profile`(노드별 diff) / `expand_host_range` /
> `export_template`(값 → 변수 역치환) / `instantiate`(변수·cardinality 검증 후 치환).
> 분석 배경: `docs/03-analysis/km-borrow-analysis.md` §5.

## KM 패턴
| KM 개념 | 의미 | K8s 적용 |
|---|---|---|
| 노드 템플릿 `{name, configGroupRefs}` | 노드에 줄 역할·설정 그룹 묶음 | **NodeProfile**: 라벨·테인트·설정 그룹 참조 |
| 노드 템플릿 `apply(node_ids, start_roles)` → 명령 | 여러 노드에 적용 + 즉시 시작 여부 | 노드 N대에 적용(명령) + "적용 후 uncordon" 옵션 |
| 클러스터 템플릿 `export(auto_config)` | 현재 클러스터를 템플릿으로 | 애드온·NS·정책·프로파일 청사진 export |
| 클러스터 템플릿 `import(template, add_repositories)` | 템플릿으로 새 클러스터 구성 | 다른 클러스터/환경(dev→prod, 폐쇄망)에 재현 |
| 설정 항목 `{value, ref, variable}` + `instantiator.variables` | 인스턴스 고유 값은 **변수** | 레지스트리 주소·도메인·클러스터 이름 |
| `hostNameRange` (`node[01-10]`) | 호스트 범위 표기 | 노드 이름 패턴 |
| 노드 템플릿 `cardinality` | 프로파일당 필요한 노드 수 | 사전 검증(예: etcd 3대) |

## 규칙
1. 적용은 항상 **diff 계획 → 확인 → 명령 실행**(`k8s-ops-command-tracking`). noop 노드는 건너뛴다.
2. 프로파일은 자기가 **소유한 라벨 접두사**(`owned_label_prefix`)만 제거한다. 남의 라벨은 건드리지 않는다.
3. export 는 인스턴스 고유 값을 변수로 바꾸고, summary view(기본값 아닌 것만) 기준으로 내보낸다.
   비밀값은 export 하지 않는다(변수로만).
4. import 는 누락 변수·cardinality 오류를 **모아서 한 번에** 보고하고, 하나라도 있으면 아무것도 적용하지 않는다.
5. import 적용은 여러 리소스 변경이므로 `k8s-ops-api-client` 의 보상 배치(`run_batch`)로.

## PEP 적용 지점
- 노드 라벨: `services/k8s_node_label_service.py`, `routers/node_labels.py` — 라벨 묶음을 프로파일로 저장/적용.
- 설정 그룹: `ServiceConfigGroup`(노드 그룹 glob) — 프로파일의 `config_groups` 참조 대상.
- NS 이전: `ns_migration`(치환 규칙 프리셋)은 청사진 export/instantiate 와 같은 발상 — 변수 치환·검증 로직 공유 후보.

## 체크리스트
- [ ] 프로파일/청사진이 DB 행이고 화면에서 편집 가능
- [ ] 적용 전 노드별 diff 미리보기, noop 표시
- [ ] export 시 변수화·비밀값 제외, import 시 변수/cardinality 일괄 검증
- [ ] 적용은 명령 + 실시간 로그 + 로그 보기 토글
