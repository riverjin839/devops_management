# pep-bpf-agent (Cilium 데이터패스 에이전트)

노드마다 1개 뜨는 Rust 에이전트다. Cilium 이 `/sys/fs/bpf/tc/globals` 에 고정(pin)해 둔 BPF 맵을
**읽기 전용**(`BPF_F_RDONLY`)으로 열어 항목 수·최대치를 세고, 요약만 PEP 로 보고한다. 원본 키·값은 노드 밖으로
나가지 않는다. 화면: PEP ▸ K8s 허브 ▸ 진단 ▸ **Cilium 데이터패스**. 소스: `agents/pep-bpf-agent/`.

## 설치

1. PEP backend 환경변수 `CILIUM_BPF_AGENT_TOKEN` 에 임의의 긴 토큰을 넣는다(비우면 수신이 503 으로 닫힌다).
2. 화면 「에이전트 설치」 에서 클러스터 UUID·API 주소가 채워진 매니페스트를 복사해 토큰만 바꿔 `kubectl apply` 하거나,
   이 디렉터리를 쓴다:

   ```bash
   cp secret.yaml.tmpl secret.yaml   # PEP_API_URL / PEP_CLUSTER / CILIUM_BPF_AGENT_TOKEN 교체
   # kustomization.yaml 의 "- secret.yaml" 주석 해제
   kubectl apply -k .
   ```

3. 화면에서 노드가 「보고 중」 으로 바뀌면 끝. 「지금 수집」 을 누르면 노드별 로그가 실시간으로 흐른다.

## 권한

| 항목 | 값 | 이유 |
|---|---|---|
| capability | `drop: ALL`, `add: BPF` | 고정된 맵을 읽기 전용으로 여는 데 필요한 최소 권한 |
| `SYS_ADMIN` | 기본 없음 | 화면 설정 「CAP_SYS_ADMIN 부여」 를 켜면 매니페스트에 추가된다 — 프로그램 목록·고정되지 않은 맵 조회, CAP_BPF 가 없는 5.8 미만 커널에서만 필요 |
| 마운트 | `/sys/fs/bpf` 읽기 전용(`HostToContainer`) | Cilium 이 나중에 고정한 맵도 보이게 |
| 사용자 | uid 0 | 고정 파일이 root 소유 0600 — 다른 capability(DAC_OVERRIDE 등)는 없다 |
| 네트워크 | hostNetwork 없음, 들어오는 포트 없음 | PEP 로 나가는 HTTPS 만 쓴다(보고·작업 long-poll·로그) |
| 서비스어카운트 | 토큰 미마운트 | 쿠버네티스 API 를 쓰지 않는다 |

## 문제 해결

- **`bpf: operation not permitted`** — 컨테이너 런타임의 기본 seccomp 프로필이 `bpf(2)` 를 CAP_SYS_ADMIN 일 때만
  허용하는 오래된 버전(containerd 1.6 이전 등)일 수 있다. 런타임을 올리거나, 화면 설정에서 「CAP_SYS_ADMIN 부여」 를 켠다.
- **고정 경로를 읽지 못함** — Cilium 의 bpffs 위치가 다르면 화면 설정 「고정 경로」 를 고친다(호스트 기준 경로, `/sys/fs/bpf` 아래).
- **사설 인증서** — `PEP_CA_FILE` 로 CA 를 마운트한다. 검증을 끄는 `PEP_TLS_VERIFY=false` 는 임시로만.
- 노드에서 직접 확인: `kubectl -n k8s-monitor-agent exec ds/cilium-bpf-agent -- /pep-bpf-agent --dry-run`
