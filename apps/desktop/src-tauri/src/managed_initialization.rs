use std::{
    fmt, fs, io,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use chrono::{DateTime, FixedOffset};

const MAX_NAME_COLLISIONS: u32 = 10_000;
const MAX_MANAGED_REPOSITORY_NAME_BYTES: usize = 240;
const MAX_COLLISION_SUFFIX_BYTES: usize = 5;
const MAX_CLEANUP_QUARANTINE_COLLISIONS: u32 = 32;

static CLEANUP_QUARANTINE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug)]
pub(super) struct ManagedDirectoryClaim {
    pub(super) path: PathBuf,
    identity: DirectoryIdentity,
}

#[derive(Debug)]
pub(super) struct ClaimedDirectoryCleanupError {
    error: io::Error,
    pub(super) residual_path: Option<PathBuf>,
}

impl ClaimedDirectoryCleanupError {
    pub(super) fn with_residual(error: io::Error, residual_path: Option<PathBuf>) -> Self {
        Self {
            error,
            residual_path,
        }
    }
}

impl fmt::Display for ClaimedDirectoryCleanupError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.error.fmt(formatter)
    }
}

impl std::error::Error for ClaimedDirectoryCleanupError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.error)
    }
}

impl From<io::Error> for ClaimedDirectoryCleanupError {
    fn from(error: io::Error) -> Self {
        Self::with_residual(error, None)
    }
}

#[cfg(unix)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DirectoryIdentity {
    device: u64,
    inode: u64,
}

#[cfg(windows)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DirectoryIdentity {
    volume_serial: Option<u32>,
    file_index: Option<u64>,
}

#[cfg(not(any(unix, windows)))]
type DirectoryIdentity = PathBuf;

/// Builds a presentation-only name. Repository identity is never recovered from this value.
pub(super) fn managed_repository_name(
    selected_save: &Path,
    initialized_at: DateTime<FixedOffset>,
) -> String {
    let stem = selected_save
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("save");
    let timestamp = initialized_at.format("%Y-%m-%dT%H-%M-%S%.3f%z").to_string();
    let stem_byte_limit = MAX_MANAGED_REPOSITORY_NAME_BYTES
        .saturating_sub(timestamp.len())
        .saturating_sub(1)
        .saturating_sub(MAX_COLLISION_SUFFIX_BYTES);
    let safe_stem = filesystem_safe_stem(stem, stem_byte_limit);
    format!("{safe_stem}-{timestamp}")
}

fn filesystem_safe_stem(stem: &str, max_bytes: usize) -> String {
    let mut safe = String::new();
    for character in stem.chars() {
        let replacement = if character.is_alphanumeric() || matches!(character, '-' | '_' | '.') {
            character
        } else {
            '_'
        };
        if safe.len() + replacement.len_utf8() > max_bytes {
            break;
        }
        safe.push(replacement);
    }

    let safe = safe.trim_matches('.');
    if safe.is_empty() {
        "save".into()
    } else {
        safe.into()
    }
}

/// Claims a direct child without replacing or reusing an existing filesystem entry.
pub(super) fn claim_managed_repository_directory(
    root: &Path,
    base_name: &str,
) -> io::Result<ManagedDirectoryClaim> {
    for collision in 0..MAX_NAME_COLLISIONS {
        let candidate = if collision == 0 {
            root.join(base_name)
        } else {
            root.join(format!("{base_name}-{collision}"))
        };

        match fs::create_dir(&candidate) {
            Ok(()) => {
                let identity = match directory_identity(&candidate) {
                    Ok(identity) => identity,
                    Err(error) => {
                        let _ = fs::remove_dir(&candidate);
                        return Err(error);
                    }
                };
                return Ok(ManagedDirectoryClaim {
                    path: candidate,
                    identity,
                });
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }

    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate an unused managed repository name",
    ))
}

