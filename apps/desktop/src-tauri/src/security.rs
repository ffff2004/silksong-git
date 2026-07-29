use tauri::Url;

const DEV_SERVER_PORT: u16 = 1420;
const GITHUB_REPOSITORY_PATH: &str = "/ffff2004/silksong-git";
const STEAM_CLOUD_PATH: &str = "/account/remotestorageapp/";

pub(crate) fn is_allowed_navigation(url: &Url) -> bool {
    is_bundled_app_url(url) || (cfg!(dev) && is_dev_server_url(url))
}

pub(crate) fn is_allowed_external_url(url: &Url) -> bool {
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return false;
    }

    match url.host_str() {
        Some("hollowknight.wiki") => true,
        Some("github.com") => {
            url.path() == GITHUB_REPOSITORY_PATH
                || url
                    .path()
                    .strip_prefix(GITHUB_REPOSITORY_PATH)
                    .is_some_and(|suffix| suffix.starts_with('/'))
        }
        Some("store.steampowered.com") => {
            url.path() == STEAM_CLOUD_PATH
                && url.query_pairs().count() == 1
                && url
                    .query_pairs()
                    .any(|(key, value)| key == "appid" && value == "1030300")
        }
        _ => false,
    }
}

fn is_bundled_app_url(url: &Url) -> bool {
    url.port().is_none()
        && ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (matches!(url.scheme(), "http" | "https")
                && url.host_str() == Some("tauri.localhost")))
}

fn is_dev_server_url(url: &Url) -> bool {
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(DEV_SERVER_PORT)
        && url.username().is_empty()
        && url.password().is_none()
}

#[cfg(test)]
mod tests {
    use super::{is_allowed_external_url, is_allowed_navigation};
    use tauri::Url;

    fn url(value: &str) -> Url {
        Url::parse(value).expect("test URL should parse")
    }

    #[test]
    fn allows_bundled_app_origins() {
        assert!(is_allowed_navigation(&url("tauri://localhost/index.html")));
        assert!(is_allowed_navigation(&url(
            "http://tauri.localhost/index.html"
        )));
        assert!(is_allowed_navigation(&url(
            "https://tauri.localhost/index.html"
        )));
    }

    #[test]
    fn denies_remote_navigation_and_deceptive_app_origins() {
        for value in [
            "https://hollowknight.wiki/",
            "https://tauri.localhost.example/index.html",
            "https://tauri.localhost:444/index.html",
            "file:///tmp/index.html",
            "javascript:alert(1)",
        ] {
            assert!(!is_allowed_navigation(&url(value)), "{value}");
        }
    }

    #[cfg(dev)]
    #[test]
    fn development_allows_only_the_fixed_loopback_server() {
        assert!(is_allowed_navigation(&url("http://127.0.0.1:1420/")));
        for value in [
            "http://localhost:1420/",
            "http://127.0.0.1:1421/",
            "https://127.0.0.1:1420/",
            "http://user@127.0.0.1:1420/",
        ] {
            assert!(!is_allowed_navigation(&url(value)), "{value}");
        }
    }

    #[test]
    fn allows_only_current_external_link_targets() {
        for value in [
            "https://hollowknight.wiki/",
            "https://hollowknight.wiki/w/Bell_Beast#Location",
            "https://github.com/ffff2004/silksong-git",
            "https://github.com/ffff2004/silksong-git/issues/27",
            "https://store.steampowered.com/account/remotestorageapp/?appid=1030300",
        ] {
            assert!(is_allowed_external_url(&url(value)), "{value}");
        }
    }

    #[test]
    fn denies_broader_or_deceptive_external_urls() {
        for value in [
            "http://hollowknight.wiki/",
            "https://user@hollowknight.wiki/",
            "https://hollowknight.wiki:444/",
            "https://hollowknight.wiki.example/",
            "https://github.com/ffff2004/silksong-git-malicious",
            "https://github.com/other/repository",
            "https://store.steampowered.com/account/remotestorageapp/?appid=1030300&next=x",
            "https://store.steampowered.com/account/remotestorageapp/?appid=1",
            "https://store.steampowered.com/account/other/?appid=1030300",
            "javascript:alert(1)",
        ] {
            assert!(!is_allowed_external_url(&url(value)), "{value}");
        }
    }
}
