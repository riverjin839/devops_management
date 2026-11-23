//! PEP 로 보고 전송 — 동기 HTTP(ureq + rustls). 운영자가 지정한 `PEP_API_URL` 로만 나간다.
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme};
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;

pub const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");

pub enum ReportError {
    /// 서버가 응답은 했지만 2xx 가 아니다 — (상태 코드, 본문 앞부분).
    Http(u16, String),
    /// 네트워크·TLS·응답 해석 실패.
    Other(String),
}

#[derive(Debug)]
struct NoVerify(Arc<rustls::crypto::CryptoProvider>);

impl ServerCertVerifier for NoVerify {
    fn verify_server_cert(
        &self,
        _: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        _: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        m: &[u8],
        c: &CertificateDer<'_>,
        d: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(m, c, d, &self.0.signature_verification_algorithms)
    }
    fn verify_tls13_signature(
        &self,
        m: &[u8],
        c: &CertificateDer<'_>,
        d: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(m, c, d, &self.0.signature_verification_algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

/// `PEP_TLS_VERIFY=false` 면 검증을 끈다(기본 켬). `PEP_CA_FILE` 이 있으면 그 사설 CA 만 신뢰한다.
pub fn build_agent(verify: bool, ca_file: Option<&str>) -> Result<ureq::Agent, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("TLS 초기화 실패: {e}"))?;
    let cfg = if !verify {
        builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(NoVerify(provider)))
            .with_no_client_auth()
    } else {
        let mut roots = RootCertStore::empty();
        match ca_file.filter(|f| !f.is_empty()) {
            Some(path) => {
                let pem = std::fs::read(path)
                    .map_err(|e| format!("PEP_CA_FILE {path} 읽기 실패: {e}"))?;
                let mut n = 0;
                for cert in rustls_pemfile::certs(&mut pem.as_slice()) {
                    let cert = cert.map_err(|e| format!("PEP_CA_FILE {path} 해석 실패: {e}"))?;
                    roots
                        .add(cert)
                        .map_err(|e| format!("PEP_CA_FILE {path} 인증서 오류: {e}"))?;
                    n += 1;
                }
                if n == 0 {
                    return Err(format!("PEP_CA_FILE {path} 에 인증서가 없습니다"));
                }
            }
            None => roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned()),
        }
        builder.with_root_certificates(roots).with_no_client_auth()
    };
    Ok(ureq::AgentBuilder::new()
        .tls_config(Arc::new(cfg))
        .timeout(Duration::from_secs(15))
        .user_agent(&format!("pep-node-param-agent/{AGENT_VERSION}"))
        .build())
}

pub fn post_report(
    agent: &ureq::Agent,
    url: &str,
    token: &str,
    payload: &Value,
) -> Result<Value, ReportError> {
    let resp = agent
        .post(url)
        .set("Authorization", &format!("Bearer {token}"))
        .send_json(payload);
    match resp {
        Ok(r) => {
            let body = r
                .into_string()
                .map_err(|e| ReportError::Other(format!("응답 읽기 실패: {e}")))?;
            if body.trim().is_empty() {
                return Ok(Value::Object(Default::default()));
            }
            serde_json::from_str(&body)
                .map_err(|e| ReportError::Other(format!("응답 해석 실패: {e}")))
        }
        Err(ureq::Error::Status(code, r)) => {
            let body: String = r
                .into_string()
                .unwrap_or_default()
                .chars()
                .take(300)
                .collect();
            Err(ReportError::Http(code, body))
        }
        Err(e) => Err(ReportError::Other(format!("{e}"))),
    }
}
