//! Puros Spotify helper: one declared command per process.
//!
//! Commands (argv[1]): `describe`, `login`, `check-session`, `fetch-track`.
//! stdin: one JSON request line, then optional `{"type":"cancel"}` lines. EOF
//! on stdin or SIGTERM cancels the operation and removes partial files.

mod file_sink;
mod protocol;
mod session;

use std::{
    io::{BufRead, Read},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use librespot_audio::{AudioDecrypt, AudioFetchParams, AudioFile};
use librespot_core::{authentication::Credentials, SpotifyId, SpotifyUri};
use librespot_metadata::audio::{AudioFileFormat, AudioItem};
use tokio::sync::Notify;

use protocol::{code, emit, Event, Request, PROTOCOL_VERSION};
use session::{HelperError, PrivateDir};

const DEFAULT_FIRST_DATA_TIMEOUT_MS: u64 = 20_000;
const DEFAULT_STALL_TIMEOUT_MS: u64 = 30_000;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

struct Cancellation {
    flag: AtomicBool,
    notify: Notify,
}

impl Cancellation {
    fn cancel(&self) {
        self.flag.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }
    fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::Acquire)
    }
    async fn cancelled(&self) {
        loop {
            let notified = self.notify.notified();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

fn main() {
    let command = std::env::args().nth(1).unwrap_or_default();
    if !matches!(command.as_str(), "describe" | "login" | "check-session" | "fetch-track") {
        eprintln!("[spotify-helper] unknown command");
        std::process::exit(64);
    }
    // stdin is read on a dedicated thread: the first line is the request, later
    // lines are control messages, and EOF means the parent went away.
    let (request_tx, request_rx) = std::sync::mpsc::channel::<Result<String, String>>();
    let cancellation = Arc::new(Cancellation { flag: AtomicBool::new(false), notify: Notify::new() });
    let watcher = cancellation.clone();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut lines = stdin.lock();
        let mut first = String::new();
        let limited = (&mut lines).take(protocol::MAX_REQUEST_BYTES as u64 + 1).read_line(&mut first);
        match limited {
            Ok(0) => {
                let _ = request_tx.send(Err("missing request".into()));
                return;
            }
            Ok(_) => {
                let _ = request_tx.send(Ok(first));
            }
            Err(error) => {
                let _ = request_tx.send(Err(format!("cannot read request: {error}")));
                return;
            }
        }
        for line in lines.lines() {
            match line {
                Ok(line) if line.trim().is_empty() => continue,
                Ok(line) => {
                    if matches!(serde_json::from_str::<protocol::Control>(&line), Ok(protocol::Control::Cancel)) {
                        watcher.cancel();
                        return;
                    }
                }
                Err(_) => break,
            }
        }
        watcher.cancel();
    });

    let raw = match request_rx.recv() {
        Ok(Ok(raw)) => raw,
        Ok(Err(message)) => {
            fail("unknown", HelperError::new(code::INVALID_REQUEST, message, false));
            std::process::exit(65);
        }
        Err(_) => {
            fail("unknown", HelperError::new(code::INVALID_REQUEST, "missing request", false));
            std::process::exit(65);
        }
    };
    let request = match protocol::parse_request(raw.trim_end()) {
        Ok(request) => request,
        Err(message) => {
            fail("unknown", HelperError::new(code::INVALID_REQUEST, message, false));
            std::process::exit(65);
        }
    };

    let runtime = match tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            fail(&request.request_id, HelperError::new(code::INTERNAL, format!("cannot start runtime: {error}"), false));
            std::process::exit(70);
        }
    };
    let exit_code = runtime.block_on(run(command, request, cancellation));
    // Do not wait for librespot background tasks; the operation is finished.
    runtime.shutdown_timeout(Duration::from_millis(200));
    std::process::exit(exit_code);
}

fn fail(request_id: &str, error: HelperError) {
    emit(&Event::Failed {
        version: PROTOCOL_VERSION,
        request_id,
        code: error.code,
        message: error.message,
        retryable: error.retryable,
    });
}

