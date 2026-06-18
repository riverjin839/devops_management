# kind 가 만든 kubeconfig(server=https://0.0.0.0:6443)를 용도별로 복제한다.
#   - _out\admin.conf          : Windows 호스트 kubectl 용 (127.0.0.1:6443)
#   - _out\pep-kubeconfig.yaml  : PEP(docker-compose) 등록용 (host.docker.internal:6443)
#
#   powershell -ExecutionPolicy Bypass -File make-kubeconfigs.ps1
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$out  = Join-Path $here "_out"
New-Item -ItemType Directory -Force -Path $out | Out-Null

# 현재 클러스터 kubeconfig 를 내보낸다(internal 주소가 아닌 host 주소 기준).
$raw = & kind get kubeconfig --name pep
if (-not $raw) { throw "kind 클러스터 'pep' 를 찾을 수 없음 — 먼저 클러스터를 생성하세요." }

# Windows 호스트 kubectl: 0.0.0.0 → 127.0.0.1
($raw -replace 'server: https://0\.0\.0\.0:6443', 'server: https://127.0.0.1:6443') |
  Set-Content -Encoding ascii (Join-Path $out "admin.conf")

# PEP 컨테이너: 0.0.0.0 → host.docker.internal
($raw -replace 'server: https://0\.0\.0\.0:6443', 'server: https://host.docker.internal:6443') |
  Set-Content -Encoding ascii (Join-Path $out "pep-kubeconfig.yaml")

Write-Host "[make-kubeconfigs] 생성 완료:"
Write-Host "  - $out\admin.conf           (set KUBECONFIG 으로 kubectl 사용)"
Write-Host "  - $out\pep-kubeconfig.yaml  (PEP '클러스터 추가' 에 붙여넣기)"
