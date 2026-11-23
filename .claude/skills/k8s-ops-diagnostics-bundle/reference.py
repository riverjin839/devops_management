"""Diagnostics bundle — cm_api `collect_diagnostic_data_45` + 역할 단위 진단 명령(lsof/jstack/jmap) 패턴.

원본: cms.py `collect_diagnostic_data_45(end_datetime, bundle_size_bytes, cluster_name, roles,
collect_metrics, start_datetime)` — start 가 있으면 [start,end] 전부(크기 초과 시 실패),
없으면 end 부터 *거꾸로* bundle_size 까지 채운다. services.py `lsof/jstack/jmap_histo/jmap_dump(*roles)`,
services.py `create_yarn_application_diagnostics_bundle(ticket_number, comments)`.

K8s 매핑: 지원 번들 = 이벤트·describe·파드 로그(--since-time)·노드 컨디션·메트릭 스냅샷을 시간창/크기 예산으로.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime

# 우선순위 낮은 숫자 = 먼저 담는다. 예산이 모자라면 뒤쪽 항목부터 잘린다.
PRIORITY = {"manifest": 0, "events": 1, "describe": 2, "node_conditions": 3, "logs_error": 4,
            "logs_previous": 5, "logs": 6, "metrics": 7}

REDACT_PATTERNS = [
    re.compile(r"(?i)(password|passwd|secret|token|api[_-]?key)(\s*[:=]\s*)(\"?)[^\s\",]+"),
    re.compile(r"(?i)(authorization:\s*bearer\s+)[A-Za-z0-9._\-]+"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----"),
]


def redact(text: str) -> str:
    text = REDACT_PATTERNS[0].sub(lambda m: f"{m.group(1)}{m.group(2)}{m.group(3)}***", text)
    text = REDACT_PATTERNS[1].sub(lambda m: f"{m.group(1)}***", text)
    return REDACT_PATTERNS[2].sub("***PRIVATE KEY REDACTED***", text)


@dataclass
class BundleRequest:
    cluster: str
    end: datetime
    size_budget_bytes: int
    start: datetime | None = None  # None → end 부터 거꾸로 예산까지
    namespaces: list[str] = field(default_factory=list)  # CM roles 제한에 해당 — 비면 전체
    targets: list[str] = field(default_factory=list)  # "ns/pod" 혹은 "node/<name>"
    include_metrics: bool = False
    ticket: str = ""
    comment: str = ""


@dataclass
class Item:
    kind: str  # PRIORITY 키
    path: str  # 번들 내 경로
    content: str
    ts: datetime | None = None  # 로그 라인 등 시간 정렬용


class BudgetExceeded(Exception):
    pass


def assemble(req: BundleRequest, items: list[Item]) -> tuple[dict[str, str], dict]:
    """항목을 우선순위·최신순으로 예산 안에 담는다. 반환: (파일맵, manifest)."""
    if req.start:
        items = [i for i in items if i.ts is None or req.start <= i.ts <= req.end]
    else:
        items = [i for i in items if i.ts is None or i.ts <= req.end]
    items = [Item(i.kind, i.path, redact(i.content), i.ts) for i in items]
    total = sum(len(i.content.encode()) for i in items)
    if req.start and total > req.size_budget_bytes:
        # CM 의미론: 기간을 명시했으면 잘라서 거짓 완결을 만들지 않고 실패시킨다
        raise BudgetExceeded(f"{total} bytes > budget {req.size_budget_bytes}; 기간을 줄이거나 예산을 늘릴 것")
    ordered = sorted(items, key=lambda i: (PRIORITY.get(i.kind, 99), -(i.ts.timestamp() if i.ts else 0)))
    files: dict[str, str] = {}
    used, dropped = 0, []
    for it in ordered:
        size = len(it.content.encode())
        if used + size > req.size_budget_bytes:
            dropped.append({"path": it.path, "kind": it.kind, "bytes": size})
            continue
        files[it.path] = files.get(it.path, "") + it.content
        used += size
    manifest = {
        "cluster": req.cluster, "start": req.start.isoformat() if req.start else None,
        "end": req.end.isoformat(), "budget": req.size_budget_bytes, "used": used,
        "namespaces": req.namespaces, "targets": req.targets, "ticket": req.ticket, "comment": req.comment,
        "files": sorted(files), "dropped": dropped, "redacted": True,
    }
    files["manifest.json"] = json.dumps(manifest, ensure_ascii=False, indent=2)
    return files, manifest


# ── 대상 단위 진단 명령 카탈로그 (CM lsof/jstack/jmap → kubectl exec/debug). 전부 읽기 전용 ──
DIAG_COMMANDS = {
    "open_files": {"label": "열린 파일(lsof)", "argv": ["ls", "-l", "/proc/1/fd"], "runtime": "any"},
    "thread_dump": {"label": "스레드 덤프(jstack)", "argv": ["jcmd", "1", "Thread.print"], "runtime": "jvm"},
    "heap_histo": {"label": "힙 히스토그램(jmap -histo)", "argv": ["jcmd", "1", "GC.class_histogram"], "runtime": "jvm"},
    "goroutines": {"label": "고루틴 덤프", "argv": ["wget", "-qO-", "http://127.0.0.1:6060/debug/pprof/goroutine?debug=2"], "runtime": "go"},
    "net_conns": {"label": "소켓 상태(ss)", "argv": ["ss", "-tanp"], "runtime": "any"},
}


def diag_argv(namespace: str, pod: str, command: str, container: str = "", use_debug: bool = False,
              debug_image: str = "busybox") -> list[str]:
    """kubectl 인자 목록(셸 문자열 금지 — 주입 방지). distroless 는 ephemeral debug 컨테이너로."""
    spec = DIAG_COMMANDS[command]
    if use_debug:
        base = ["kubectl", "debug", "-n", namespace, pod, f"--image={debug_image}", "--profile=general"]
        if container:
            base.append(f"--target={container}")
        return base + ["--", *spec["argv"]]
    base = ["kubectl", "exec", "-n", namespace, pod]
    if container:
        base += ["-c", container]
    return base + ["--", *spec["argv"]]
