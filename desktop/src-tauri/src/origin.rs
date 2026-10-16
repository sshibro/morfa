//! Which addresses may load in a Morfa window (docs/desktop.md §Security).
//!
//! The window shows the hosted app (`https://app.morfa.example`, or the dev server `http://127.0.0.1:5400`) and,
//! for its links, the landing (`https://morfa.example`). Everything else opens in the system browser. Only the app's
//! origin gets the shell's IPC (lib.rs adds the capability for exactly this origin).

use url::Url;

/// Production app and landing.
pub const PRODUCTION_APP: &str = "https://app.morfa.example";
pub const PRODUCTION_LANDING: &str = "https://morfa.example";
/// The Vite dev servers (docs/dev.md §Ports).
pub const DEV_APP: &str = "http://127.0.0.1:5400";
pub const DEV_LANDING: &str = "http://127.0.0.1:5401";

/// The origins this build talks to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Origins {
    pub app: Url,
    pub landing: Url,
}

/// What to do with an address the window was asked to show.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Navigation {
    /// The app itself: load it in the window.
    App,
    /// The landing: load it in the window, without IPC.
    Landing,
    /// The bundled offline page and Tauri's own pages.
    Shell,
    /// Anything else on the web or mail: hand it to the system.
    External,
    /// Not a page at all (`file:`, `javascript:`, `data:` …): refuse.
    Refuse,
}

/// Parses an origin ("https://host[:port]"): scheme http or https, a host, no path, query or credentials.
pub fn parse_origin(text: &str) -> Result<Url, String> {
    let url =
        Url::parse(text.trim()).map_err(|error| format!("“{text}” is not an origin: {error}"))?;
    if !matches!(url.scheme(), "https" | "http") {
        return Err(format!("“{text}”: the origin must be http or https"));
    }
    if url.host_str().is_none_or(str::is_empty)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(format!(
            "“{text}”: the origin needs a host and no credentials"
        ));
    }
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err(format!(
            "“{text}”: an origin has no path, query or fragment"
        ));
    }
    // Plain http only for this machine: the dev server. A remote http origin would send the session cookie in clear.
    if url.scheme() == "http" && !is_loopback(&url) {
        return Err(format!(
            "“{text}”: http is allowed only for 127.0.0.1 / localhost"
        ));
    }
    Ok(url)
}

fn is_loopback(url: &Url) -> bool {
    matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
}

/// The landing that goes with an app origin: `app.<domain>` → `<domain>`, the dev app's port 5400 → 5401.
pub fn landing_for(app: &Url) -> Url {
    let mut landing = app.clone();
    if is_loopback(app) {
        if app.port() == Some(5400) {
            let _ = landing.set_port(Some(5401));
        }
        return landing;
    }
    if let Some(rest) = app.host_str().and_then(|host| host.strip_prefix("app.")) {
        let _ = landing.set_host(Some(rest));
    }
    landing
}

impl Origins {
    /// From the environment (`MORFA_APP_ORIGIN`, `MORFA_LANDING_ORIGIN`), then the build's own default:
    /// the dev server for a debug build, production otherwise.
    pub fn from_env(app: Option<&str>, landing: Option<&str>, debug: bool) -> Result<Self, String> {
        let app = parse_origin(
            app.filter(|text| !text.trim().is_empty())
                .unwrap_or(if debug { DEV_APP } else { PRODUCTION_APP }),
        )?;
        let landing = match landing.filter(|text| !text.trim().is_empty()) {
            Some(text) => parse_origin(text)?,
            None => landing_for(&app),
        };
        Ok(Self { app, landing })
    }

    /// The origin as the web sees it (`https://app.morfa.example`, no trailing slash).
    pub fn app_origin(&self) -> String {
        self.app.origin().ascii_serialization()
    }

    /// The URL pattern Tauri's capability matches the app's pages with.
    pub fn app_pattern(&self) -> String {
        format!("{}/*", self.app_origin())
    }

    /// The app at a hash route (`#designs`, `#design/<id>`).
    pub fn app_url(&self, hash: &str) -> Url {
        let mut url = self.app.clone();
        url.set_fragment(Some(hash.trim_start_matches('#')).filter(|hash| !hash.is_empty()));
        url
    }

