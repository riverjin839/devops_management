//! PEP API 클라이언트 — 보고·작업 수신(long-poll)·실행 로그 전송. 들어오는 포트는 열지 않는다(풀 방식).

use crate::sysinfo;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::CryptoProvider;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use rustls_pki_types::pem::PemObject;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// 환경 변수 설정 — DaemonSet Secret 이 넣는다.
#[derive(Debug, Clone)]
pub struct Env {
    pub api_url: String,
    pub token: String,
    pub cluster: String,
    pub node: String,
    pub host_ip: Option<String>,
    pub tls_verify: bool,
    pub ca_file: Option<String>,
}

fn var(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

impl Env {
    pub fn from_env() -> Result<Env, String> {
        let need = |n: &str| var(n).ok_or_else(|| format!("환경 변수 {n} 가 필요합니다"));
        let node = var("NODE_NAME")
            .or_else(|| {
                std::fs::read_to_string("/proc/sys/kernel/hostname")
                    .ok()
                    .map(|s| s.trim().to_string())
            })
            .ok_or("환경 변수 NODE_NAME 가 필요합니다")?;
        Ok(Env {
            api_url: need("PEP_API_URL")?.trim_end_matches('/').to_string(),
            token: need("CILIUM_BPF_AGENT_TOKEN")?,
            cluster: need("PEP_CLUSTER")?,
            node,
            host_ip: var("HOST_IP"),
            tls_verify: var("PEP_TLS_VERIFY")
                .map(|v| !matches!(v.to_lowercase().as_str(), "0" | "false" | "no" | "off"))
                .unwrap_or(true),
            ca_file: var("PEP_CA_FILE"),
        })
    }
}

/// `PEP_TLS_VERIFY=false` 일 때만 쓰는 검증 생략기(사설 인증서 환경 — 가능하면 `PEP_CA_FILE` 로 CA 를 마운트한다).
#[derive(Debug)]
struct NoVerify(Arc<CryptoProvider>);

impl ServerCertVerifier for NoVerify {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

fn tls_config(verify: bool, ca_file: Option<&str>) -> Result<Arc<rustls::ClientConfig>, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("TLS 설정 실패: {e}"))?;
    if !verify {
        return Ok(Arc::new(
            builder
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(NoVerify(provider)))
                .with_no_client_auth(),
        ));
    }
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    if let Some(path) = ca_file {
        let certs = CertificateDer::pem_file_iter(path)
            .map_err(|e| format!("PEP_CA_FILE {path} 읽기 실패: {e}"))?;
        for cert in certs {
            let cert = cert.map_err(|e| format!("PEP_CA_FILE {path} 해석 실패: {e}"))?;
            roots
                .add(cert)
                .map_err(|e| format!("PEP_CA_FILE {path} 인증서 추가 실패: {e}"))?;
        }
    }
    Ok(Arc::new(
        builder.with_root_certificates(roots).with_no_client_auth(),
    ))
}

#[derive(Debug, Clone, Deserialize)]
pub struct Task {
    pub run_id: String,
    #[serde(default)]
    pub kind: String,
}

pub struct Client {
    agent: ureq::Agent,
    env: Env,
}

fn err_text(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, resp) => {
            let body = resp.into_string().unwrap_or_default();
            let detail = serde_json::from_str::<Value>(&body)
                .ok()
                .and_then(|v| {
                    v.get("detail").map(|d| {
                        d.as_str()
                            .map(String::from)
                            .unwrap_or_else(|| d.to_string())
                    })
                })
                .unwrap_or(body);
            format!(
                "HTTP {code}: {}",
                detail.chars().take(300).collect::<String>()
            )
        }
        other => other.to_string(),
    }
}

impl Client {
    pub fn new(env: &Env) -> Result<Client, String> {
        let tls = tls_config(env.tls_verify, env.ca_file.as_deref())?;
        let agent = ureq::AgentBuilder::new()
            .tls_config(tls)
            .timeout_connect(Duration::from_secs(10))
            .build();
        Ok(Client {
            agent,
            env: env.clone(),
        })
    }

    pub fn env(&self) -> &Env {
        &self.env
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.env.api_url, path)
    }

    fn auth(&self) -> String {
        format!("Bearer {}", self.env.token)
    }

    /// 보고 — 응답에 다음 주기 수집 설정이 실려 온다.
    pub fn report(&self, body: &Value) -> Result<Value, String> {
        self.agent
            .post(&self.url("/cilium-datapath/agent/report"))
            .set("Authorization", &self.auth())
            .timeout(Duration::from_secs(60))
            .send_json(body)
            .map_err(err_text)?
            .into_json::<Value>()
            .map_err(|e| e.to_string())
    }

    /// 수동 실행 작업을 기다린다 — 서버가 최대 `wait` 초 붙잡고 있다가 작업이 생기면 바로 돌려준다.
    pub fn poll_task(&self, wait: u64) -> Result<Option<Task>, String> {
        let v: Value = self
            .agent
            .get(&self.url("/cilium-datapath/agent/tasks"))
            .set("Authorization", &self.auth())
            .query("cluster", &self.env.cluster)
            .query("node", &self.env.node)
            .query("wait", &wait.to_string())
            .timeout(Duration::from_secs(wait + 15))
            .call()
            .map_err(err_text)?
            .into_json()
            .map_err(|e| e.to_string())?;
        match v.get("task") {
            Some(t) if !t.is_null() => serde_json::from_value(t.clone())
                .map(Some)
                .map_err(|e| e.to_string()),
            _ => Ok(None),
        }
    }

    pub fn post_log(&self, run_id: &str, lines: &[Value]) -> Result<(), String> {
        let body = json!({"cluster": self.env.cluster, "node": self.env.node, "lines": lines});
        self.agent
            .post(&self.url(&format!("/cilium-datapath/agent/runs/{run_id}/log")))
            .set("Authorization", &self.auth())
            .timeout(Duration::from_secs(15))
            .send_json(body)
            .map_err(err_text)
            .map(|_| ())
    }
}

/// 수동 실행 로그 — 줄을 모아 300ms 또는 40줄마다 PEP 로 보낸다(화면 실시간 로그).
pub struct RemoteSink<'a> {
    client: &'a Client,
    run_id: String,
    buf: Vec<Value>,
    last: Instant,
    pub failed: Option<String>,
}

impl<'a> RemoteSink<'a> {
    pub fn new(client: &'a Client, run_id: &str) -> Self {
        RemoteSink {
            client,
            run_id: run_id.to_string(),
            buf: Vec::new(),
            last: Instant::now(),
            failed: None,
        }
    }

    pub fn flush(&mut self) {
        if self.buf.is_empty() {
            return;
        }
        let lines = std::mem::take(&mut self.buf);
        if let Err(e) = self.client.post_log(&self.run_id, &lines) {
            if self.failed.is_none() {
                eprintln!("{} WARN 실행 로그 전송 실패: {e}", sysinfo::now_rfc3339());
            }
            self.failed = Some(e);
        }
        self.last = Instant::now();
    }
}

impl crate::collect::LogSink for RemoteSink<'_> {
    fn log(&mut self, level: &str, message: String) {
        self.buf
            .push(json!({"ts": sysinfo::now_rfc3339(), "level": level, "message": message}));
        if self.buf.len() >= 40 || self.last.elapsed() > Duration::from_millis(300) {
            self.flush();
        }
    }
}
