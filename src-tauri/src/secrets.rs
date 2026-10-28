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

/// Read the secret store, or an empty map when it does not exist yet.
///
/// A missing file is normal on first run. A *corrupt* file is not: returning an
/// empty map would silently make the app generate a new auth secret (signing
/// everyone out) or forget the configured database (making a new embedded one),
/// so it is surfaced as an error instead.
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
        return Ok(Secrets::new());
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
/// The file is replaced in place, not via a temporary file: on Windows
/// `std::fs::rename` cannot replace an existing destination, and a failed
/// rename would leave the old (still valid) file and a stray temp file. A
/// truncated write is detected on the next read by the magic header and fails
/// closed instead of being mistaken for an empty store.
pub fn save(data_dir: &Path, secrets: &Secrets) -> Result<(), String> {
    fs::create_dir_all(data_dir)
        .map_err(|error| format!("could not create {}: {error}", data_dir.display()))?;
    let cleartext = serde_json::to_vec(secrets)
        .map_err(|error| format!("could not encode secrets: {error}"))?;
    let protected =
        protect(&cleartext).map_err(|error| format!("could not encrypt secrets: {error}"))?;
    let file = path(data_dir);
    let mut handle = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&file)
        .map_err(|error| format!("could not write {}: {error}", file.display()))?;
    handle
        .write_all(MAGIC)
        .and_then(|()| handle.write_all(&protected))
        .and_then(|()| handle.sync_all())
        .map_err(|error| format!("could not write {}: {error}", file.display()))?;
    restrict_permissions(&file)?;
    Ok(())
}

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
}
