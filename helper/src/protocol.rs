//! Private NDJSON protocol between the Spotify provider runtime and this helper.
//!
//! argv carries only a fixed command name. The single request line on stdin
//! carries every variable value (IDs, paths, credentials). stdout carries only
//! protocol events; diagnostics go to stderr and never contain credentials.

use serde::{Deserialize, Serialize};
use std::io::Write;

pub const PROTOCOL_VERSION: u32 = 1;
/// Bound on one stdin line; a request never needs more than a few kilobytes.
pub const MAX_REQUEST_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoredCredentials {
    pub username: String,
    /// librespot's numeric AuthenticationType (1 = stored Spotify credentials).
    pub auth_type: i32,
    /// Base64 reusable credential blob from the access point.
    pub auth_data: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub version: u32,
    pub request_id: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub access_token: Option<String>,
    #[serde(default)]
    pub credentials: Option<StoredCredentials>,
    #[serde(default)]
    pub track_id: Option<String>,
    #[serde(default)]
    pub output_path: Option<String>,
    #[serde(default)]
    pub work_dir: Option<String>,
    #[serde(default)]
    pub bitrate: Option<u32>,
    #[serde(default)]
    pub first_data_timeout_ms: Option<u64>,
    #[serde(default)]
    pub stall_timeout_ms: Option<u64>,
    /// Write `output_path` in place while downloading and announce it with `growing`.
    #[serde(default)]
    pub progressive: bool,
    /// Verified Ogg bytes required before the growing file is announced.
    #[serde(default)]
    pub ready_bytes: Option<u64>,
}

/// Parent → helper control message after the request line.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Control {
    Cancel,
}

#[derive(Debug, Serialize)]
#[serde(tag = "event", rename_all = "kebab-case")]
pub enum Event<'a> {
    #[serde(rename_all = "camelCase")]
    Described {
        version: u32,
        request_id: &'a str,
        librespot_version: &'a str,
        client_id: String,
        scopes: &'a [&'a str],
        redirect_path: &'a str,
    },
    #[serde(rename_all = "camelCase")]
    Authenticated {
        version: u32,
        request_id: &'a str,
        credentials: StoredCredentials,
        country: String,
        product: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        version: u32,
        request_id: &'a str,
        session_id: Option<&'a str>,
        bytes_completed: u64,
        bytes_total: u64,
    },
    /// The growing file at `path` holds at least `bytes` of verified Ogg data.
    #[serde(rename_all = "camelCase")]
    Growing {
        version: u32,
        request_id: &'a str,
        session_id: Option<&'a str>,
        track_id: &'a str,
        path: &'a str,
        codec: &'a str,
        bitrate_kbps: u32,
        duration_ms: u32,
        bytes: u64,
        bytes_total: u64,
    },
    #[serde(rename_all = "camelCase")]
    ArtifactReady {
        version: u32,
        request_id: &'a str,
        session_id: Option<&'a str>,
        track_id: &'a str,
        path: &'a str,
        codec: &'a str,
        bitrate_kbps: u32,
        duration_ms: u32,
        bytes: u64,
    },
    #[serde(rename_all = "camelCase")]
    Completed {
        version: u32,
        request_id: &'a str,
    },
    #[serde(rename_all = "camelCase")]
    Failed {
        version: u32,
        request_id: &'a str,
        code: &'a str,
        message: String,
        retryable: bool,
    },
}

/// Stable failure codes; the TypeScript side maps them to provider error codes.
pub mod code {
    pub const INVALID_REQUEST: &str = "invalid-request";
    pub const NOT_AUTHENTICATED: &str = "not-authenticated";
    pub const CREDENTIALS_REJECTED: &str = "credentials-rejected";
    pub const NOT_PREMIUM: &str = "not-premium";
    pub const TRACK_NOT_FOUND: &str = "track-not-found";
    pub const TRACK_UNAVAILABLE: &str = "track-unavailable";
    pub const NO_SUPPORTED_FILE: &str = "no-supported-file";
    pub const AUDIO_KEY: &str = "audio-key";
    pub const NETWORK: &str = "network";
    pub const TIMEOUT: &str = "timeout";
    pub const CANCELLED: &str = "cancelled";
    pub const IO: &str = "io";
    pub const INVALID_AUDIO: &str = "invalid-audio";
    pub const INTERNAL: &str = "internal";
}

pub fn emit(event: &Event<'_>) {
    let mut line = match serde_json::to_vec(event) {
        Ok(line) => line,
        Err(error) => {
            eprintln!("[spotify-helper] failed to encode event: {error}");
            return;
        }
    };
    line.push(b'\n');
    let stdout = std::io::stdout();
    let mut lock = stdout.lock();
    // A closed stdout means the parent is gone; the stdin watcher cancels the work.
    let _ = lock.write_all(&line).and_then(|_| lock.flush());
}

pub fn parse_request(line: &str) -> Result<Request, String> {
    if line.len() > MAX_REQUEST_BYTES {
        return Err("request exceeds the helper input limit".into());
    }
    let request: Request = serde_json::from_str(line).map_err(|error| format!("malformed request: {error}"))?;
    if request.version != PROTOCOL_VERSION {
        return Err(format!("unsupported protocol version {}", request.version));
    }
    if request.request_id.is_empty()
        || request.request_id.len() > 128
        || !request.request_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("invalid request id".into());
    }
    if let Some(session_id) = &request.session_id {
        if session_id.len() < 8
            || session_id.len() > 128
            || !session_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err("invalid session id".into());
        }
    }
    Ok(request)
}

/// Spotify base62 IDs are exactly 22 alphanumeric characters.
pub fn is_base62_id(value: &str) -> bool {
    value.len() == 22 && value.chars().all(|c| c.is_ascii_alphanumeric())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_minimal_request() {
        let request = parse_request(r#"{"version":1,"requestId":"req-1"}"#).unwrap();
        assert_eq!(request.request_id, "req-1");
        assert!(request.credentials.is_none());
    }

    #[test]
    fn rejects_unknown_fields_versions_and_ids() {
        assert!(parse_request(r#"{"version":1,"requestId":"a","password":"x"}"#).is_err());
        assert!(parse_request(r#"{"version":2,"requestId":"a"}"#).is_err());
        assert!(parse_request(r#"{"version":1,"requestId":"../x"}"#).is_err());
        assert!(parse_request(r#"{"version":1,"requestId":"a","sessionId":"short"}"#).is_err());
        let oversized = format!(r#"{{"version":1,"requestId":"{}"}}"#, "a".repeat(MAX_REQUEST_BYTES));
        assert!(parse_request(&oversized).is_err());
    }

    #[test]
    fn validates_base62_ids() {
        assert!(is_base62_id("4uLU6hMCjMI75M1A2tKUQC"));
        assert!(!is_base62_id("spotify:track:4uLU6hMCjMI75M1A2tKUQC"));
        assert!(!is_base62_id("4uLU6hMCjMI75M1A2tKUQ"));
    }

    #[test]
    fn serializes_events_without_credentials_in_failures() {
        let event = Event::Failed {
            version: PROTOCOL_VERSION,
            request_id: "r",
            code: code::AUDIO_KEY,
            message: "audio key rejected".into(),
            retryable: false,
        };
        let json = serde_json::to_string(&event).unwrap();
        assert_eq!(
            json,
            r#"{"event":"failed","version":1,"requestId":"r","code":"audio-key","message":"audio key rejected","retryable":false}"#
        );
    }
}
