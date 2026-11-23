# 10. 배치 요청 스케줄 (참고 — PEP 에 이미 있음)

## 원형 (KM)
- `request_schedules` API — `RequestSchedule.batch.requests[]` 를 `order_id` 순서로 실행,
  하나 실패하면 이후 배치 미실행. 롤링 재시작(NodeManager 3대씩 2배치)이 이 위에 있음.

## PEP 대응 (새로 만들지 말 것)
- `services/service_config/apply_nodes.py::_run_batches` — `batch_size`(1~50), `pause`, `stop_on_failure`, 중지
- `batch_jobs`(cron) · `bulk_exec` · Celery 디스패처

## 차이로 보강할 만한 것
- 실패 허용 수(`batch_failure_tolerance`) — KM 롤링 재시작 옵션. 현재는 실패 0 허용(stop_on_failure) 이분법.
- 배치 계획을 저장해 두고 나중에 실행(`starts_at`) — 유지보수 창(04)과 묶기 좋음.
