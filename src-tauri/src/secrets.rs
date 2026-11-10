//! Secrets that must survive a restart, kept out of the plain-text preference
//! store.
//!
//! The desktop app used to write the Postgres connection string and the session
//! signing secret into `preferences.json` / `auth-secret` in clear text. Both are
//! password-equivalent: the first hands over the database, the second lets anyone
//! who can read it mint a valid session cookie. A per-user AppData directory is
//! already less exposed than a world-readable file, but "less exposed" is not a
//! security boundary — malware running as the same user, a backup tool or a
//! copied profile all read it.
//!
//! On Windows the payload is encrypted with **DPAPI** (`CryptProtectData`),
//! which ties the ciphertext to the current Windows user. On other platforms
//! there is no equivalent per-user key without an extra dependency, so the file
//! is written with mode `0600` and the documentation says so plainly. The file
//! format is deliberately self-describing: a magic header distinguishes an
//! encrypted store from an accidental plain-text drop, and every read either
//! decrypts or fails closed.
//!
//! The map itself is JSON; encryption happens over the whole serialized map so
//! key names do not leak either.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Written before every payload. A file without it is not ours.
const MAGIC: &[u8] = b"NOEMA-SECRETS-1\n";

/// The encrypted secret map (or its plain-text, `0600` equivalent on Unix).
pub const FILE_NAME: &str = "secrets.bin";

/// A key/value map of password-equivalent values.
pub type Secrets = BTreeMap<String, String>;

pub fn path(data_dir: &Path) -> PathBuf {
    data_dir.join(FILE_NAME)
}

/// Read the secret store, or an empty map when the file does not exist yet.
///
/// A missing file is normal on first run. An *empty* file is not: `save()`
/// writes through a temporary file and renames it into place, so the only way
/// to observe a zero-byte `secrets.bin` is a crash (or external interference)
/// between the truncation and the write of an older in-place save. Returning an
/// empty map there would silently make the app generate a new auth secret
/// (signing everyone out) or forget the configured database (making a new
/// embedded one), and the same is true for any other *corrupt* file. All three
/// cases are surfaced as errors instead — fail closed.
pub fn load(data_dir: &Path) -> Result<Secrets, String> {
    let file = path(data_dir);
    let raw = match fs::read(&file) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Secrets::new());
        }
        Err(error) => return Err(format!("could not read {}: {error}", file.display())),
    };
    if raw.is_empty() {
        // An existing zero-byte file means the store was truncated but never
        // rewritten (a crash mid-save, historically). Fail closed: do NOT
        // return an empty store, which would silently drop the DB URL and
        // invalidate every session.
        return Err(format!(
            "{} is empty (truncated write?); refusing to treat it as a fresh store",
            file.display()
        ));
    }
    let payload = raw
        .strip_prefix(MAGIC)
        .ok_or_else(|| format!("{} does not look like a Noema secret store", file.display()))?;
    let cleartext = unprotect(payload)
        .map_err(|error| format!("could not decrypt {}: {error}", file.display()))?;
    serde_json::from_slice(&cleartext)
        .map_err(|error| format!("could not parse {}: {error}", file.display()))
}

