use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_notification::NotificationExt;

use crate::{
    MAIN_WINDOW_LABEL, app_settings,
    desktop_runtime::{WatcherActivityEvent, WatcherObservationReason, WatcherObservationStatus},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct WatcherNotification {
    always_notify: bool,
    body: &'static str,
    title: &'static str,
}

pub(crate) fn notify_watcher_activity<R: Runtime>(app: &AppHandle<R>, event: WatcherActivityEvent) {
    let notification = describe_event(event);
    if !should_notify(app, notification) {
        return;
    }

    if let Err(error) = app
        .notification()
        .builder()
        .title(notification.title)
        .body(notification.body)
        .show()
    {
        eprintln!("failed to send watcher activity notification: {error}");
    }
}

fn should_notify<R: Runtime>(app: &AppHandle<R>, notification: WatcherNotification) -> bool {
    let notifications_enabled = app_settings(app)
        .map(|settings| settings.watcher_activity_notifications_enabled())
        .unwrap_or(true);
    should_notify_with_state(
        notification,
        is_main_window_foreground(app),
        notifications_enabled,
    )
}

fn should_notify_with_state(
    notification: WatcherNotification,
    is_foreground: bool,
    notifications_enabled: bool,
) -> bool {
    notification.always_notify || (!is_foreground && notifications_enabled)
}

fn is_main_window_foreground<R: Runtime>(app: &AppHandle<R>) -> bool {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return true;
    };

    let Ok(is_visible) = window.is_visible() else {
        return true;
    };
    let Ok(is_focused) = window.is_focused() else {
        return true;
    };

    is_visible && is_focused
}

fn describe_event(event: WatcherActivityEvent) -> WatcherNotification {
    match event {
        WatcherActivityEvent::Failed { .. } => WatcherNotification {
            always_notify: true,
            body: "The save watcher stopped unexpectedly.",
            title: "Watching stopped",
        },
        WatcherActivityEvent::Observation {
            status: WatcherObservationStatus::Committed,
            ..
        } => WatcherNotification {
            always_notify: false,
            body: "A new save observation was committed.",
            title: "Save history updated",
        },
        WatcherActivityEvent::Observation {
            status: WatcherObservationStatus::Skipped,
            reason: Some(WatcherObservationReason::Unchanged),
            ..
        } => WatcherNotification {
            always_notify: false,
            body: "The save was unchanged, so no new observation was committed.",
            title: "Save unchanged",
        },
        WatcherActivityEvent::Observation {
            status: WatcherObservationStatus::Skipped,
            reason: Some(WatcherObservationReason::MinimumCommitInterval),
            ..
        } => WatcherNotification {
            always_notify: false,
            body: "The save changed too soon, so the observation was deferred.",
            title: "Save observation deferred",
        },
        WatcherActivityEvent::Observation {
            status: WatcherObservationStatus::WatcherError,
            reason: Some(WatcherObservationReason::StabilityTimeout),
            ..
        } => WatcherNotification {
            always_notify: false,
            body: "The save could not be read while it was still changing.",
            title: "Save watcher error",
        },
        WatcherActivityEvent::Observation {
            status: WatcherObservationStatus::WatcherError,
            ..
        } => WatcherNotification {
            always_notify: false,
            body: "The save watcher could not read the latest save safely.",
            title: "Save watcher error",
        },
        WatcherActivityEvent::Observation {
            status: WatcherObservationStatus::Skipped,
            ..
        } => WatcherNotification {
            always_notify: false,
            body: "The save observation was skipped.",
            title: "Save observation skipped",
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{describe_event, should_notify_with_state};
    use crate::desktop_runtime::{
        WatcherActivityEvent, WatcherObservationCause, WatcherObservationReason,
        WatcherObservationStatus,
    };

    #[test]
    fn describes_watcher_activity_with_distinct_titles() {
        let events = [
            WatcherActivityEvent::Observation {
                cause: WatcherObservationCause::Change,
                status: WatcherObservationStatus::Committed,
                reason: None,
            },
            WatcherActivityEvent::Observation {
                cause: WatcherObservationCause::Change,
                status: WatcherObservationStatus::Skipped,
                reason: Some(WatcherObservationReason::Unchanged),
            },
            WatcherActivityEvent::Observation {
                cause: WatcherObservationCause::Deferred,
                status: WatcherObservationStatus::Skipped,
                reason: Some(WatcherObservationReason::MinimumCommitInterval),
            },
            WatcherActivityEvent::Observation {
                cause: WatcherObservationCause::Change,
                status: WatcherObservationStatus::WatcherError,
                reason: Some(WatcherObservationReason::DecodeFailure),
            },
        ];

        let titles = events.map(|event| describe_event(event).title);

        assert_eq!(
            titles,
            [
                "Save history updated",
                "Save unchanged",
                "Save observation deferred",
                "Save watcher error",
            ]
        );
    }

    #[test]
    fn fatal_watcher_failure_always_notifies() {
        let notification = describe_event(WatcherActivityEvent::Failed {
            reason: crate::desktop_runtime::WatcherFailureReason::WatchBackendFailure,
        });

        assert!(notification.always_notify);
        assert_eq!(notification.title, "Watching stopped");
    }

    #[test]
    fn ordinary_notifications_require_background_and_enabled_settings() {
        let notification = describe_event(WatcherActivityEvent::Observation {
            cause: WatcherObservationCause::Change,
            status: WatcherObservationStatus::Committed,
            reason: None,
        });

        assert!(!should_notify_with_state(notification, true, true));
        assert!(!should_notify_with_state(notification, false, false));
        assert!(should_notify_with_state(notification, false, true));
    }

    #[test]
    fn fatal_notifications_ignore_window_state_and_settings() {
        let notification = describe_event(WatcherActivityEvent::Failed {
            reason: crate::desktop_runtime::WatcherFailureReason::WatchBackendFailure,
        });

        assert!(should_notify_with_state(notification, true, false));
    }
}
