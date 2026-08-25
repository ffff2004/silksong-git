use std::{fs, io, path::PathBuf};

use serde::{Deserialize, Serialize};

const DEFAULT_WATCHER_ACTIVITY_NOTIFICATIONS_ENABLED: bool = true;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppSettingsFile {
    #[serde(default = "default_watcher_activity_notifications_enabled")]
    watcher_activity_notifications_enabled: bool,
}

fn default_watcher_activity_notifications_enabled() -> bool {
    DEFAULT_WATCHER_ACTIVITY_NOTIFICATIONS_ENABLED
}

/// App-owned settings live outside every Save History Repository.
pub(crate) struct AppSettingsStore {
    path: PathBuf,
}

impl AppSettingsStore {
    pub(crate) fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub(crate) fn watcher_activity_notifications_enabled(&self) -> bool {
        fs::read_to_string(&self.path)
            .ok()
            .and_then(|contents| serde_json::from_str::<AppSettingsFile>(&contents).ok())
            .map(|settings| settings.watcher_activity_notifications_enabled)
            .unwrap_or(DEFAULT_WATCHER_ACTIVITY_NOTIFICATIONS_ENABLED)
    }

    pub(crate) fn set_watcher_activity_notifications_enabled(
        &self,
        enabled: bool,
    ) -> io::Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let contents = serde_json::to_vec_pretty(&AppSettingsFile {
            watcher_activity_notifications_enabled: enabled,
        })
        .map_err(io::Error::other)?;
        fs::write(&self.path, contents)
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, time::SystemTime};

    use super::AppSettingsStore;

    fn temporary_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "silksong-git-app-settings-{name}-{}",
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .expect("system clock is after the Unix epoch")
                .as_nanos()
        ))
    }

    #[test]
    fn missing_settings_default_to_enabled() {
        let path = temporary_path("missing");
        let store = AppSettingsStore::new(path.clone());

        assert!(store.watcher_activity_notifications_enabled());
        assert!(!path.exists());
    }

    #[test]
    fn setting_round_trips_outside_the_repository() {
        let directory = temporary_path("round-trip");
        let path = directory.join("settings.json");
        let store = AppSettingsStore::new(path.clone());

        store
            .set_watcher_activity_notifications_enabled(false)
            .expect("persist disabled setting");

        assert!(!AppSettingsStore::new(path.clone()).watcher_activity_notifications_enabled());
        assert!(path.is_file());
        fs::remove_dir_all(directory).expect("remove temporary settings directory");
    }

    #[test]
    fn malformed_settings_default_to_enabled() {
        let path = temporary_path("malformed");
        fs::write(&path, "not json").expect("write malformed settings");

        assert!(AppSettingsStore::new(path.clone()).watcher_activity_notifications_enabled());
        fs::remove_file(path).expect("remove malformed settings");
    }
}
