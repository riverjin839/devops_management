"""여러 호스트에 SSH/SCP 명령을 일괄 실행.

- 순차(sequential) 또는 병렬(parallel, 기본 동시성 10) 실행.
- 결과는 per-host dict 로 반환: {host, status, exitCode, stdout, stderr, durationMs, error}
- 인증: 비밀번호 또는 개인키(문자열) 중 하나.
- 외부 의존: paramiko.
"""
from __future__ import annotations

import asyncio
import io
import os
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, asdict
from typing import Literal, Optional

import paramiko

from app.services.ssh_host_keys import TofuHostKeyPolicy, apply_known_key


@dataclass
class SSHResult:
    host: str
    status: Literal["ok", "error", "timeout", "auth_error", "connect_error"]
    exit_code: Optional[int]
    stdout: str
    stderr: str
    duration_ms: int
    error: Optional[str]
    # 선택적 메타데이터 — 호출자가 SSHTarget 에 실어 보낸 식별자.
    # 결과를 사용자 선택과 1:1 로 매핑하기 위해 그대로 echo back 한다.
    name: Optional[str] = None
    cluster_id: Optional[str] = None
    cluster_name: Optional[str] = None

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class SSHTarget:
    host: str
    port: int = 22
    username: str = "root"
    # 아래 둘 중 하나만 사용
    password: Optional[str] = None
    private_key: Optional[str] = None  # 개인키 내용 (PEM)
    # 식별 메타데이터 — SSH 연결에는 쓰이지 않고 결과로 그대로 반환됨.
    name: Optional[str] = None
    cluster_id: Optional[str] = None
    cluster_name: Optional[str] = None


def _build_client(tgt: SSHTarget, connect_timeout: int) -> paramiko.SSHClient:
    client = paramiko.SSHClient()
    # 운영자가 매번 임의 사내 IP 를 입력하므로 고정 known_hosts 를 미리 배포할 수
    # 없다 — 그렇다고 무조건 수락(AutoAddPolicy)하면 재접속 시 키가 바뀌어도
    # (MITM/재설치) 알 방법이 없다. TOFU: 처음 보는 호스트는 수락+기록(Redis),
    # 이미 아는 호스트는 저장된 키를 미리 심어둬 paramiko 가 스스로 검증하게 한다.
    client.set_missing_host_key_policy(TofuHostKeyPolicy())
    apply_known_key(client, tgt.host, tgt.port)

    kwargs: dict = {
        "hostname": tgt.host,
        "port": tgt.port,
        "username": tgt.username,
        "timeout": connect_timeout,
        "banner_timeout": connect_timeout,
        "auth_timeout": connect_timeout,
        "allow_agent": False,
        "look_for_keys": False,
    }
    if tgt.private_key:
        # 여러 key 포맷 시도
        key = None
        for key_cls in (paramiko.RSAKey, paramiko.Ed25519Key, paramiko.ECDSAKey, paramiko.DSSKey):
            try:
                key = key_cls.from_private_key(io.StringIO(tgt.private_key))
                break
            except Exception:
                continue
        if key is None:
            raise ValueError("개인키 형식을 인식할 수 없습니다 (RSA/Ed25519/ECDSA/DSS 중 하나여야 함)")
        kwargs["pkey"] = key
    elif tgt.password is not None:
        kwargs["password"] = tgt.password
    else:
        raise ValueError("password 또는 private_key 중 하나는 필수입니다")

    client.connect(**kwargs)
    return client


def connect_client(tgt: SSHTarget, connect_timeout: int = 8) -> paramiko.SSHClient:
    """연결된 paramiko SSHClient 를 반환 (TOFU host-key 정책 적용).

    인터랙티브 PTY 세션(예: k9s TUI 스트리밍)처럼 `run_bulk`/`_exec_ssh` 의
    read-to-completion 모델로는 다룰 수 없는 호출자를 위한 공개 진입점.
    호출자가 반환된 client 로 `invoke_shell()` 등을 직접 열고, 사용 후 close 책임을 진다.
    """
    return _build_client(tgt, connect_timeout)