    pub fn is_app(&self, url: &Url) -> bool {
        url.origin() == self.app.origin()
    }

    /// Decides what happens to `url` (lib.rs `on_navigation` and `on_new_window`).
    pub fn classify(&self, url: &Url) -> Navigation {
        if self.is_app(url) {
            return Navigation::App;
        }
        if url.origin() == self.landing.origin() {
            return Navigation::Landing;
        }
        match url.scheme() {
            // The bundled offline page: tauri://localhost on Linux/macOS, http(s)://tauri.localhost on Windows.
            "tauri" => Navigation::Shell,
            "http" | "https" if url.host_str() == Some("tauri.localhost") => Navigation::Shell,
            "about" if url.path() == "blank" => Navigation::Shell,
            "http" | "https" | "mailto" => Navigation::External,
            _ => Navigation::Refuse,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn production() -> Origins {
        Origins::from_env(None, None, false).unwrap()
    }

    #[test]
    fn defaults_follow_the_build() {
        let origins = production();
        assert_eq!(origins.app_origin(), "https://app.morfa.example");
        assert_eq!(origins.landing.as_str(), "https://morfa.example/");
        let dev = Origins::from_env(None, None, true).unwrap();
        assert_eq!(dev.app_origin(), "http://127.0.0.1:5400");
        assert_eq!(dev.landing.as_str(), "http://127.0.0.1:5401/");
        assert_eq!(dev.app_pattern(), "http://127.0.0.1:5400/*");
    }

    #[test]
    fn environment_overrides_and_validation() {
        let staging =
            Origins::from_env(Some("https://app.staging.morfa.example"), None, false).unwrap();
        assert_eq!(staging.landing.as_str(), "https://staging.morfa.example/");
        let both = Origins::from_env(
            Some("http://localhost:4400"),
            Some("http://localhost:4401"),
            false,
        )
        .unwrap();
        assert_eq!(both.landing.as_str(), "http://localhost:4401/");
        assert!(
            Origins::from_env(Some("  "), None, false).is_ok(),
            "blank means the default"
        );
        for bad in [
            "http://app.morfa.example",
            "ftp://x",
            "https://app.morfa.example/path",
            "https://u:p@app.morfa.example",
            "nonsense",
            "https://app.morfa.example/?q",
        ] {
            assert!(parse_origin(bad).is_err(), "{bad} must be refused");
        }
    }

    #[test]
    fn classifies_navigation() {
        let origins = production();
        let check = |text: &str| origins.classify(&Url::parse(text).unwrap());
        assert_eq!(
            check("https://app.morfa.example/#design/abc"),
            Navigation::App
        );
        assert_eq!(
            check("https://app.morfa.example/api/session"),
            Navigation::App
        );
        assert_eq!(check("https://morfa.example/pricing"), Navigation::Landing);
        assert_eq!(
            check("http://app.morfa.example/"),
            Navigation::External,
            "another scheme is another origin"
        );
        assert_eq!(
            check("https://app.morfa.example:8443/"),
            Navigation::External,
            "another port is another origin"
        );
        assert_eq!(
            check("https://evil.example/app.morfa.example"),
            Navigation::External
        );
        assert_eq!(
            check("https://app.morfa.example.evil.example/"),
            Navigation::External
        );
        assert_eq!(check("mailto:help@morfa.example"), Navigation::External);
        assert_eq!(check("tauri://localhost/index.html"), Navigation::Shell);
        assert_eq!(
            check("http://tauri.localhost/index.html"),
            Navigation::Shell
        );
        assert_eq!(check("file:///etc/passwd"), Navigation::Refuse);
        assert_eq!(check("javascript:alert(1)"), Navigation::Refuse);
        assert_eq!(check("data:text/html,hi"), Navigation::Refuse);
    }

    #[test]
    fn builds_app_urls() {
        let origins = production();
        assert_eq!(
            origins.app_url("#design/x1").as_str(),
            "https://app.morfa.example/#design/x1"
        );
        assert_eq!(
            origins.app_url("designs").as_str(),
            "https://app.morfa.example/#designs"
        );
        assert_eq!(origins.app_url("").as_str(), "https://app.morfa.example/");
    }
}
