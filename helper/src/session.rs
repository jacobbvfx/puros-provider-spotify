//! librespot session setup and reusable-credential exchange.

use std::{
    fs,
    os::unix::fs::{DirBuilderExt, PermissionsExt},
    path::{Path, PathBuf},
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use librespot_core::{
    authentication::Credentials, cache::Cache, error::ErrorKind, Error, Session, SessionConfig,
};

use crate::protocol::{code, StoredCredentials};

/// Scopes requested for the playback token that librespot exchanges for AP credentials.
pub const PLAYBACK_SCOPES: &[&str] = &["streaming", "user-read-private"];
/// librespot's desktop client registers `http://127.0.0.1:<port>/login`.
pub const PLAYBACK_REDIRECT_PATH: &str = "/login";

#[derive(Debug)]
pub struct HelperError {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
}

impl HelperError {
    pub fn new(code: &'static str, message: impl Into<String>, retryable: bool) -> Self {
        Self { code, message: message.into(), retryable }
    }
}

pub fn default_client_id() -> String {
    SessionConfig::default().client_id
}

/// Classify a librespot error without echoing any credential material.
pub fn classify(error: &Error, context: &str) -> HelperError {
    let text = error.to_string();
    if text.contains("Premium account required") {
        return HelperError::new(code::NOT_PREMIUM, "Spotify Premium is required for playback", false);
    }
    if text.contains("Bad credentials") || text.contains("Could not validate credentials") {
        return HelperError::new(code::CREDENTIALS_REJECTED, "Spotify rejected the stored playback credentials", false);
    }
    match error.kind {
        ErrorKind::Unauthenticated | ErrorKind::PermissionDenied => {
            HelperError::new(code::CREDENTIALS_REJECTED, format!("{context}: access denied"), false)
        }
        ErrorKind::NotFound => HelperError::new(code::TRACK_NOT_FOUND, format!("{context}: not found"), false),
        ErrorKind::DeadlineExceeded => HelperError::new(code::TIMEOUT, format!("{context}: timed out"), true),
        ErrorKind::Unavailable | ErrorKind::Aborted | ErrorKind::ResourceExhausted => {
            HelperError::new(code::NETWORK, format!("{context}: {text}"), true)
        }
        _ => HelperError::new(code::INTERNAL, format!("{context}: {text}"), false),
    }
}

pub fn to_librespot(credentials: &StoredCredentials) -> Result<Credentials, HelperError> {
    if credentials.username.is_empty() || credentials.auth_data.is_empty() {
        return Err(HelperError::new(code::NOT_AUTHENTICATED, "stored playback credentials are incomplete", false));
    }
    // Round-trip through librespot's own serde shape so the protobuf enum stays its concern.
    let value = serde_json::json!({
        "username": credentials.username,
        "auth_type": credentials.auth_type,
        "auth_data": credentials.auth_data,
    });
    serde_json::from_value::<Credentials>(value)
        .map_err(|_| HelperError::new(code::NOT_AUTHENTICATED, "stored playback credentials are invalid", false))
}

pub fn from_librespot(credentials: &Credentials) -> Result<StoredCredentials, HelperError> {
    let value = serde_json::to_value(credentials)
        .map_err(|_| HelperError::new(code::INTERNAL, "could not encode reusable credentials", false))?;
    let username = credentials.username.clone().unwrap_or_default();
    let auth_type = value.get("auth_type").and_then(|v| v.as_i64()).unwrap_or_default() as i32;
    if username.is_empty() || credentials.auth_data.is_empty() {
        return Err(HelperError::new(code::CREDENTIALS_REJECTED, "Spotify returned no reusable credentials", false));
    }
    Ok(StoredCredentials { username, auth_type, auth_data: BASE64.encode(&credentials.auth_data) })
}

/// A 0700 directory owned by one helper operation and removed on drop.
pub struct PrivateDir(PathBuf);

impl PrivateDir {
    pub fn create(parent: &Path, name: &str) -> Result<Self, HelperError> {
        if !parent.is_absolute() || !parent.is_dir() {
            return Err(HelperError::new(code::INVALID_REQUEST, "work directory must be an existing absolute path", false));
        }
        let path = parent.join(name);
        let _ = fs::remove_dir_all(&path);
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&path)
            .map_err(|error| HelperError::new(code::IO, format!("cannot create work directory: {error}"), false))?;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o700));
        Ok(Self(path))
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for PrivateDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub struct Connected {
    pub session: Session,
    /// Credentials the access point returned for later reconnects (may be rotated).
    pub reusable: Option<StoredCredentials>,
}