/// Removes only the exact directory identity returned by `claim_managed_repository_directory`.
pub(super) fn remove_claimed_directory(
    root: &Path,
    claimed: &ManagedDirectoryClaim,
) -> Result<(), ClaimedDirectoryCleanupError> {
    let canonical_root = fs::canonicalize(root)?;
    let claimed_parent = claimed
        .path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "claimed path has no parent"))?;
    if fs::canonicalize(claimed_parent)? != canonical_root {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "claimed repository is outside the managed root",
        )
        .into());
    }

    match fs::symlink_metadata(&claimed.path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "claimed repository is no longer an ordinary directory",
            )
            .into())
        }
        Ok(_) if directory_identity(&claimed.path)? != claimed.identity => Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "claimed repository identity has changed",
        )
        .into()),
        Ok(_) => remove_claimed_directory_after_atomic_detach(root, claimed),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn remove_claimed_directory_after_atomic_detach(
    root: &Path,
    claimed: &ManagedDirectoryClaim,
) -> Result<(), ClaimedDirectoryCleanupError> {
    let quarantine = atomically_detach_claim(root, claimed).map_err(|error| {
        ClaimedDirectoryCleanupError::with_residual(error, residual_path(None, &claimed.path))
    })?;
    let identity_matches = directory_identity(&quarantine)
        .map(|identity| identity == claimed.identity)
        .unwrap_or(false);
    if !identity_matches {
        let restore = restore_detached_claim(&quarantine, &claimed.path);
        let residual = residual_path(Some(&quarantine), &claimed.path);
        let error = match restore {
            Ok(()) => io::Error::new(
                io::ErrorKind::PermissionDenied,
                "claimed repository identity changed before cleanup",
            ),
            Err(restore_error) => io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!(
                    "claimed repository identity changed before cleanup; restoring the claimed path failed: {restore_error}"
                ),
            ),
        };
        return Err(ClaimedDirectoryCleanupError::with_residual(error, residual));
    }

    match fs::remove_dir_all(&quarantine) {
        Ok(()) => Ok(()),
        Err(error) => {
            let restore = restore_detached_claim(&quarantine, &claimed.path);
            let residual = residual_path(Some(&quarantine), &claimed.path);
            let error = match restore {
                Ok(()) => error,
                Err(restore_error) => io::Error::new(
                    error.kind(),
                    format!("{error}; restoring the claimed path failed: {restore_error}"),
                ),
            };
            Err(ClaimedDirectoryCleanupError::with_residual(error, residual))
        }
    }
}

fn residual_path(quarantine: Option<&Path>, claimed: &Path) -> Option<PathBuf> {
    quarantine
        .filter(|path| path_entry_exists(path))
        .map(Path::to_path_buf)
        .or_else(|| path_entry_exists(claimed).then(|| claimed.to_path_buf()))
}

fn path_entry_exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

fn atomically_detach_claim(root: &Path, claimed: &ManagedDirectoryClaim) -> io::Result<PathBuf> {
    for _ in 0..MAX_CLEANUP_QUARANTINE_COLLISIONS {
        let sequence = CLEANUP_QUARANTINE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let quarantine = root.join(format!(
            ".silksong-git-cleanup-{}-{sequence}",
            std::process::id()
        ));
        match rename_without_replacing(&claimed.path, &quarantine) {
            Ok(()) => return Ok(quarantine),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }

    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate an exclusive cleanup quarantine path",
    ))
}

fn restore_detached_claim(quarantine: &Path, claimed_path: &Path) -> io::Result<()> {
    rename_without_replacing(quarantine, claimed_path)
}

