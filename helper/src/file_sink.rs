//! Writes one decrypted Spotify Ogg Vorbis stream to a provider cache file.

use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

use crate::protocol::code;
use crate::session::HelperError;

/// Spotify prefixes Ogg Vorbis files with a private 0xa7-byte page (normalisation data).
pub const SPOTIFY_OGG_HEADER_END: u64 = 0xa7;
const COPY_BUFFER_BYTES: usize = 64 * 1024;

pub struct SinkLimits {
    pub first_data_timeout: Duration,
    pub stall_timeout: Duration,
}

/**
 * How the stream reaches its path. `Atomic` writes a hidden `.part` and renames
 * it when complete. `Growing` writes the final path in place so a player can
 * open it while it grows; `ready_bytes` of verified Ogg payload trigger `on_ready`.
 */
pub enum SinkMode {
    Atomic,
    Growing { ready_bytes: u64 },
}

/// Validate the requested output location before any network work starts.
pub fn prepare_output(output_path: &str) -> Result<(PathBuf, PathBuf), HelperError> {
    let output = PathBuf::from(output_path);
    let invalid = || HelperError::new(code::INVALID_REQUEST, "output path must be a new absolute .ogg file", false);
    if !output.is_absolute() || output.extension().and_then(|value| value.to_str()) != Some("ogg") {
        return Err(invalid());
    }
    let parent = output.parent().filter(|parent| parent.is_dir()).ok_or_else(invalid)?;
    if fs::symlink_metadata(&output).is_ok() {
        return Err(invalid());
    }
    let name = output.file_name().and_then(|value| value.to_str()).ok_or_else(invalid)?;
    Ok((output.clone(), parent.join(format!(".{name}.part"))))
}

