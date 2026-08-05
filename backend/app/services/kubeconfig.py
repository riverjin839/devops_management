"""kubeconfig 재구체화 헬퍼.

/tmp 기반 저장소라 컨테이너 재시작 시 파일이 사라지는 이슈를 위해
cluster.kubeconfig_content (DB) 가 있으면 파일을 다시 써주는 한 곳에서
관리. 모든 곳(라우터 / 체커 / 자동업데이트)이 이 함수를 통해 경로를
얻도록 해서 "no such file or directory" 오류를 제거한다.
"""
import os
from uuid import UUID

from app.config import settings


def kubeconfig_store_path(cluster_id: UUID) -> str:
    return os.path.join(settings.kubeconfig_store_dir, f"{cluster_id}.yaml")


def save_kubeconfig_content(cluster_id: UUID, content: str) -> str:
    store_dir = settings.kubeconfig_store_dir
    os.makedirs(store_dir, exist_ok=True)
    path = kubeconfig_store_path(cluster_id)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    os.chmod(path, 0o600)  # 소유자만 읽기/쓰기
    return path


def resolve_kubeconfig(cluster) -> tuple[str | None, str]:
    """kubeconfig 경로 해석 + 실패 시 **사유** 를 함께 반환.

    기존 `ensure_kubeconfig_file` 은 실패하면 사유 없이 None 만 돌려줘,
    운영자 화면에는 "kubeconfig 미등록" 한 가지 메시지만 보였다. 실제로는
    사유가 여러 갈래라 각각 다음 행동이 다르다:

    - 미등록: /cluster-manage 에서 kubeconfig 업로드 필요
    - DB content 없이 경로만 등록: 그 파일은 등록한 컨테이너에만 존재 —
      Docker Compose 처럼 backend/celery 워커가 볼륨을 공유하지 않는 배포에서는
      워커가 파일을 볼 수 없다(화면에선 연결됨인데 배치잡만 실패하는 모순의 원인)
    - 파일 재생성 실패: 디스크/권한 문제

    반환: (경로 | None, 사유 문자열 — 성공 시 "").
    """
    if cluster is None:
        return None, "잡에 연결된 클러스터를 찾을 수 없습니다."

    has_content = bool(getattr(cluster, "kubeconfig_content", None))
    file_ok = bool(cluster.kubeconfig_path) and os.path.exists(cluster.kubeconfig_path)

    # 1) 파일 존재 + DB 비어있음 → DB 로 백필 (영속 저장소 쪽으로 옮김)
    if file_ok and not has_content:
        try:
            with open(cluster.kubeconfig_path, encoding="utf-8") as f:
                cluster.kubeconfig_content = f.read()
        except Exception:
            pass  # 파일 읽기 실패해도 계속 진행
        return cluster.kubeconfig_path, ""

    # 2) 파일 있음 → 그대로 사용
    if file_ok:
        return cluster.kubeconfig_path, ""

    # 3) DB 에 content 있음 → 표준 경로로 재생성
    content = getattr(cluster, "kubeconfig_content", None)
    if content:
        try:
            return save_kubeconfig_content(cluster.id, content), ""
        except Exception as exc:  # noqa: BLE001 — 사유를 그대로 노출
            return None, (
                f"kubeconfig 파일 재생성 실패({settings.kubeconfig_store_dir}): "
                f"{str(exc)[:150]} — 디스크 공간/권한을 확인하세요."
            )

    # 4) DB content 없음 — 경로만 등록됐는지에 따라 사유가 다름
    if cluster.kubeconfig_path:
        return None, (
            f"kubeconfig 가 경로({cluster.kubeconfig_path})로만 등록돼 있고 DB 에 내용이 없습니다. "
            "이 파일은 등록한 컨테이너에만 존재해 celery 워커 등 다른 컨테이너에서는 보이지 않습니다 "
            "(Docker Compose 는 /tmp/k8s-monitor 볼륨을 공유하지 않음) — "
            "/cluster-manage 에서 kubeconfig 파일을 다시 업로드해 DB 에 저장하세요."
        )
    return None, (
        "클러스터에 kubeconfig 가 등록되어 있지 않습니다 — "
        "/cluster-manage 에서 kubeconfig 를 먼저 등록하세요."
    )


def ensure_kubeconfig_file(cluster) -> str | None:
    """`resolve_kubeconfig` 의 하위호환 wrapper — 경로만 필요할 때 사용.

    실패 사유까지 필요하면 (배치잡 실행/사전 점검처럼 운영자에게 원인을
    보여줘야 하는 경로) `resolve_kubeconfig` 를 직접 호출한다.
    """
    path, _ = resolve_kubeconfig(cluster)
    return path