/// Connect one session. `work_dir` receives librespot temp files and, when
/// `capture` is set, the transient credentials.json written by its cache.
pub async fn connect(
    credentials: Credentials,
    work_dir: &PrivateDir,
    capture: bool,
) -> Result<Connected, HelperError> {
    let config = SessionConfig { tmp_dir: work_dir.path().to_path_buf(), ..SessionConfig::default() };
    let cache = if capture {
        Some(
            Cache::new(Some(work_dir.path()), None, None, None)
                .map_err(|error| classify(&error, "cannot prepare credential capture"))?,
        )
    } else {
        None
    };
    let session = Session::new(config, cache);
    session.connect(credentials, capture).await.map_err(|error| classify(&error, "Spotify login failed"))?;
    let reusable = if capture {
        let captured = session.cache().and_then(|cache| cache.credentials());
        let _ = fs::remove_file(work_dir.path().join("credentials.json"));
        match captured {
            Some(value) => Some(from_librespot(&value)?),
            None => None,
        }
    } else {
        None
    };
    Ok(Connected { session, reusable })
}

/// Product and country arrive asynchronously after the AP welcome.
pub async fn wait_for_account_attributes(session: &Session) -> (String, Option<String>) {
    for _ in 0..30 {
        if session.get_user_attribute("type").is_some() && !session.country().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    (session.country(), session.get_user_attribute("type"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_credentials_round_trip_through_librespot() {
        let stored = StoredCredentials {
            username: "puros-test".into(),
            auth_type: 1,
            auth_data: BASE64.encode(b"opaque-blob"),
        };
        let native = to_librespot(&stored).unwrap();
        assert_eq!(native.username.as_deref(), Some("puros-test"));
        assert_eq!(native.auth_data, b"opaque-blob");
        assert_eq!(from_librespot(&native).unwrap(), stored);
    }

    #[test]
    fn rejects_incomplete_credentials() {
        let stored = StoredCredentials { username: String::new(), auth_type: 1, auth_data: "eA==".into() };
        assert_eq!(to_librespot(&stored).unwrap_err().code, code::NOT_AUTHENTICATED);
        let invalid = StoredCredentials { username: "u".into(), auth_type: 9999, auth_data: "eA==".into() };
        assert_eq!(to_librespot(&invalid).unwrap_err().code, code::NOT_AUTHENTICATED);
    }

    #[test]
    fn classifies_access_point_failures() {
        let premium = Error::permission_denied(std::io::Error::other("Login failed with reason: Premium account required"));
        assert_eq!(classify(&premium, "x").code, code::NOT_PREMIUM);
        let denied = Error::permission_denied(std::io::Error::other("Login failed with reason: Bad credentials"));
        assert_eq!(classify(&denied, "x").code, code::CREDENTIALS_REJECTED);
        let unavailable = Error::unavailable(std::io::Error::other("offline"));
        assert!(classify(&unavailable, "x").retryable);
    }

    #[test]
    fn private_dir_is_owner_only_and_removed() {
        let parent = std::env::temp_dir();
        let path;
        {
            let dir = PrivateDir::create(&parent, &format!("puros-spotify-test-{}", std::process::id())).unwrap();
            path = dir.path().to_path_buf();
            let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700);
        }
        assert!(!path.exists());
    }
}