/// Copy `reader` (already decrypted) into `part`, skipping Spotify's header,
/// verifying the Ogg capture pattern, then atomically publish `output`.
#[allow(clippy::too_many_arguments)]
pub fn write_ogg<R: Read>(
    mut reader: R,
    total_bytes: u64,
    output: &Path,
    part: &Path,
    mode: SinkMode,
    cancelled: &AtomicBool,
    limits: &SinkLimits,
    mut on_progress: impl FnMut(u64, u64),
    mut on_ready: impl FnMut(u64),
) -> Result<u64, HelperError> {
    let (target, ready_bytes) = match mode {
        SinkMode::Atomic => (part, None),
        SinkMode::Growing { ready_bytes } => (output, Some(ready_bytes.max(1))),
    };
    let result = copy_ogg(&mut reader, total_bytes, target, ready_bytes, cancelled, limits, &mut on_progress, &mut on_ready);
    match result {
        Ok(written) if target == output => Ok(written),
        Ok(written) => {
            fs::rename(part, output).map_err(|error| {
                let _ = fs::remove_file(part);
                HelperError::new(code::IO, format!("cannot publish audio file: {error}"), false)
            })?;
            Ok(written)
        }
        Err(error) => {
            let _ = fs::remove_file(target);
            Err(error)
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn copy_ogg<R: Read>(
    reader: &mut R,
    total_bytes: u64,
    part: &Path,
    ready_bytes: Option<u64>,
    cancelled: &AtomicBool,
    limits: &SinkLimits,
    on_progress: &mut impl FnMut(u64, u64),
    on_ready: &mut impl FnMut(u64),
) -> Result<u64, HelperError> {
    if total_bytes <= SPOTIFY_OGG_HEADER_END + 4 {
        return Err(HelperError::new(code::INVALID_AUDIO, "Spotify returned an empty audio file", false));
    }
    let mut file: File = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(part)
        .map_err(|error| HelperError::new(code::IO, format!("cannot create audio file: {error}"), false))?;

    let mut buffer = vec![0u8; COPY_BUFFER_BYTES];
    let mut position: u64 = 0;
    let mut written: u64 = 0;
    let mut verified = false;
    let mut announced = false;
    let mut head: Vec<u8> = Vec::with_capacity(COPY_BUFFER_BYTES);
    let started = Instant::now();
    let mut last_data = Instant::now();
    let mut last_report = Instant::now() - Duration::from_secs(1);

    while position < total_bytes {
        if cancelled.load(Ordering::Acquire) {
            return Err(HelperError::new(code::CANCELLED, "fetch cancelled", false));
        }
        let read = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) if matches!(error.kind(), io::ErrorKind::TimedOut | io::ErrorKind::Interrupted) => {
                let (limit, what) = if position == 0 {
                    (limits.first_data_timeout, "no audio data arrived")
                } else {
                    (limits.stall_timeout, "audio download stalled")
                };
                let since = if position == 0 { started } else { last_data };
                if since.elapsed() >= limit {
                    return Err(HelperError::new(code::TIMEOUT, what, true));
                }
                continue;
            }
            Err(error) => return Err(HelperError::new(code::NETWORK, format!("audio download failed: {error}"), true)),
        };
        last_data = Instant::now();
        let chunk_start = position;
        position += read as u64;
        // Drop the part of this chunk that still belongs to Spotify's private header.
        let skip = SPOTIFY_OGG_HEADER_END.saturating_sub(chunk_start).min(read as u64) as usize;
        let mut payload = &buffer[skip..read];
        if payload.is_empty() {
            continue;
        }
        if !verified {
            // A wrong key or format decrypts to noise; refuse it before writing anything.
            head.extend_from_slice(payload);
            if head.len() < 4 {
                continue;
            }
            if &head[..4] != b"OggS" {
                return Err(HelperError::new(
                    code::INVALID_AUDIO,
                    "decrypted audio is not an Ogg stream (audio key or format mismatch)",
                    false,
                ));
            }
            verified = true;
            payload = &head;
        }
        file.write_all(payload)
            .map_err(|error| HelperError::new(code::IO, format!("cannot write audio file: {error}"), false))?;
        written += payload.len() as u64;
        if ready_bytes.is_some_and(|threshold| written >= threshold) && !announced {
            // Unbuffered writes are already visible to other readers of the file.
            announced = true;
            on_ready(written);
        }
        if last_report.elapsed() >= Duration::from_millis(250) {
            last_report = Instant::now();
            on_progress(position, total_bytes);
        }
    }
    if position < total_bytes {
        return Err(HelperError::new(code::NETWORK, "audio download ended early", true));
    }
    if !verified {
        return Err(HelperError::new(code::INVALID_AUDIO, "Spotify returned no Ogg payload", false));
    }
    file.sync_all().map_err(|error| HelperError::new(code::IO, format!("cannot flush audio file: {error}"), false))?;
    if ready_bytes.is_some() && !announced {
        // A short track can finish before the threshold; it is ready now either way.
        on_ready(written);
    }
    on_progress(total_bytes, total_bytes);
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn limits() -> SinkLimits {
        SinkLimits { first_data_timeout: Duration::from_millis(50), stall_timeout: Duration::from_millis(50) }
    }

    fn fixture(payload: &[u8]) -> Vec<u8> {
        let mut data = vec![0xAAu8; SPOTIFY_OGG_HEADER_END as usize];
        data.extend_from_slice(payload);
        data
    }

    fn temp_paths(name: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("puros-spotify-sink-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let output = dir.join("track.ogg");
        let (output, part) = prepare_output(output.to_str().unwrap()).unwrap();
        (output, part)
    }

    /// Delivers data in small reads so the header boundary falls inside a chunk.
    struct Trickle(Cursor<Vec<u8>>, usize);
    impl Read for Trickle {
        fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
            let len = out.len().min(self.1);
            self.0.read(&mut out[..len])
        }
    }

    #[test]
    fn strips_spotify_header_and_publishes_atomically() {
        let (output, part) = temp_paths("ok");
        let payload = b"OggS\0rest-of-vorbis-stream".repeat(100);
        let data = fixture(&payload);
        let mut reports = Vec::new();
        let written = write_ogg(
            Trickle(Cursor::new(data.clone()), 4096),
            data.len() as u64,
            &output,
            &part,
            SinkMode::Atomic,
            &AtomicBool::new(false),
            &limits(),
            |done, total| reports.push((done, total)),
            |_| panic!("atomic mode never announces a growing file"),
        )
        .unwrap();
        assert_eq!(written, payload.len() as u64);
        assert_eq!(fs::read(&output).unwrap(), payload);
        assert!(!part.exists());
        assert_eq!(reports.last(), Some(&(data.len() as u64, data.len() as u64)));
    }

    #[test]
    fn rejects_non_ogg_payload_without_leaving_files() {
        let (output, part) = temp_paths("bad");
        let data = fixture(b"garbage-that-is-not-ogg-data");
        let error = write_ogg(Cursor::new(data.clone()), data.len() as u64, &output, &part, SinkMode::Atomic, &AtomicBool::new(false), &limits(), |_, _| {}, |_| {})
            .unwrap_err();
        assert_eq!(error.code, code::INVALID_AUDIO);
        assert!(!output.exists() && !part.exists());
    }

    #[test]
    fn honours_cancellation_and_short_streams() {
        let (output, part) = temp_paths("cancel");
        let data = fixture(b"OggS-data");
        let error = write_ogg(Cursor::new(data.clone()), data.len() as u64, &output, &part, SinkMode::Atomic, &AtomicBool::new(true), &limits(), |_, _| {}, |_| {})
            .unwrap_err();
        assert_eq!(error.code, code::CANCELLED);
        let error = write_ogg(Cursor::new(data.clone()), data.len() as u64 + 100, &output, &part, SinkMode::Atomic, &AtomicBool::new(false), &limits(), |_, _| {}, |_| {})
            .unwrap_err();
        assert_eq!(error.code, code::NETWORK);
        assert!(!output.exists() && !part.exists());
    }

    #[test]
    fn times_out_when_no_data_arrives() {
        struct Stalled;
        impl Read for Stalled {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                std::thread::sleep(Duration::from_millis(10));
                Err(io::Error::new(io::ErrorKind::TimedOut, "wait"))
            }
        }
        let (output, part) = temp_paths("stall");
        let error = write_ogg(Stalled, 10_000, &output, &part, SinkMode::Atomic, &AtomicBool::new(false), &limits(), |_, _| {}, |_| {}).unwrap_err();
        assert_eq!(error.code, code::TIMEOUT);
    }

    #[test]
    fn grows_the_final_path_in_place_and_announces_readiness_once() {
        let (output, part) = temp_paths("growing");
        let payload = b"OggS-vorbis-payload".repeat(2_000);
        let data = fixture(&payload);
        let mut ready_at = Vec::new();
        let mut visible_when_ready = false;
        let written = write_ogg(
            Trickle(Cursor::new(data.clone()), 1024),
            data.len() as u64,
            &output,
            &part,
            SinkMode::Growing { ready_bytes: 8_000 },
            &AtomicBool::new(false),
            &limits(),
            |_, _| {},
            |bytes| {
                ready_at.push(bytes);
                visible_when_ready = fs::metadata(&output).map(|m| m.len() >= 8_000).unwrap_or(false);
            },
        )
        .unwrap();
        assert_eq!(written, payload.len() as u64);
        assert_eq!(ready_at.len(), 1);
        assert!(ready_at[0] >= 8_000 && ready_at[0] < 9_100);
        assert!(visible_when_ready, "a reader must see the announced bytes");
        assert!(!part.exists());
        assert_eq!(fs::read(&output).unwrap(), payload);
    }

    #[test]
    fn announces_short_growing_files_at_completion_and_removes_failed_ones() {
        let (output, part) = temp_paths("growing-short");
        let data = fixture(b"OggS-short");
        let mut ready = 0;
        write_ogg(Cursor::new(data.clone()), data.len() as u64, &output, &part, SinkMode::Growing { ready_bytes: 1_000_000 },
            &AtomicBool::new(false), &limits(), |_, _| {}, |_| ready += 1).unwrap();
        assert_eq!(ready, 1);
        let _ = fs::remove_file(&output);
        let error = write_ogg(Cursor::new(data.clone()), data.len() as u64 + 50, &output, &part, SinkMode::Growing { ready_bytes: 1 },
            &AtomicBool::new(false), &limits(), |_, _| {}, |_| {}).unwrap_err();
        assert_eq!(error.code, code::NETWORK);
        assert!(!output.exists());
    }

    #[test]
    fn validates_output_paths() {
        assert!(prepare_output("relative.ogg").is_err());
        assert!(prepare_output("/tmp/no-such-dir-for-puros/x.ogg").is_err());
        assert!(prepare_output("/tmp/x.flac").is_err());
    }
}
