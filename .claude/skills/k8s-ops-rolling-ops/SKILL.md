---
name: k8s-ops-rolling-ops
description: 여러 대상(노드·워크로드·파드)을 순차/배치로 재시작·드레인·업그레이드하는 기능을 만들 때 사용. KM(K8s Manager) 롤링 재시작(마스터 먼저 1대씩 → 워커 배치, 배치 실패 허용치, 배치 간 sleep, stale 설정/미업그레이드 대상만), 노드 빼기/넣기(decommission/recommission), 유지보수 모드 패턴을 K8s 의 rollout restart·cordon/drain·노드 롤링 작업에 적용한다.
---

# Rolling operations (KM 롤링 재시작 / 노드 빼기·넣기)

> 레퍼런스 구현: [`reference.py`](reference.py) — `plan_rolling`(순수 계획) / `execute_rolling`(콜백 주입 실행) /
> `run_steps`(decommission 단계 실행). 분석 배경: `docs/03-analysis/km-borrow-analysis.md` §2.

## KM 패턴
KM 롤링 재시작의 옵션 세트가 그대로 좋은 설계다.

| KM 옵션 | 의미 | K8s 적용 |
|---|---|---|
| (마스터 먼저) | 마스터 역할은 하나씩, 실패 즉시 중단 | control-plane / etcd / 쿼럼 StatefulSet 은 1대씩, 허용치 없음 |
| `worker_batch_size` (>0, 복제 스토리지는 복제 수 미만) | 워커 배치 크기 | 노드 drain 동시 수 — PDB·복제 수·용량 여유보다 작게 |
| `worker_fail_count_threshold` (≥0) | 실패해도 계속 가는 **배치** 수 | 초과 시 STOP, 이하면 "completed with N failed" |
| `sleep_seconds` | 배치 간 대기 | 캐시 워밍·리밸런싱 대기 |
| `stale_configs_only` | 설정이 바뀐 대상만 | `k8s-ops-config-model` 의 staleness 가 STALE 인 대상만 |
| `unupgraded_only` | 아직 새 버전이 아닌 대상만 | 이미지/버전이 목표와 다른 대상만 → **중단 후 재실행이 멱등** |
| `restart_role_types` / `restart_role_names` | 범위 필터 | 노드 역할·이름 필터 |
| 노드 빼기 → 넣기(+시작) | 빼기/넣기 표준 절차 | maintenance ON → cordon → drain → 검증 / uncordon → Ready 확인 → maintenance OFF |
| `enter/exit_maintenance_mode` | 작업 중 알람 억제 | `k8s-ops-health-rollup` 의 `maintenance` 플래그(상태 계산은 유지, 알람만 억제) |

## 규칙
1. **계획과 실행을 분리**한다. `plan_rolling()` 결과(`Plan.describe()`)를 실행 전에 화면에 보여준다(dry-run).
2. 각 대상 처리 후 **헬스 게이트**(Ready / rollout status / 엔드포인트 복귀)를 통과해야 다음으로 간다.
   게이트에는 반드시 타임아웃이 있다.
3. 마스터 실패 = 즉시 중단(허용치 미적용). 워커는 배치 실패 수가 허용치를 넘으면 중단.
4. 배치 사이마다 `checkpoint()` → `k8s-ops-command-tracking` 의 abort 가 먹는다.
5. 유지보수 중 대상은 기본 skip, skip 사유를 결과에 남긴다.
6. 옵션(배치 크기·허용치·sleep·필터)은 **전부 UI 파라미터**(UI-First). 코드 기본값만 두지 않는다.
7. drain 은 eviction API(PDB 준수)만. `--force`/`--disable-eviction` 은 별도 danger 옵션.

## 사용 예
```python
plan = plan_rolling(targets, RollingOptions(batch_size=2, fail_threshold=1, stale_only=True))
for line in plan.describe(): ctx.log(line, step="plan")
result = execute_rolling(plan, opt, restart=drain_and_reboot, healthy=wait_node_ready,
                         log=ctx.log, checkpoint=ctx.checkpoint)
```

## PEP 적용 지점
- 단건 `rollout restart`: `routers/k8s_resources.py`(restartedAt 패치). 여러 워크로드를 묶는 "롤링 재시작" 은 이 스킬로.
- 노드 단위 적용(cordon/drain): `services/service_config/apply_nodes.py` — 배치 크기·실패 허용치·
  stale_only 옵션을 이 패턴으로 노출할 수 있다.
- 실행 결과·단계는 `steps` JSONB(`run_steps` 출력 형식과 동일: id/label/status/detail/duration_ms).

## 체크리스트
- [ ] 계획 미리보기(dry-run) → 확인 → 실행
- [ ] 마스터 1대씩 / 워커 배치 / 실패 허용치 / sleep / stale·미업그레이드 필터가 UI 옵션
- [ ] 대상별 헬스 게이트 + 타임아웃
- [ ] 실시간 로그(배치·대상 단위) + 로그 보기 토글, abort 가능
- [ ] 작업 중 대상 maintenance 표시 → 알람 억제, 종료 시 해제(실패해도 finally 로 해제 여부 기록)