#[cfg(target_os = "linux")]
fn rename_without_replacing(from: &Path, to: &Path) -> io::Result<()> {
    use std::{
        ffi::CString,
        os::{raw::c_int, unix::ffi::OsStrExt},
    };

    const AT_FDCWD: c_int = -100;
    const RENAME_NOREPLACE: c_int = 1;

    let from = CString::new(from.as_os_str().as_bytes()).map_err(|_| {
        io::Error::new(io::ErrorKind::InvalidInput, "path contains an embedded NUL")
    })?;
    let to = CString::new(to.as_os_str().as_bytes()).map_err(|_| {
        io::Error::new(io::ErrorKind::InvalidInput, "path contains an embedded NUL")
    })?;

    unsafe extern "C" {
        fn renameat2(
            olddirfd: c_int,
            oldpath: *const std::ffi::c_char,
            newdirfd: c_int,
            newpath: *const std::ffi::c_char,
            flags: c_int,
        ) -> c_int;
    }

    // `RENAME_NOREPLACE` moves whichever directory entry is at `from` without ever replacing the
    // private quarantine destination. The identity check happens after this atomic detach, so a
    // replacement at the claimed path is never recursively removed through that path.
    let result = unsafe {
        renameat2(
            AT_FDCWD,
            from.as_ptr(),
            AT_FDCWD,
            to.as_ptr(),
            RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn rename_without_replacing(from: &Path, to: &Path) -> io::Result<()> {
    // Windows MoveFileEx, as used by std::fs::rename, fails when the destination already exists
    // because this call does not request MOVEFILE_REPLACE_EXISTING.
    fs::rename(from, to)
}

#[cfg(target_os = "macos")]
fn rename_without_replacing(from: &Path, to: &Path) -> io::Result<()> {
    use std::{
        ffi::CString,
        os::{
            raw::{c_int, c_uint},
            unix::ffi::OsStrExt,
        },
    };

    const AT_FDCWD: c_int = -2;
    const RENAME_EXCL: c_uint = 0x0004;

    let from = CString::new(from.as_os_str().as_bytes()).map_err(|_| {
        io::Error::new(io::ErrorKind::InvalidInput, "path contains an embedded NUL")
    })?;
    let to = CString::new(to.as_os_str().as_bytes()).map_err(|_| {
        io::Error::new(io::ErrorKind::InvalidInput, "path contains an embedded NUL")
    })?;

    unsafe extern "C" {
        fn renameatx_np(
            fromfd: c_int,
            from: *const std::ffi::c_char,
            tofd: c_int,
            to: *const std::ffi::c_char,
            flags: c_uint,
        ) -> c_int;
    }

    // Darwin's `RENAME_EXCL` is an atomic no-replace operation. Filesystems that do not support
    // the primitive return their native error, which keeps cleanup safely failed instead of
    // falling back to a replacing rename.
    let result =
        unsafe { renameatx_np(AT_FDCWD, from.as_ptr(), AT_FDCWD, to.as_ptr(), RENAME_EXCL) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(all(not(target_os = "linux"), not(target_os = "macos"), not(windows)))]
fn rename_without_replacing(_from: &Path, _to: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "this platform has no atomic no-replace rename primitive",
    ))
}

fn directory_identity(path: &Path) -> io::Result<DirectoryIdentity> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "claimed repository is not an ordinary directory",
        ));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;

        Ok(DirectoryIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }

    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;

        Ok(DirectoryIdentity {
            volume_serial: metadata.volume_serial_number(),
            file_index: metadata.file_index(),
        })
    }

    #[cfg(not(any(unix, windows)))]
    {
        fs::canonicalize(path)
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::atomic::{AtomicU64, Ordering},
    };

    use chrono::{FixedOffset, TimeZone, Timelike};

    use super::{
        claim_managed_repository_directory, managed_repository_name, remove_claimed_directory,
    };

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let sequence = TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "silksong-git-managed-init-{}-{sequence}",
                std::process::id()
            ));
            fs::create_dir(&path).expect("create test directory");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn names_are_safe_and_include_local_milliseconds_and_offset() {
        let timestamp = FixedOffset::east_opt(8 * 60 * 60)
            .expect("offset")
            .with_ymd_and_hms(2026, 8, 3, 14, 5, 6)
            .single()
            .expect("timestamp")
            .with_nanosecond(123_000_000)
            .expect("milliseconds");

        let name = managed_repository_name(Path::new("存档 slot:1.dat"), timestamp);

        assert_eq!(name, "存档_slot_1-2026-08-03T14-05-06.123+0800");
        assert!(!name.contains(':'));
        assert!(!name.contains('/'));
    }

    #[test]
    fn collision_allocation_never_overwrites_and_cleanup_is_bounded_to_claim() {
        let temp = TestDirectory::new();
        let base = temp.path().join("save-2026");
        fs::create_dir(&base).expect("pre-existing collision");

        let claimed = claim_managed_repository_directory(temp.path(), "save-2026")
            .expect("collision candidate");
        assert_eq!(claimed.path, temp.path().join("save-2026-1"));
        assert!(base.is_dir());

        remove_claimed_directory(temp.path(), &claimed).expect("remove claimed directory");
        assert!(base.is_dir());
        assert!(!claimed.path.exists());
    }

    #[test]
    fn replacement_directory_is_not_removed_after_the_claim_is_lost() {
        let temp = TestDirectory::new();
        let claimed =
            claim_managed_repository_directory(temp.path(), "save-2026").expect("claim directory");
        fs::remove_dir(&claimed.path).expect("remove original claim");
        fs::create_dir(&claimed.path).expect("replace claimed directory");
        fs::write(claimed.path.join("replacement"), b"keep me").expect("write replacement");

        assert!(remove_claimed_directory(temp.path(), &claimed).is_err());
        assert_eq!(
            fs::read(claimed.path.join("replacement")).expect("replacement survives"),
            b"keep me"
        );
    }
}