async fn run(command: String, request: Request, cancellation: Arc<Cancellation>) -> i32 {
    let signal_cancellation = cancellation.clone();
    tokio::spawn(async move {
        if let Ok(mut terminate) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            terminate.recv().await;
            signal_cancellation.cancel();
        }
    });

    let request_id = request.request_id.clone();
    let operation = async {
        match command.as_str() {
            "describe" => describe(&request),
            "login" | "check-session" => login(&request).await,
            "fetch-track" => fetch_track(&request, cancellation.clone()).await,
            _ => Err(HelperError::new(code::INVALID_REQUEST, "unknown command", false)),
        }
    };
    let result = tokio::select! {
        // Poll the operation first so work that is already finished is not reported as cancelled.
        biased;
        result = operation => result,
        _ = cancellation.cancelled() => Err(HelperError::new(code::CANCELLED, "operation cancelled", false)),
    };
    match result {
        Ok(()) => {
            emit(&Event::Completed { version: PROTOCOL_VERSION, request_id: &request_id });
            0
        }
        Err(error) => {
            let cancelled = error.code == code::CANCELLED;
            if cancelled && command == "fetch-track" {
                remove_partial_output(&request).await;
            }
            fail(&request_id, error);
            if cancelled { 130 } else { 1 }
        }
    }
}

/// The copy thread notices cancellation at its next read; give it a moment,
/// then remove whatever partial file is left.
async fn remove_partial_output(request: &Request) {
    let Some(output_path) = request.output_path.as_deref() else { return };
    let output = std::path::Path::new(output_path);
    let (Some(parent), Some(name)) = (output.parent(), output.file_name().and_then(|n| n.to_str())) else { return };
    tokio::time::sleep(Duration::from_millis(100)).await;
    let _ = std::fs::remove_file(parent.join(format!(".{name}.part")));
    if request.progressive {
        // A growing output is itself the partial file until `artifact-ready`.
        let _ = std::fs::remove_file(output);
    }
}

fn describe(request: &Request) -> Result<(), HelperError> {
    emit(&Event::Described {
        version: PROTOCOL_VERSION,
        request_id: &request.request_id,
        librespot_version: librespot_core::version::SEMVER,
        client_id: session::default_client_id(),
        scopes: session::PLAYBACK_SCOPES,
        redirect_path: session::PLAYBACK_REDIRECT_PATH,
    });
    Ok(())
}

fn work_dir(request: &Request, purpose: &str) -> Result<PrivateDir, HelperError> {
    let parent = request
        .work_dir
        .as_deref()
        .ok_or_else(|| HelperError::new(code::INVALID_REQUEST, "work directory is required", false))?;
    PrivateDir::create(std::path::Path::new(parent), &format!(".{purpose}-{}", request.request_id))
}

fn request_credentials(request: &Request) -> Result<Credentials, HelperError> {
    match (&request.access_token, &request.credentials) {
        (Some(token), None) if !token.is_empty() && token.len() <= 4096 => Ok(Credentials::with_access_token(token.clone())),
        (None, Some(stored)) => session::to_librespot(stored),
        _ => Err(HelperError::new(code::NOT_AUTHENTICATED, "exactly one of accessToken or credentials is required", false)),
    }
}

async fn connect_with_timeout(
    credentials: Credentials,
    dir: &PrivateDir,
    capture: bool,
) -> Result<session::Connected, HelperError> {
    tokio::time::timeout(CONNECT_TIMEOUT, session::connect(credentials, dir, capture))
        .await
        .map_err(|_| HelperError::new(code::TIMEOUT, "Spotify access point did not respond", true))?
}

