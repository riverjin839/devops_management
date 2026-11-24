"""공통 서비스 — 여러 클러스터가 함께 쓰는 서비스(LDAP AD·KEYCLOAK·JENKINS·ARGOCD·NEXUS) 등록·설정값 수집·변경 감지·실행 로그.

- ``catalog``    : 서비스 타입·호스팅 방식·화면 폼 필드(params·자격증명)
- ``flatten``    : 수집 결과 평탄화·비밀 마스킹·해시·diff(순수 함수)
- ``collectors`` : 배포 수준(K8S 워크로드·Podman) + 앱 설정 수집기
- ``service``    : CRUD·수집 실행(단계·로그)·스냅샷/변경·알람·감시 설정·K8S 후보 찾기
"""