/// Write the secret store. The parent directory is created if needed.
///
/// The write is atomic: the payload is written to a temporary file in the same
/// directory, fully flushed, and then renamed over `secrets.bin`. On POSIX
/// `rename` is atomic, so a reader either sees the complete old file or the
/// complete new one — a crash mid-save can no longer truncate or wipe the
/// store. On Windows `std::fs::rename` uses `MoveFileEx` with
/// `MOVEFILE_REPLACE_EXISTING`, which also replaces an existing destination;
/// the swap is as atomic as that API allows. The magic header on top of that
/// remains a second line of defence: any file short of it fails closed on the
/// next read.
pub fn save(data_dir: &Path, secrets: &Secrets) -> Result<(), String> {
    fs::create_dir_all(data_dir)
        .map_err(|error| format!("could not create {}: {error}", data_dir.display()))?;
    let cleartext = serde_json::to_vec(secrets)
        .map_err(|error| format!("could not encode secrets: {error}"))?;
    let protected =
        protect(&cleartext).map_err(|error| format!("could not encrypt secrets: {error}"))?;
    let file = path(data_dir);
    // Temp file in the *same directory* so the rename stays on one filesystem
    // (and therefore atomic on POSIX). A pid + random suffix keeps concurrent
    // or retried saves from clobbering each other's temp file.
    let temp = data_dir.join(format!(
        "{FILE_NAME}.tmp-{}-{}",
        std::process::id(),
        rand::random::<u32>()
    ));
    let mut handle = create_private_file(&temp)?;
    let write = handle
        .write_all(MAGIC)
        .and_then(|()| handle.write_all(&protected))
        .and_then(|()| handle.flush())
        .and_then(|()| handle.sync_all());
    if let Err(error) = write {
        let _ = fs::remove_file(&temp);
        return Err(format!("could not write {}: {error}", file.display()));
    }
    if let Err(error) = fs::rename(&temp, &file) {
        let _ = fs::remove_file(&temp);
        return Err(format!(
            "could not replace {} atomically: {error}",
            file.display()
        ));
    }
    restrict_permissions(&file)?;
    sync_directory(data_dir);
    Ok(())
}

/// Open (create) a file that only the current user can read on POSIX, by
/// passing mode `0600` at creation time — there is no window in which the temp
/// file has default permissions, and the renamed store inherits the same mode.
#[cfg(unix)]
fn create_private_file(file: &Path) -> Result<fs::File, String> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(file)
        .map_err(|error| format!("could not create {}: {error}", file.display()))
}

#[cfg(not(unix))]
fn create_private_file(file: &Path) -> Result<fs::File, String> {
    fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(file)
        .map_err(|error| format!("could not create {}: {error}", file.display()))
}

/// Best-effort durability for the rename itself: without a directory fsync a
/// crash shortly after a successful save can still leave the rename
/// unmaterialised on disk. Failure (e.g. an unsupported platform) is not
/// fatal — the file contents are already fsynced.
#[cfg(unix)]
fn sync_directory(dir: &Path) {
    if let Ok(handle) = fs::File::open(dir) {
        let _ = handle.sync_all();
    }
}

#[cfg(not(unix))]
fn sync_directory(_dir: &Path) {}

#[cfg(unix)]
fn restrict_permissions(file: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(file, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("could not restrict {}: {error}", file.display()))
}

#[cfg(not(unix))]
fn restrict_permissions(_file: &Path) -> Result<(), String> {
    // Windows has no POSIX mode bits. The file inherits the ACL of the app's
    // per-user data directory (`%APPDATA%\app.noema.desktop`), which by default
    // grants the current user, SYSTEM and Administrators. The payload itself is
    // DPAPI-encrypted, so losing that ACL is not a plain-text disclosure.
    Ok(())
}

#[cfg(windows)]
fn protect(cleartext: &[u8]) -> Result<Vec<u8>, String> {
    dpapi(cleartext, true)
}

#[cfg(windows)]
fn unprotect(ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    dpapi(ciphertext, false)
}

/// Call DPAPI in either direction: `CryptProtectData` or
/// `CryptUnprotectData`. Both take the same blob shape and both allocate their
/// output with `LocalAlloc`, so the caller owns it and must `LocalFree` it.
#[cfg(windows)]
fn dpapi(input: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    // DPAPI rejects a zero-length input; the JSON map is never empty, but a
    // clear error beats an opaque Win32 failure if that ever changes.
    if input.is_empty() {
        return Err("cannot protect an empty payload".to_string());
    }

    let source = CRYPT_INTEGER_BLOB {
        cbData: input.len() as u32,
        pbData: input.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };

    let ok = unsafe {
        if encrypt {
            CryptProtectData(
                &source,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            let mut description: *mut u16 = std::ptr::null_mut();
            let result = CryptUnprotectData(
                &source,
                &mut description,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            );
            if !description.is_null() {
                LocalFree(description.cast());
            }
            result
        }
    };

    if ok == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }

    let bytes =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    unsafe {
        LocalFree(output.pbData.cast());
    }
    Ok(bytes)
}