/// Exchange an OAuth access token (login) or stored credentials (check-session)
/// for reusable access-point credentials.
async fn login(request: &Request) -> Result<(), HelperError> {
    let credentials = request_credentials(request)?;
    let dir = work_dir(request, "login")?;
    let connected = connect_with_timeout(credentials.clone(), &dir, true).await?;
    let reusable = match connected.reusable {
        Some(value) => value,
        // The AP may skip re-issuing stored credentials; the ones we sent stay valid.
        None if request.credentials.is_some() => session::from_librespot(&credentials)?,
        None => return Err(HelperError::new(code::CREDENTIALS_REJECTED, "Spotify returned no reusable credentials", false)),
    };
    let (country, product) = session::wait_for_account_attributes(&connected.session).await;
    connected.session.shutdown();
    emit(&Event::Authenticated {
        version: PROTOCOL_VERSION,
        request_id: &request.request_id,
        credentials: reusable,
        country,
        product,
    });
    Ok(())
}

fn vorbis_formats(bitrate: u32) -> &'static [(AudioFileFormat, u32)] {
    // Only Ogg Vorbis: the artifact pipeline and quality labels promise exactly this codec.
    match bitrate {
        96 => &[(AudioFileFormat::OGG_VORBIS_96, 96), (AudioFileFormat::OGG_VORBIS_160, 160), (AudioFileFormat::OGG_VORBIS_320, 320)],
        160 => &[(AudioFileFormat::OGG_VORBIS_160, 160), (AudioFileFormat::OGG_VORBIS_96, 96), (AudioFileFormat::OGG_VORBIS_320, 320)],
        _ => &[(AudioFileFormat::OGG_VORBIS_320, 320), (AudioFileFormat::OGG_VORBIS_160, 160), (AudioFileFormat::OGG_VORBIS_96, 96)],
    }
}

