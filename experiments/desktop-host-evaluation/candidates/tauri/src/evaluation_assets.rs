use std::borrow::Cow;

use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};
use tauri::{App, Assets, Wry};

const SCRIPT_PATH: &str = "/__keiko_eval_ready.js";
const SCRIPT_TAG: &str = "<script src=\"/__keiko_eval_ready.js\" defer></script>";
const READY_SCRIPT: &[u8] = br#"
(() => {
  const trustedLocation =
    ((location.protocol === 'tauri:' && location.hostname === 'localhost') ||
      (location.protocol === 'http:' && location.hostname === 'tauri.localhost')) &&
    (location.pathname === '' || location.pathname === '/' ||
      location.pathname === '/index.html') &&
    location.search === '' && location.hash === '';
  if (!trustedLocation) return;
  const publishReady = () => setTimeout(() => {
    const shell = document.querySelector('main.shell');
    const bounds = shell?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0 ||
        getComputedStyle(shell).display === 'none') return;
    const bridge = window.__TAURI__?.core;
    if (typeof bridge?.invoke !== 'function') return;
    bridge.invoke('shell_snapshot', { evaluationReady: true }).catch(() => {});
  }, 34);
  if (document.readyState === 'complete') publishReady();
  else window.addEventListener('load', publishReady, { once: true });
})();
"#;

pub struct EvaluationAssets {
    embedded: Box<dyn Assets<Wry>>,
}

pub fn install(context: &mut tauri::Context<Wry>) {
    let embedded = std::mem::replace(&mut context.assets, Box::new(EmptyAssets));
    context.assets = Box::new(EvaluationAssets::new(embedded));
}

struct EmptyAssets;

impl Assets<Wry> for EmptyAssets {
    fn get(&self, _key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        None
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(std::iter::empty())
    }

    fn csp_hashes(&self, _html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}

impl EvaluationAssets {
    pub fn new(embedded: Box<dyn Assets<Wry>>) -> Self {
        Self { embedded }
    }
}

impl Assets<Wry> for EvaluationAssets {
    fn setup(&self, app: &App<Wry>) {
        self.embedded.setup(app);
    }

    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        match key.as_ref() {
            SCRIPT_PATH => Some(Cow::Borrowed(READY_SCRIPT)),
            "/index.html" => self.embedded.get(key).map(inject_script),
            _ => self.embedded.get(key),
        }
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(
            self.embedded
                .iter()
                .map(|(key, value)| {
                    if key == "/index.html" {
                        (key, inject_script(value))
                    } else {
                        (key, value)
                    }
                })
                .chain(std::iter::once((
                    Cow::Borrowed(SCRIPT_PATH),
                    Cow::Borrowed(READY_SCRIPT),
                ))),
        )
    }

    fn csp_hashes(&self, html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        self.embedded.csp_hashes(html_path)
    }
}

fn inject_script(html: Cow<'_, [u8]>) -> Cow<'_, [u8]> {
    let html = String::from_utf8_lossy(&html);
    Cow::Owned(
        html.replacen("</body>", &format!("{SCRIPT_TAG}</body>"), 1)
            .into_bytes(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn final_document_loads_the_exact_external_ready_script() {
        let html = inject_script(Cow::Borrowed(b"<body><p>shell</p></body>"));
        let html = String::from_utf8(html.into_owned()).unwrap();
        assert_eq!(html.matches(SCRIPT_TAG).count(), 1);
        assert!(String::from_utf8_lossy(READY_SCRIPT).contains("getBoundingClientRect"));
        let script = String::from_utf8_lossy(READY_SCRIPT);
        assert!(script.contains("if (!trustedLocation) return;"));
        assert!(script.contains("window.addEventListener('load'"));
        assert!(script.contains("}, 34);"));
    }
}
