"""PEP 실행 콜백 — ansible-playbook 이 이 디렉터리를 콜백 플러그인 경로로 읽는다.

1. 진행(R1): play·task 시작과 호스트별 결과를 **한 줄씩** stderr 에 ``PEP_EVENT {json}`` 으로 흘린다.
   ``playbook_executor`` 가 그 줄을 실행 로그(PlaybookRun.log_lines)로 옮겨 화면이 실행 중에도 본다.
2. 결과: 끝날 때 ``PEP_RESULT {json}`` 한 줄로 호스트별 통계와 실패·도달 불가 태스크를 남긴다.
   예전엔 stdout 콜백 ``json`` 에 기대었는데, 이미지의 ansible-core(2.16)에는 그 콜백이 없어
   (``ansible.posix`` 컬렉션으로 이동) 실행이 "Invalid callback for stdout specified: json" 으로
   항상 실패했다. stdout 은 사람이 읽는 ``default`` 콜백 출력 그대로 원문 로그가 된다.

앱이 import 하는 모듈이 아니다(ansible 이 플러그인으로만 로드 — 패키지 아님).
"""
import json
import sys

from ansible.plugins.callback import CallbackBase

PREFIX = "PEP_EVENT "
RESULT_PREFIX = "PEP_RESULT "
MSG_LIMIT = 300
ISSUE_LIMIT = 50


def _msg(res):
    r = getattr(res, "_result", {}) or {}
    text = r.get("msg") or r.get("stderr") or r.get("reason") or ""
    return str(text).strip().replace("\n", " ")[:MSG_LIMIT]


class CallbackModule(CallbackBase):
    CALLBACK_VERSION = 2.0
    CALLBACK_TYPE = "notification"
    CALLBACK_NAME = "pep_events"
    CALLBACK_NEEDS_ENABLED = True
    CALLBACK_NEEDS_WHITELIST = True  # ansible < 2.11 호환

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._play = "unnamed-play"
        self._task = "unnamed-task"
        self._issues = []  # (play, task, host, kind, msg) — 실패·도달 불가

    def _write(self, prefix, payload):
        try:
            sys.stderr.write(prefix + json.dumps(payload, ensure_ascii=False) + "\n")
            sys.stderr.flush()
        except Exception:  # noqa: BLE001 — 진행 표시 실패가 실행을 깨면 안 된다
            pass

    def _emit(self, level, message):
        self._write(PREFIX, {"level": level, "message": message})

    def _issue(self, result, kind):
        if len(self._issues) < ISSUE_LIMIT:
            self._issues.append((self._play, self._task, result._host.get_name(), kind, _msg(result)))

    def v2_playbook_on_play_start(self, play):
        self._play = play.get_name() or "unnamed-play"
        self._emit("info", f"PLAY [{self._play}]")

    def v2_playbook_on_task_start(self, task, is_conditional):
        self._task = task.get_name() or "unnamed-task"
        self._emit("info", f"TASK [{self._task}]")

    def v2_playbook_on_handler_task_start(self, task):
        self._task = task.get_name() or "unnamed-task"
        self._emit("info", f"HANDLER [{self._task}]")

    def v2_runner_on_ok(self, result):
        changed = bool((getattr(result, "_result", {}) or {}).get("changed"))
        self._emit("info", f"  {'changed' if changed else 'ok'}: [{result._host.get_name()}]")

    def v2_runner_on_failed(self, result, ignore_errors=False):
        tail = f" — {_msg(result)}" if _msg(result) else ""
        if ignore_errors:
            self._emit("warn", f"  failed(ignored): [{result._host.get_name()}]{tail}")
        else:
            self._issue(result, "failed")
            self._emit("error", f"  failed: [{result._host.get_name()}]{tail}")

    def v2_runner_on_unreachable(self, result):
        tail = f" — {_msg(result)}" if _msg(result) else ""
        self._issue(result, "unreachable")
        self._emit("error", f"  unreachable: [{result._host.get_name()}]{tail}")

    def v2_runner_on_skipped(self, result):
        self._emit("info", f"  skipping: [{result._host.get_name()}]")

    def v2_playbook_on_stats(self, stats):
        summary = {}
        for host in sorted(stats.processed.keys()):
            s = stats.summarize(host)
            summary[host] = {k: int(s.get(k, 0) or 0) for k in ("ok", "changed", "failures", "unreachable", "skipped")}
            level = "error" if (s.get("failures") or s.get("unreachable")) else "info"
            self._emit(level, (
                f"RECAP [{host}] ok={s.get('ok', 0)} changed={s.get('changed', 0)} "
                f"failed={s.get('failures', 0)} unreachable={s.get('unreachable', 0)} skipped={s.get('skipped', 0)}"
            ))
        # 결과 — executor 의 _parse_result 가 읽는 json 콜백과 같은 모양(stats + plays/tasks/hosts).
        plays = {}
        for play, task, host, kind, msg in self._issues:
            p = plays.setdefault(play, {"play": {"name": play}, "tasks": []})
            p["tasks"].append({"task": {"name": task}, "hosts": {host: {kind: True, "msg": msg}}})
        self._write(RESULT_PREFIX, {"stats": summary, "plays": list(plays.values())})
