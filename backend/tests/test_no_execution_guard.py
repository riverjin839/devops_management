"""무실행(No-Execution) 보증 회귀 테스트 — AST import 그래프 검사.

원칙 (docs/AIRGAP_LLM_ARCHITECTURE.md §0-2): LLM 파이프라인은 분석 전용이다.
LLM 계열 모듈이 실행 계열(kubectl exec/SSH/플레이북/일괄 실행)을 import 하거나
그 반대가 되면, LLM 출력이 실행 경로에 연결될 구조적 가능성이 생긴다 — 이
테스트가 그 배선을 CI 에서 기계적으로 차단한다.

새 모듈이 정당하게 양쪽을 이어야 한다면(그럴 일은 없어야 한다) 이 테스트를
고치기 전에 설계 리뷰부터 받아라.
"""
import ast
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent / "app"

# LLM 계열 — 분석/생성만 한다. 실행 모듈을 절대 import 하면 안 된다.
LLM_MODULES = [
    "services/llm",                      # 게이트웨이 패키지 전체
    "services/analyzers",                # 장애 분석기
    "services/rag_service.py",
    "services/agent_service.py",
    "services/incident_context_builder.py",
    "services/embedding_service.py",
    "services/review_service.py",
    "services/observability/analysis_hook.py",
]

# 실행 계열 — 클러스터/노드에 변경을 가할 수 있는 경로.
EXECUTION_MODULE_NAMES = {
    "app.services.ssh_runner",
    "app.services.ssh_pty",
    "app.services.playbook_executor",
    "app.services.kubectl_exec",
    "app.services.batch_job_service",
    "app.services.tcpdump_runner",
    "app.routers.k8s_exec",
    "app.routers.k9s_ssh",
    "app.routers.node_ssh",
    "app.routers.bulk_exec",
    "app.routers.etcdctl",
    "app.routers.mc_client",
    "app.routers.playbooks",
}

LLM_MODULE_NAMES = {
    "app.services.llm",
    "app.services.analyzers",
    "app.services.rag_service",
    "app.services.agent_service",
    "app.services.incident_context_builder",
}


def _iter_py_files(rel: str):
    path = APP_DIR / rel
    if path.is_dir():
        yield from path.rglob("*.py")
    elif path.exists():
        yield path


def _imports_of(py_file: Path) -> set[str]:
    tree = ast.parse(py_file.read_text(encoding="utf-8"))
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                found.add(alias.name)
        elif isinstance(node, ast.ImportFrom) and node.module:
            found.add(node.module)
    return found


def _hits(imports: set[str], forbidden: set[str]) -> list[str]:
    out = []
    for imp in imports:
        for f in forbidden:
            if imp == f or imp.startswith(f + "."):
                out.append(imp)
    return out


def test_llm_modules_never_import_execution_modules():
    violations: list[str] = []
    for rel in LLM_MODULES:
        for py in _iter_py_files(rel):
            hits = _hits(_imports_of(py), EXECUTION_MODULE_NAMES)
            if hits:
                violations.append(f"{py.relative_to(APP_DIR)} → {hits}")
    assert not violations, (
        "LLM 계열 모듈이 실행 모듈을 import 합니다 (무실행 보증 위반):\n"
        + "\n".join(violations)
    )


def test_execution_modules_never_import_llm_modules():
    violations: list[str] = []
    for name in EXECUTION_MODULE_NAMES:
        rel = name.replace("app.", "").replace(".", "/")
        for candidate in (APP_DIR / f"{rel}.py", APP_DIR / rel):
            for py in ([candidate] if candidate.is_file() else candidate.rglob("*.py") if candidate.is_dir() else []):
                hits = _hits(_imports_of(py), LLM_MODULE_NAMES)
                if hits:
                    violations.append(f"{py.relative_to(APP_DIR)} → {hits}")
    assert not violations, (
        "실행 모듈이 LLM 모듈을 import 합니다 (무실행 보증 위반):\n"
        + "\n".join(violations)
    )


def test_analysis_result_has_no_executable_fields():
    """분석 결과 스키마 계약 — 실행성 필드(command/execute/run/apply)가 생기면 실패."""
    from dataclasses import fields
    from app.services.analyzers.base import AnalysisResult

    names = {f.name for f in fields(AnalysisResult)}
    forbidden = {"command", "commands", "execute", "run", "apply", "script", "playbook"}
    assert not (names & forbidden), f"AnalysisResult 에 실행성 필드가 있습니다: {names & forbidden}"
    assert names == {
        "severity", "root_cause", "suggested_actions", "confidence",
        "analyzed_by", "analyzed_at", "related_runbooks", "citations",
    }, "AnalysisResult 필드가 변경됐습니다 — 무실행 계약을 확인하고 이 테스트를 갱신하세요."