def test_connection(tgt: SSHTarget, connect_timeout: int = 8) -> SSHResult:
    """자격증명/연결성만 검증. 명령은 실행하지 않고 연결 직후 닫는다.

    BatchJob 의 "연결 테스트" 버튼이 사용. SSHResult.status 는 _exec_ssh 와
    같은 분류 (ok / auth_error / connect_error / timeout / error) 를 그대로 쓴다.
    """
    start = time.monotonic()
    client: Optional[paramiko.SSHClient] = None
    try:
        client = _build_client(tgt, connect_timeout)
        return SSHResult(
            host=tgt.host,
            status="ok",
            exit_code=0,
            stdout="",
            stderr="",
            duration_ms=int((time.monotonic() - start) * 1000),
            error=None,
        )
    except paramiko.AuthenticationException as e:
        return SSHResult(
            host=tgt.host, status="auth_error", exit_code=None,
            stdout="", stderr="", duration_ms=int((time.monotonic() - start) * 1000),
            error=f"인증 실패: {str(e)[:120]}",
        )
    except (paramiko.SSHException, OSError, TimeoutError) as e:
        msg = str(e).lower()
        st = "timeout" if "timeout" in msg or "timed out" in msg else "connect_error"
        return SSHResult(
            host=tgt.host, status=st, exit_code=None,
            stdout="", stderr="", duration_ms=int((time.monotonic() - start) * 1000),
            error=f"연결 실패: {str(e)[:120]}",
        )
    except ValueError as e:
        return SSHResult(
            host=tgt.host, status="auth_error", exit_code=None,
            stdout="", stderr="", duration_ms=int((time.monotonic() - start) * 1000),
            error=str(e)[:200],
        )
    except Exception as e:
        return SSHResult(
            host=tgt.host, status="error", exit_code=None,
            stdout="", stderr="", duration_ms=int((time.monotonic() - start) * 1000),
            error=str(e)[:200],
        )
    finally:
        if client is not None:
            try:
                client.close()
            except Exception:
                pass


def _exec_ssh(
    tgt: SSHTarget, command: str, connect_timeout: int, exec_timeout: int,
    max_stdout_chars: int = 8000,
) -> SSHResult:
    """SSH 로 명령 실행. stdout 은 기본 8000 chars 로 잘리는데, JSON 등 구조화된
    큰 출력을 받는 호출은 max_stdout_chars 를 넉넉히 늘려야 한다 (예: ip -j addr show
    가 노드당 인터페이스 수에 따라 수십 KB 까지 커짐 — 잘리면 JSON 파싱 실패)."""
    start = time.monotonic()
    client: Optional[paramiko.SSHClient] = None
    try:
        client = _build_client(tgt, connect_timeout)
        stdin, stdout, stderr = client.exec_command(command, timeout=exec_timeout, get_pty=False)
        # 출력 읽기
        out = stdout.read().decode("utf-8", errors="replace")
        err = stderr.read().decode("utf-8", errors="replace")
        rc = stdout.channel.recv_exit_status()
        elapsed = int((time.monotonic() - start) * 1000)
        # tail 만 보존 (앞쪽 잘리면 JSON 같은 구조화 출력은 깨지지만, 일반 로그는 마지막
        # 쪽이 더 가치 있음 — 호출자가 max_stdout_chars 로 정책을 조정).
        return SSHResult(
            host=tgt.host,
            status="ok" if rc == 0 else "error",
            exit_code=rc,
            stdout=out[-max_stdout_chars:] if max_stdout_chars > 0 else out,
            stderr=err[-4000:],
            duration_ms=elapsed,
            error=None if rc == 0 else f"exit {rc}",
        )
    except paramiko.AuthenticationException as e:
        return SSHResult(
            host=tgt.host, status="auth_error", exit_code=None,
            stdout="", stderr="", duration_ms=int((time.monotonic() - start) * 1000),
            error=f"인증 실패: {str(e)[:120]}",
        )
    except (paramiko.SSHException, OSError, TimeoutError) as e:
        msg = str(e).lower()
        status = "timeout" if "timeout" in msg or "timed out" in msg else "connect_error"
        return SSHResult(
            host=tgt.host, status=status, exit_code=None,
            stdout="", stderr="", duration_ms=int((time.monotonic() - start) * 1000),
            error=f"연결 실패: {str(e)[:120]}",
        )
    except Exception as e:
        return SSHResult(
            host=tgt.host, status="error", exit_code=None,
            stdout="", stderr="", duration_ms=int((time.monotonic() - start) * 1000),
            error=str(e)[:200],
        )
    finally:
        if client is not None:
            try:
                client.close()
            except Exception:
                pass


