import { useState } from 'react';
import { Check, ChevronDown, ChevronUp, Copy } from 'lucide-react';
import { useToast } from '@/components/common';

/** Alertmanager 에 붙여넣을 receiver 설정 예시. 토큰은 실제 값을 노출하지 않는다. */
const ALERTMANAGER_YAML = `# alertmanager.yaml — 기존 cube receiver 는 그대로 두고 PEP 를 추가한다.
receivers:
  - name: cube            # (기존) 사내 메신저
    webhook_configs:
      - url: http://alert-forwarder.observability.svc:8080/cube

  - name: pep             # (추가) PEP 알람 인박스
    webhook_configs:
      - url: https://<PEP-HOST>/api/v1/observability/alerts/ingest
        send_resolved: true          # 해소 알림도 보내야 인박스가 resolved 로 닫힌다
        http_config:
          authorization:
            type: Bearer
            credentials: <ALERT_INGEST_TOKEN>

route:
  receiver: cube
  routes:
    - receiver: pep
      continue: true                 # cube 로도 계속 보낸다(둘 다 수신)
      group_wait: 30s
      group_interval: 5m
      repeat_interval: 4h`;

const CURL_TEST = `# 수신 확인 — 200/201 이면 /alerts 에 행이 생긴다.
curl -sS -X POST 'https://<PEP-HOST>/api/v1/observability/alerts/ingest' \\
  -H 'Authorization: Bearer <ALERT_INGEST_TOKEN>' \\
  -H 'Content-Type: application/json' \\
  -d '{"version":"4","status":"firing","alerts":[{"status":"firing",
       "labels":{"alertname":"PepIngestTest","severity":"warning","cluster":"<클러스터명>"},
       "annotations":{"summary":"PEP 알람 수신 테스트"},
       "startsAt":"2026-07-28T00:00:00Z"}]}'`;

const FORWARDER_NOTE = `사내 alert-forwarder 를 경유해도 됩니다. 같은 엔드포인트가 Alertmanager 표준
포맷이 아닌 임의 JSON 도 받아서 정규화합니다(title/message/level/host 류 키를 자동 매핑).
클러스터는 쿼리 파라미터 ?cluster=<이름> 또는 라벨 cluster / prometheus 값으로 매칭합니다.`;

export function AlertReceiverGuide() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const toast = useToast();

  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied((prev) => (prev === key ? null : prev)), 2000);
    } catch {
      toast.error('클립보드 복사에 실패했습니다.');
    }
  };

  return (
    <div className="rounded-md border border-border bg-muted/20 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between px-4 py-2.5 text-sm font-medium hover:bg-muted/40 transition-colors"
      >
        <span>알람 수신 설정 방법 (Alertmanager · alert-forwarder)</span>
        {open
          ? <ChevronUp className="w-4 h-4 text-muted-foreground" aria-hidden />
          : <ChevronDown className="w-4 h-4 text-muted-foreground" aria-hidden />}
      </button>

      {open ? (
        <div className="px-4 pb-4 pt-1 space-y-4 border-t border-border">
          <p className="text-xs text-muted-foreground leading-relaxed">
            백엔드 환경변수 <code className="font-mono text-foreground">ALERT_INGEST_TOKEN</code> 을
            먼저 설정해야 합니다. 미설정이면 수신 엔드포인트가 <b className="text-foreground">503</b> 으로
            닫혀 있습니다(무인증 공개 방지).
          </p>

          <Snippet
            title="1. Alertmanager receiver 추가"
            code={ALERTMANAGER_YAML}
            copied={copied === 'yaml'}
            onCopy={() => copy('yaml', ALERTMANAGER_YAML)}
          />
          <Snippet
            title="2. 수신 테스트"
            code={CURL_TEST}
            copied={copied === 'curl'}
            onCopy={() => copy('curl', CURL_TEST)}
          />

          <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-line">
            {FORWARDER_NOTE}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function Snippet({ title, code, copied, onCopy }: {
  title: string;
  code: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-semibold text-muted-foreground">{title}</span>
        <button
          type="button"
          onClick={onCopy}
          title="복사"
          aria-label={`${title} 복사`}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-xl text-xs bg-secondary text-muted-foreground hover:bg-secondary/80 transition-colors"
        >
          {copied
            ? <><Check className="w-3 h-3" aria-hidden /> 복사됨</>
            : <><Copy className="w-3 h-3" aria-hidden /> 복사</>}
        </button>
      </div>
      <pre className="text-xs font-mono whitespace-pre-wrap break-all bg-secondary rounded-xl p-3 overflow-x-auto">
        {code}
      </pre>
    </div>
  );
}
