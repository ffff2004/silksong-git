use std::path::{Path, PathBuf};

/// Filesystem-free platform save-location hints. These are picker starting
/// points, never an authority to discover a Steam account or save slot.
pub(crate) struct SaveLocationCatalog;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SaveLocationPlatform {
    Linux,
    Macos,
    Windows,
    Other,
}

pub(crate) trait SaveLocationSystem {
    fn environment(&self, variable: &str) -> Option<PathBuf>;
    fn home_directory(&self) -> PathBuf;
    fn is_existing_directory(&self, path: &Path) -> bool;
}

impl SaveLocationCatalog {
    pub(crate) fn candidates(platform: SaveLocationPlatform) -> &'static [&'static str] {
        match platform {
            SaveLocationPlatform::Windows => {
                &["%USERPROFILE%/AppData/LocalLow/Team Cherry/Hollow Knight Silksong"]
            }
            SaveLocationPlatform::Macos => {
                &["$HOME/Library/Application Support/unity.Team-Cherry.Silksong"]
            }
            SaveLocationPlatform::Linux => &[
                "$HOME/.config/unity3d/Team Cherry/Hollow Knight Silksong",
                "$HOME/.local/share/Steam/steamapps/compatdata/1030300/pfx/drive_c/users/steamuser/AppData/LocalLow/Team Cherry/Hollow Knight Silksong",
                "$HOME/.steam/steam/steamapps/compatdata/1030300/pfx/drive_c/users/steamuser/AppData/LocalLow/Team Cherry/Hollow Knight Silksong",
                "$HOME/.var/app/com.valvesoftware.Steam/data/Steam/steamapps/compatdata/1030300/pfx/drive_c/users/steamuser/AppData/LocalLow/Team Cherry/Hollow Knight Silksong",
            ],
            SaveLocationPlatform::Other => &[],
        }
    }
}

/// Expands only the catalog's explicit variables and probes only those exact
/// directories. In particular, it does not scan Steam installations or slots.
pub(crate) fn initial_directory(
    platform: SaveLocationPlatform,
    system: &impl SaveLocationSystem,
) -> PathBuf {
    for candidate in SaveLocationCatalog::candidates(platform) {
        let Some(path) = expand_candidate(candidate, system) else {
            continue;
        };
        if system.is_existing_directory(&path) {
            return path;
        }
    }

    system.home_directory()
}

fn expand_candidate(candidate: &str, system: &impl SaveLocationSystem) -> Option<PathBuf> {
    if let Some(suffix) = candidate.strip_prefix("$HOME/") {
        return system.environment("HOME").map(|home| home.join(suffix));
    }
    if let Some(suffix) = candidate.strip_prefix("%USERPROFILE%/") {
        return system
            .environment("USERPROFILE")
            .map(|profile| profile.join(suffix));
    }

    Some(PathBuf::from(candidate))
}

#[cfg(test)]
mod tests {
    use std::{
        collections::BTreeMap,
        path::{Path, PathBuf},
    };

    use super::{SaveLocationCatalog, SaveLocationPlatform, SaveLocationSystem, initial_directory};

    struct FakeSystem {
        directories: Vec<PathBuf>,
        environment: BTreeMap<&'static str, PathBuf>,
        home: PathBuf,
    }

    impl SaveLocationSystem for FakeSystem {
        fn environment(&self, variable: &str) -> Option<PathBuf> {
            self.environment.get(variable).cloned()
        }

        fn home_directory(&self) -> PathBuf {
            self.home.clone()
        }

        fn is_existing_directory(&self, path: &Path) -> bool {
            self.directories
                .iter()
                .any(|directory| directory.as_path() == path)
        }
    }

    #[test]
    fn catalog_orders_platform_hints_without_slots_or_scans() {
        assert_eq!(
            SaveLocationCatalog::candidates(SaveLocationPlatform::Windows),
            ["%USERPROFILE%/AppData/LocalLow/Team Cherry/Hollow Knight Silksong"]
        );
        assert_eq!(
            SaveLocationCatalog::candidates(SaveLocationPlatform::Macos),
            ["$HOME/Library/Application Support/unity.Team-Cherry.Silksong"]
        );
        assert_eq!(
            SaveLocationCatalog::candidates(SaveLocationPlatform::Linux),
            [
                "$HOME/.config/unity3d/Team Cherry/Hollow Knight Silksong",
                "$HOME/.local/share/Steam/steamapps/compatdata/1030300/pfx/drive_c/users/steamuser/AppData/LocalLow/Team Cherry/Hollow Knight Silksong",
                "$HOME/.steam/steam/steamapps/compatdata/1030300/pfx/drive_c/users/steamuser/AppData/LocalLow/Team Cherry/Hollow Knight Silksong",
                "$HOME/.var/app/com.valvesoftware.Steam/data/Steam/steamapps/compatdata/1030300/pfx/drive_c/users/steamuser/AppData/LocalLow/Team Cherry/Hollow Knight Silksong",
            ]
        );
    }

    #[test]
    fn chooses_the_first_existing_expanded_hint() {
        let home = PathBuf::from("/home/player");
        let second = home.join(
            ".local/share/Steam/steamapps/compatdata/1030300/pfx/drive_c/users/steamuser/AppData/LocalLow/Team Cherry/Hollow Knight Silksong",
        );
        let system = FakeSystem {
            directories: vec![second.clone()],
            environment: BTreeMap::from([("HOME", home.clone())]),
            home,
        };

        assert_eq!(
            initial_directory(SaveLocationPlatform::Linux, &system),
            second
        );
    }

    #[test]
    fn falls_back_to_home_when_no_hint_exists_or_a_variable_is_missing() {
        let home = PathBuf::from("/Users/player");
        let system = FakeSystem {
            directories: vec![],
            environment: BTreeMap::new(),
            home: home.clone(),
        };

        assert_eq!(
            initial_directory(SaveLocationPlatform::Macos, &system),
            home
        );
    }
}