def _exec_scp_push(tgt: SSHTarget, local_content: bytes, remote_path: str,
                   connect_timeout: int) -> SSHResult:
    """in-memory content → remote_path 로 업로드 (SCP/SFTP)."""
    start = time.monotonic()
    client: Optional[paramiko.SSHClient] = None
    try:
        client = _build_client(tgt, connect_timeout)
        sftp = client.open_sftp()
        try:
            # 부모 디렉터리 자동 생성 시도
            parent = os.path.dirname(remote_path)
            if parent:
                try:
                    sftp.stat(parent)
                except IOError:
                    # mkdir -p
                    acc = ""
                    for part in parent.strip("/").split("/"):
                        acc = f"{acc}/{part}" if acc else f"/{part}"
                        try:
                            sftp.stat(acc)
                        except IOError:
                            try:
                                sftp.mkdir(acc)
                            except Exception:
                                pass
            with sftp.file(remote_path, "wb") as rf:
                rf.write(local_content)
        finally:
            sftp.close()
        elapsed = int((time.monotonic() - start) * 1000)
        return SSHResult(
            host=tgt.host, status="ok", exit_code=0,
            stdout=f"{len(local_content)} bytes → {remote_path}",
            stderr="", duration_ms=elapsed, error=None,
        )
    except paramiko.AuthenticationException as e:
        return SSHResult(
            host=tgt.host, status="auth_error", exit_code=None,
            stdout="", stderr="", duration_ms=int((time.monotonic() - start) * 1000),
            error=f"인증 실패: {str(e)[:120]}",
        )
    except Exception as e:
        return SSHResult(
            host=tgt.host, status="error", exit_code=None,
            stdout="", stderr="", duration_ms=int((time.monotonic() - start) * 1000),
            error=str(e)[:200],
        )
    finally:
        if client is not None:
            try:
                client.close()
            except Exception:
                pass


async def run_bulk(
    targets: list[SSHTarget],
    *,
    action: Literal["ssh", "scp"],
    command: Optional[str] = None,
    scp_content: Optional[bytes] = None,
    scp_remote_path: Optional[str] = None,
    mode: Literal["sequential", "parallel"] = "parallel",
    connect_timeout: int = 8,
    exec_timeout: int = 60,
    parallelism: int = 10,
    chunk_size: int = 30,
    chunk_pause_ms: int = 200,
    max_stdout_chars: int = 8000,
) -> list[SSHResult]:
    """여러 target 에 대해 SSH/SCP 일괄 실행.

    대규모 (100+ 호스트) 안정성을 위해 **청크 단위**로 처리:
      - 한 번에 chunk_size 개씩 병렬 실행 → 완료 대기 → chunk_pause_ms ms 휴지
    이 방식은:
      - 동시에 살아있는 paramiko 세션 수 상한 = parallelism (메모리 안정)
      - SSH 게이트웨이/베스천의 burst 부하 완화
      - 한 청크 실패가 다음 청크를 막지 않음 (결과는 모두 누적)
      - `chunk_size <= parallelism` 이면 사실상 parallelism 제한과 동일
    """

    def one(t: SSHTarget) -> SSHResult:
        if action == "ssh":
            res = _exec_ssh(
                t, command or "", connect_timeout, exec_timeout,
                max_stdout_chars=max_stdout_chars,
            )
        elif action == "scp":
            res = _exec_scp_push(t, scp_content or b"", scp_remote_path or "", connect_timeout)
        else:
            raise ValueError(f"unknown action: {action}")
        # 결과를 호출자가 보낸 노드/클러스터에 1:1 로 묶기 위해 메타를 echo back.
        # 같은 IP 가 여러 노드에 매핑된 환경에서도 어떤 노드가 어떤 결과인지 식별 가능.
        res.name = t.name
        res.cluster_id = t.cluster_id
        res.cluster_name = t.cluster_name
        return res

    if mode == "sequential":
        return [await asyncio.get_event_loop().run_in_executor(None, one, t) for t in targets]

    # 병렬 — 청크 단위 + Semaphore
    loop = asyncio.get_event_loop()
    n = len(targets)
    workers = max(1, min(parallelism, n or 1))
    chunk = max(1, chunk_size)

    results: list[SSHResult] = []
    # ThreadPoolExecutor 는 전체 배치 동안 1개만 사용 — chunk 별로 재생성하지 않음
    with ThreadPoolExecutor(max_workers=workers) as pool:
        sem = asyncio.Semaphore(workers)

        async def bounded(t: SSHTarget) -> SSHResult:
            async with sem:
                return await loop.run_in_executor(pool, one, t)

        for i in range(0, n, chunk):
            batch = targets[i:i + chunk]
            batch_results = await asyncio.gather(
                *[bounded(t) for t in batch],
                return_exceptions=False,
            )
            results.extend(batch_results)
            # 마지막 청크가 아니면 휴지 — 베스천/게이트웨이 부하 완화
            if i + chunk < n and chunk_pause_ms > 0:
                await asyncio.sleep(chunk_pause_ms / 1000.0)

    return results