async fn fetch_track(request: &Request, cancellation: Arc<Cancellation>) -> Result<(), HelperError> {
    let track_id = request
        .track_id
        .as_deref()
        .filter(|id| protocol::is_base62_id(id))
        .ok_or_else(|| HelperError::new(code::INVALID_REQUEST, "a base62 Spotify track ID is required", false))?;
    let output_path = request
        .output_path
        .as_deref()
        .ok_or_else(|| HelperError::new(code::INVALID_REQUEST, "output path is required", false))?;
    let (output, part) = file_sink::prepare_output(output_path)?;
    let credentials = match &request.credentials {
        Some(stored) => session::to_librespot(stored)?,
        None => return Err(HelperError::new(code::NOT_AUTHENTICATED, "playback credentials are required", false)),
    };
    let limits = file_sink::SinkLimits {
        first_data_timeout: Duration::from_millis(request.first_data_timeout_ms.unwrap_or(DEFAULT_FIRST_DATA_TIMEOUT_MS).clamp(1_000, 120_000)),
        stall_timeout: Duration::from_millis(request.stall_timeout_ms.unwrap_or(DEFAULT_STALL_TIMEOUT_MS).clamp(1_000, 300_000)),
    };
    // Download the whole file as fast as the CDN allows instead of pacing to playback.
    let _ = AudioFetchParams::set(AudioFetchParams {
        read_ahead_before_playback: Duration::from_secs(3_600),
        read_ahead_during_playback: Duration::from_secs(3_600),
        ..AudioFetchParams::default()
    });

    let dir = work_dir(request, "fetch")?;
    let connected = connect_with_timeout(credentials, &dir, false).await?;
    let session = connected.session;
    let uri = SpotifyUri::from_uri(&format!("spotify:track:{track_id}"))
        .map_err(|_| HelperError::new(code::INVALID_REQUEST, "invalid Spotify track ID", false))?;
    let spotify_id = SpotifyId::try_from(&uri)
        .map_err(|_| HelperError::new(code::INVALID_REQUEST, "invalid Spotify track ID", false))?;

    let item = AudioItem::get_file(&session, uri)
        .await
        .map_err(|error| session::classify(&error, "cannot load track metadata"))?;
    // Exact-source contract: never substitute a relinked alternative track ID.
    if item.track_id.to_id().ok().as_deref() != Some(track_id) {
        return Err(HelperError::new(code::TRACK_UNAVAILABLE, "Spotify returned a different track", false));
    }
    if let Err(reason) = &item.availability {
        return Err(HelperError::new(code::TRACK_UNAVAILABLE, format!("track is unavailable: {reason}"), false));
    }
    if item.files.is_empty() {
        let message = if item.alternatives.is_some() {
            "track is only available as a relinked alternative"
        } else {
            "track has no audio files"
        };
        return Err(HelperError::new(code::TRACK_UNAVAILABLE, message, false));
    }
    let (format, bitrate_kbps, file_id) = vorbis_formats(request.bitrate.unwrap_or(320))
        .iter()
        .find_map(|(format, kbps)| item.files.get(format).map(|file_id| (*format, *kbps, *file_id)))
        .ok_or_else(|| HelperError::new(code::NO_SUPPORTED_FILE, "track has no Ogg Vorbis file", false))?;

    // An audio key failure is terminal: never write undecrypted data.
    let key = session
        .audio_key()
        .request(spotify_id, file_id)
        .await
        .map_err(|error| HelperError::new(code::AUDIO_KEY, format!("Spotify refused the audio key: {error}"), false))?;

    let bytes_per_second = (bitrate_kbps as usize * 1024) / 8;
    let encrypted = tokio::time::timeout(limits.first_data_timeout, AudioFile::open(&session, file_id, bytes_per_second))
        .await
        .map_err(|_| HelperError::new(code::TIMEOUT, "audio file did not open in time", true))?
        .map_err(|error| session::classify(&error, "cannot open audio file"))?;
    let controller = encrypted
        .get_stream_loader_controller()
        .map_err(|error| session::classify(&error, "cannot control audio download"))?;
    controller.set_stream_mode();
    let total = controller.len() as u64;
    let _ = format;

    let session_id = request.session_id.clone();
    let request_id = request.request_id.clone();
    let blocking_cancel = cancellation.clone();
    let output_for_copy = output.clone();
    let mode = if request.progressive {
        // Default: roughly eight seconds of audio at the chosen bitrate.
        let ready_bytes = request.ready_bytes.unwrap_or(bitrate_kbps as u64 * 1000);
        file_sink::SinkMode::Growing { ready_bytes: ready_bytes.clamp(16 * 1024, 16 * 1024 * 1024) }
    } else {
        file_sink::SinkMode::Atomic
    };
    let growing_track_id = track_id.to_owned();
    let duration_ms = item.duration_ms;
    let written = tokio::task::spawn_blocking(move || {
        let flag = &blocking_cancel.flag;
        let output_text = output_for_copy.to_str().unwrap_or_default().to_owned();
        file_sink::write_ogg(
            AudioDecrypt::new(Some(key), encrypted),
            total,
            &output_for_copy,
            &part,
            mode,
            flag,
            &limits,
            |done, total| {
                emit(&Event::Progress {
                    version: PROTOCOL_VERSION,
                    request_id: &request_id,
                    session_id: session_id.as_deref(),
                    bytes_completed: done,
                    bytes_total: total,
                });
            },
            |bytes| {
                emit(&Event::Growing {
                    version: PROTOCOL_VERSION,
                    request_id: &request_id,
                    session_id: session_id.as_deref(),
                    track_id: &growing_track_id,
                    path: &output_text,
                    codec: "vorbis",
                    bitrate_kbps,
                    duration_ms,
                    bytes,
                    bytes_total: total,
                });
            },
        )
    })
    .await
    .map_err(|_| HelperError::new(code::INTERNAL, "audio copy task failed", false))??;
    controller.close();
    session.shutdown();

    emit(&Event::ArtifactReady {
        version: PROTOCOL_VERSION,
        request_id: &request.request_id,
        session_id: request.session_id.as_deref(),
        track_id,
        path: output.to_str().unwrap_or_default(),
        codec: "vorbis",
        bitrate_kbps,
        duration_ms: item.duration_ms,
        bytes: written,
    });
    Ok(())
}