#[cfg(not(windows))]
fn protect(cleartext: &[u8]) -> Result<Vec<u8>, String> {
    Ok(cleartext.to_vec())
}

#[cfg(not(windows))]
fn unprotect(ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    Ok(ciphertext.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "noema-secrets-{label}-{}-{}",
            std::process::id(),
            rand::random::<u32>()
        ))
    }

    #[test]
    fn a_missing_store_is_empty_not_an_error() {
        let dir = temp_dir("missing");
        assert_eq!(load(&dir).expect("missing store"), Secrets::new());
        assert!(!path(&dir).exists());
    }

    #[test]
    fn secrets_round_trip() {
        let dir = temp_dir("roundtrip");
        let mut secrets = Secrets::new();
        secrets.insert(
            "databaseUrl".to_string(),
            "postgresql://noema:sup3r-secret@db.example.com:5432/noema".to_string(),
        );
        secrets.insert("authSecret".to_string(), "a".repeat(64));
        save(&dir, &secrets).expect("save");
        assert_eq!(load(&dir).expect("load"), secrets);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(windows)]
    #[test]
    fn the_windows_payload_does_not_contain_the_plain_text() {
        let dir = temp_dir("dpapi");
        let secret = "postgresql://noema:sup3r-secret@db.example.com:5432/noema";
        let mut secrets = Secrets::new();
        secrets.insert("databaseUrl".to_string(), secret.to_string());
        save(&dir, &secrets).expect("save");
        let raw = std::fs::read(path(&dir)).expect("read");
        assert!(
            !raw.windows(secret.len())
                .any(|window| window == secret.as_bytes()),
            "DPAPI ciphertext must not contain the connection string"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_corrupt_store_fails_closed() {
        let dir = temp_dir("corrupt");
        std::fs::create_dir_all(&dir).expect("dir");
        std::fs::write(path(&dir), b"not-a-secret-store").expect("write");
        let error = load(&dir).expect_err("must not silently become empty");
        assert!(error.contains("does not look like"), "{error}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_empty_existing_store_fails_closed() {
        let dir = temp_dir("empty");
        std::fs::create_dir_all(&dir).expect("dir");
        // Simulates a crash in the old truncate→write save window: the file
        // exists but is zero bytes. The pre-atomic-save `load()` returned an
        // empty store here, silently wiping the DB URL and invalidating every
        // session; it must error instead.
        std::fs::write(path(&dir), b"").expect("write");
        let error = load(&dir).expect_err("zero-byte store must not become an empty map");
        assert!(error.contains("is empty"), "{error}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_save_leaves_no_stray_temp_files() {
        let dir = temp_dir("stray-temp");
        let mut secrets = Secrets::new();
        secrets.insert("authSecret".to_string(), "a".repeat(64));
        save(&dir, &secrets).expect("save");
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .expect("dir")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name != FILE_NAME)
            .collect();
        assert!(leftovers.is_empty(), "stray files: {leftovers:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn a_saved_store_is_only_readable_by_the_owner() {
        let dir = temp_dir("mode");
        let mut secrets = Secrets::new();
        secrets.insert("authSecret".to_string(), "a".repeat(64));
        save(&dir, &secrets).expect("save");
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(path(&dir))
            .expect("metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "store must stay mode 0600");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_save_over_an_existing_store_keeps_its_contents_available() {
        // The old save() opened with truncate(true) before writing; if the
        // process died in that window the store was gone. With the temp+rename
        // save, the previous store stays intact until the new one is complete.
        let dir = temp_dir("replace");
        let mut secrets = Secrets::new();
        secrets.insert("authSecret".to_string(), "a".repeat(64));
        save(&dir, &secrets).expect("first save");
        secrets.insert("databaseUrl".to_string(), "postgresql://db".to_string());
        save(&dir, &secrets).expect("second save");
        assert_eq!(load(&dir).expect("load"), secrets);
        std::fs::remove_dir_all(&dir).ok();
    }
}
