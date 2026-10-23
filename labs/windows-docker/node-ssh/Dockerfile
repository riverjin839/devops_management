# PEP Host Facts(SSH) 테스트용 "운영 노드 흉내" 컨테이너 — AlmaLinux 10(RHEL 10 호환).
# kind 노드는 sshd 가 없으므로, root SSH(비번)·bond·jq 등 운영 노드와 같은 환경을
# 별도 컨테이너로 제공한다. PEP 의 Host Facts 수집 / 대량실행(SSH) 검증용.
FROM almalinux:10

# openssh-server: sshd / iproute: ip(bond) / jq: PEP NIC 필터 / procps-ng: ps 등
RUN dnf -y install openssh-server passwd iproute jq sudo procps-ng hostname iputils \
    && dnf clean all \
    && ssh-keygen -A

# root 로그인 + 비번(테스트 전용 — 폐쇄망 운영의 root+password 수집 흐름과 동일).
ARG ROOT_PASSWORD=rootpass
RUN echo "root:${ROOT_PASSWORD}" | chpasswd \
    && sed -ri 's/^#?\s*PermitRootLogin.*/PermitRootLogin yes/'             /etc/ssh/sshd_config \
    && sed -ri 's/^#?\s*PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config

COPY entrypoint.sh /usr/local/sbin/entrypoint.sh
RUN chmod +x /usr/local/sbin/entrypoint.sh

EXPOSE 22
ENTRYPOINT ["/usr/local/sbin/entrypoint.sh"]
