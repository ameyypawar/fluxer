// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::manifest::LOCAL_APP_URL;
use crate::paths::{DESKTOP_DIR, ROOT};
use crate::proc::{PNPM_INSTALL_ENV, RunOptions, run_command};
use anyhow::{Context, Result, bail};
use std::env;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use url::Url;

const CANARY_APP_NAME: &str = "Fluxer Canary";
const CANARY_BUNDLE_ID: &str = "app.fluxer.canary";
const DEV_CANARY_APP_NAME: &str = "Fluxer Canary (Dev)";
const DEV_CANARY_BUNDLE_ID: &str = "app.fluxer.canary.dev";
const CANARY_RPC_PORT: u16 = 21864;
const MACOS_DEV_ELECTRON_PLIST_STRINGS: &[(&str, &str)] = &[
    ("CFBundleName", DEV_CANARY_APP_NAME),
    ("CFBundleDisplayName", DEV_CANARY_APP_NAME),
    ("CFBundleIdentifier", DEV_CANARY_BUNDLE_ID),
    (
        "NSMicrophoneUsageDescription",
        "Fluxer needs access to your microphone to enable voice chat features.",
    ),
    (
        "NSCameraUsageDescription",
        "Fluxer needs access to your camera to enable video chat features.",
    ),
    (
        "NSAppleEventsUsageDescription",
        "Fluxer needs access to Apple Events for automation features.",
    ),
    (
        "NSAudioCaptureUsageDescription",
        "Fluxer captures audio from the screen or window you choose to share.",
    ),
    (
        "NSScreenCaptureUsageDescription",
        "Fluxer captures the screen or window you choose to share.",
    ),
];

pub fn install_desktop() -> Result<()> {
    run_command(
        &["pnpm", "install", "--frozen-lockfile"],
        RunOptions {
            cwd: ROOT.as_path(),
            env: PNPM_INSTALL_ENV
                .iter()
                .map(|(k, v)| ((*k).to_owned(), Some((*v).to_owned())))
                .collect(),
            ..RunOptions::default()
        },
    )
    .map(drop)?;
    patch_macos_dev_electron_info_plist()
}

pub fn build_desktop(skip_native: bool) -> Result<()> {
    let env = vec![
        (
            "BUILD_CHANNEL".to_owned(),
            Some(env::var("BUILD_CHANNEL").unwrap_or_else(|_| "canary".to_owned())),
        ),
        (
            "FLUXER_SKIP_NATIVE".to_owned(),
            if skip_native {
                Some("true".to_owned())
            } else {
                None
            },
        ),
        (
            "PUBLIC_BUILD_VERSION".to_owned(),
            Some(env::var("PUBLIC_BUILD_VERSION").unwrap_or_else(|_| "dev".to_owned())),
        ),
        (
            "PUBLIC_RELEASE_CHANNEL".to_owned(),
            Some(env::var("PUBLIC_RELEASE_CHANNEL").unwrap_or_else(|_| "canary".to_owned())),
        ),
    ];
    run_command(
        &["pnpm", "build"],
        RunOptions {
            cwd: DESKTOP_DIR.as_path(),
            env,
            ..RunOptions::default()
        },
    )
    .map(drop)
}

pub fn typecheck_desktop() -> Result<()> {
    run_command(
        &["pnpm", "typecheck"],
        RunOptions {
            cwd: DESKTOP_DIR.as_path(),
            ..RunOptions::default()
        },
    )
    .map(drop)
}

pub fn electron_args(args: &[String]) -> Vec<String> {
    let mut runtime_args = Vec::new();
    if cfg!(target_os = "linux")
        && Path::new("/.dockerenv").exists()
        && env::var("FLUXER_ELECTRON_NO_SANDBOX").as_deref() != Ok("0")
    {
        runtime_args.push("--no-sandbox".to_owned());
    }
    runtime_args.extend(args.iter().cloned());
    runtime_args
}

pub fn electron_command(args: &[String], headless: bool) -> Vec<String> {
    let mut command = base_electron_command();
    command.extend(electron_args(args));
    if headless
        && cfg!(target_os = "linux")
        && env::var_os("DISPLAY").is_none()
        && crate::paths::which("xvfb-run").is_some()
    {
        let mut wrapped = vec!["xvfb-run".to_owned(), "-a".to_owned()];
        wrapped.extend(command);
        return wrapped;
    }
    command
}

fn base_electron_command() -> Vec<String> {
    if cfg!(target_os = "macos") && !Path::new("/.dockerenv").exists() {
        let electron_binary = dev_electron_binary_path();
        if electron_binary.is_file()
            && let Ok(launcher) = env::current_exe()
        {
            return disclaimed_electron_command(&launcher, &electron_binary);
        }
    }
    vec![
        "pnpm".to_owned(),
        "exec".to_owned(),
        "electron".to_owned(),
        ".".to_owned(),
    ]
}

fn disclaimed_electron_command(launcher: &Path, electron_binary: &Path) -> Vec<String> {
    vec![
        launcher.to_string_lossy().into_owned(),
        "desktop".to_owned(),
        "exec-disclaimed".to_owned(),
        electron_binary.to_string_lossy().into_owned(),
        ".".to_owned(),
    ]
}

pub fn smoke_build_desktop() -> Result<()> {
    install_desktop()?;
    build_desktop(true)?;
    let command = electron_command(
        &[
            "--fluxer-debug-info".to_owned(),
            format!("--fluxer-app-url={LOCAL_APP_URL}"),
        ],
        true,
    );
    let args: Vec<_> = command.iter().map(String::as_str).collect();
    run_command(
        &args,
        RunOptions {
            cwd: DESKTOP_DIR.as_path(),
            env: vec![("FLUXER_SKIP_NATIVE".to_owned(), Some("true".to_owned()))],
            ..RunOptions::default()
        },
    )
    .map(drop)
}

pub fn package_desktop(args: &[String]) -> Result<()> {
    build_desktop(false)?;
    let mut builder_args = vec![
        "pnpm".to_owned(),
        "exec".to_owned(),
        "electron-builder".to_owned(),
        "--dir".to_owned(),
        "--config".to_owned(),
        "electron-builder.config.cjs".to_owned(),
    ];
    builder_args.extend(args.iter().cloned());
    let refs: Vec<_> = builder_args.iter().map(String::as_str).collect();
    run_command(
        &refs,
        RunOptions {
            cwd: DESKTOP_DIR.as_path(),
            ..RunOptions::default()
        },
    )
    .map(drop)
}

pub fn run_desktop(app_url: &str, extra_args: &[String], build: bool) -> Result<()> {
    install_desktop()?;
    if build {
        build_desktop(false)?;
    }
    run_desktop_process(app_url, extra_args)
}

pub async fn run_desktop_canary(
    app_url: Option<&str>,
    extra_args: &[String],
    build: bool,
) -> Result<()> {
    ensure_host_macos()?;
    let app_url = resolve_desktop_canary_app_url(app_url).await?;
    stop_running_canary_on_host()?;
    install_desktop()?;
    if build {
        build_desktop(false)?;
    }
    println!("Starting {DEV_CANARY_APP_NAME} against {app_url}");
    run_desktop_process(&app_url, extra_args)
}

fn run_desktop_process(app_url: &str, extra_args: &[String]) -> Result<()> {
    patch_macos_dev_electron_info_plist()?;
    let mut args = vec![
        format!("--fluxer-app-url={app_url}"),
        "--fluxer-log-renderer-console".to_owned(),
    ];
    args.extend(extra_args.iter().cloned());
    let command = electron_command(&args, false);
    let refs: Vec<_> = command.iter().map(String::as_str).collect();
    run_command(
        &refs,
        RunOptions {
            cwd: DESKTOP_DIR.as_path(),
            env: vec![
                ("BUILD_CHANNEL".to_owned(), Some("canary".to_owned())),
                (
                    "PUBLIC_BUILD_VERSION".to_owned(),
                    Some(env::var("PUBLIC_BUILD_VERSION").unwrap_or_else(|_| "dev".to_owned())),
                ),
                (
                    "PUBLIC_RELEASE_CHANNEL".to_owned(),
                    Some(
                        env::var("PUBLIC_RELEASE_CHANNEL").unwrap_or_else(|_| "canary".to_owned()),
                    ),
                ),
            ],
            ..RunOptions::default()
        },
    )
    .map(drop)
}

fn patch_macos_dev_electron_info_plist() -> Result<()> {
    if !cfg!(target_os = "macos") || Path::new("/.dockerenv").exists() {
        return Ok(());
    }
    ensure_macos_dev_electron_bundle()?;
    let app_bundle = dev_electron_app_bundle_path();
    let info_plist = dev_electron_info_plist_path();

    let mut changed = false;
    for (key, value) in MACOS_DEV_ELECTRON_PLIST_STRINGS {
        changed |= set_or_add_plist_string(&info_plist, key, value)?;
    }

    if changed {
        println!(
            "Patched dev Electron Info.plist for macOS dev identity and capture permissions: {}",
            info_plist.display()
        );
    }
    if changed || !codesign_verify(&app_bundle) {
        codesign_ad_hoc(&app_bundle)?;
    }
    Ok(())
}

fn ensure_macos_dev_electron_bundle() -> Result<()> {
    if !cfg!(target_os = "macos") || Path::new("/.dockerenv").exists() {
        return Ok(());
    }
    if dev_electron_bundle_is_valid() {
        return Ok(());
    }
    let install_script = dev_electron_install_script_path();
    if !install_script.is_file() {
        bail!(
            "missing Electron install script at {}; run `pnpm dev:desktop:install` first",
            install_script.display()
        );
    }

    println!("Installing dev Electron.app for macOS...");
    install_macos_dev_electron_bundle(false)?;
    if dev_electron_bundle_is_valid() {
        return Ok(());
    }

    println!("Retrying dev Electron.app install without Electron download cache...");
    install_macos_dev_electron_bundle(true)?;
    if dev_electron_bundle_is_valid() {
        return Ok(());
    }
    bail!(
        "Electron install completed without creating a valid macOS app bundle; expected {}, {}, and {}",
        dev_electron_info_plist_path().display(),
        dev_electron_binary_path().display(),
        dev_electron_framework_versions_path().display()
    )
}

fn install_macos_dev_electron_bundle(force_no_cache: bool) -> Result<()> {
    reset_incomplete_dev_electron_dist()?;
    let mut env: Vec<_> = PNPM_INSTALL_ENV
        .iter()
        .map(|(key, value)| ((*key).to_owned(), Some((*value).to_owned())))
        .collect();
    env.extend([
        ("ELECTRON_OVERRIDE_DIST_PATH".to_owned(), None),
        ("ELECTRON_SKIP_BINARY_DOWNLOAD".to_owned(), None),
        ("npm_config_arch".to_owned(), None),
        ("npm_config_platform".to_owned(), None),
    ]);
    if force_no_cache {
        env.push(("force_no_cache".to_owned(), Some("true".to_owned())));
    } else {
        env.push(("force_no_cache".to_owned(), None));
    }
    run_command(
        &["node", "node_modules/electron/install.js"],
        RunOptions {
            cwd: DESKTOP_DIR.as_path(),
            env,
            ..RunOptions::default()
        },
    )
    .map(drop)
}

fn reset_incomplete_dev_electron_dist() -> Result<()> {
    let dist = dev_electron_dist_path();
    let metadata = match std::fs::symlink_metadata(&dist) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(error).with_context(|| format!("failed to inspect {}", dist.display()));
        }
    };
    if metadata.is_dir() {
        std::fs::remove_dir_all(&dist)
            .with_context(|| format!("failed to remove incomplete {}", dist.display()))
    } else {
        std::fs::remove_file(&dist)
            .with_context(|| format!("failed to remove incomplete {}", dist.display()))
    }
}

fn dev_electron_bundle_is_complete() -> bool {
    dev_electron_info_plist_path().is_file() && dev_electron_binary_path().is_file()
}

fn dev_electron_bundle_is_valid() -> bool {
    dev_electron_bundle_is_complete()
        && path_is_symlink(&dev_electron_framework_versions_path())
        && path_is_symlink(&dev_electron_framework_link_path("Electron Framework"))
        && path_is_symlink(&dev_electron_framework_link_path("Helpers"))
        && path_is_symlink(&dev_electron_framework_link_path("Libraries"))
        && path_is_symlink(&dev_electron_framework_link_path("Resources"))
}

fn path_is_symlink(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
}

fn dev_electron_app_bundle_path() -> PathBuf {
    dev_electron_dist_path().join("Electron.app")
}

fn dev_electron_dist_path() -> PathBuf {
    DESKTOP_DIR.join("node_modules/electron/dist")
}

fn dev_electron_info_plist_path() -> PathBuf {
    dev_electron_app_bundle_path().join("Contents/Info.plist")
}

fn dev_electron_binary_path() -> PathBuf {
    dev_electron_app_bundle_path().join("Contents/MacOS/Electron")
}

fn dev_electron_install_script_path() -> PathBuf {
    DESKTOP_DIR.join("node_modules/electron/install.js")
}

fn dev_electron_framework_versions_path() -> PathBuf {
    dev_electron_framework_path().join("Versions/Current")
}

fn dev_electron_framework_link_path(name: &str) -> PathBuf {
    dev_electron_framework_path().join(name)
}

fn dev_electron_framework_path() -> PathBuf {
    dev_electron_app_bundle_path().join("Contents/Frameworks/Electron Framework.framework")
}

fn set_or_add_plist_string(info_plist: &Path, key: &str, value: &str) -> Result<bool> {
    if read_plist_string(info_plist, key)?.as_deref() == Some(value) {
        return Ok(false);
    }
    if plist_key_exists(info_plist, key)? {
        run_plist_buddy(info_plist, &format!("Set :{key} {value}"))?;
    } else {
        run_plist_buddy(info_plist, &format!("Add :{key} string {value}"))?;
    }
    Ok(true)
}

fn plist_key_exists(info_plist: &Path, key: &str) -> Result<bool> {
    Ok(read_plist_string(info_plist, key)?.is_some())
}

fn read_plist_string(info_plist: &Path, key: &str) -> Result<Option<String>> {
    let output = Command::new("/usr/libexec/PlistBuddy")
        .args(["-c", &format!("Print :{key}")])
        .arg(info_plist)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .with_context(|| format!("failed to read {key} from {}", info_plist.display()))?;
    if !output.status.success() {
        return Ok(None);
    }
    Ok(Some(
        String::from_utf8_lossy(&output.stdout)
            .trim_end()
            .to_owned(),
    ))
}

fn run_plist_buddy(info_plist: &Path, command: &str) -> Result<()> {
    let output = Command::new("/usr/libexec/PlistBuddy")
        .args(["-c", command])
        .arg(info_plist)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .with_context(|| format!("failed to update {}", info_plist.display()))?;
    if output.status.success() {
        return Ok(());
    }
    bail!(
        "failed to update {}: {}",
        info_plist.display(),
        String::from_utf8_lossy(&output.stderr).trim_end()
    )
}

fn codesign_verify(app_bundle: &Path) -> bool {
    Command::new("codesign")
        .args(["--verify", "--deep", "--strict"])
        .arg(app_bundle)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn codesign_ad_hoc(app_bundle: &Path) -> Result<()> {
    println!("Re-signing dev Electron.app after macOS permission plist patch...");
    let output = Command::new("codesign")
        .args(["--force", "--deep", "--sign", "-"])
        .arg(app_bundle)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .with_context(|| format!("failed to re-sign {}", app_bundle.display()))?;
    if output.status.success() {
        return Ok(());
    }
    bail!(
        "failed to re-sign {}: {}",
        app_bundle.display(),
        String::from_utf8_lossy(&output.stderr).trim_end()
    )
}

fn ensure_host_macos() -> Result<()> {
    if !cfg!(target_os = "macos") || Path::new("/.dockerenv").exists() {
        bail!(
            "`desktop canary` is a host macOS workflow. Run it on the Mac host, not inside the devcontainer."
        );
    }
    Ok(())
}

pub async fn resolve_desktop_canary_app_url(app_url: Option<&str>) -> Result<String> {
    if let Some(app_url) = app_url {
        return normalize_desktop_app_url(app_url);
    }
    for key in [
        "FLUXER_DESKTOP_CANARY_APP_URL",
        "FLUXER_DESKTOP_APP_URL",
        "FLUXER_PUBLIC_URL",
    ] {
        if let Ok(value) = env::var(key) {
            let value = value.trim();
            if !value.is_empty()
                && !is_local_app_url(value)
                && public_app_url_is_reachable(value).await
            {
                return normalize_desktop_app_url(value);
            }
        }
    }
    if let Ok(public_url) = crate::tunnel::resolve_cloudflare_public_url(None)
        && public_app_url_is_reachable(&public_url).await
    {
        return normalize_desktop_app_url(&public_url);
    }
    Ok(LOCAL_APP_URL.to_owned())
}

fn normalize_desktop_app_url(raw: &str) -> Result<String> {
    let url = Url::parse(raw.trim()).with_context(|| format!("invalid desktop app URL: {raw}"))?;
    match url.scheme() {
        "http" | "https" => Ok(url.as_str().trim_end_matches('/').to_owned()),
        scheme => bail!("desktop app URL must use http or https, got {scheme}"),
    }
}

fn is_local_app_url(raw: &str) -> bool {
    normalize_desktop_app_url(raw)
        .map(|url| matches!(url.as_str(), LOCAL_APP_URL | "http://127.0.0.1:8088"))
        .unwrap_or(false)
}

async fn public_app_url_is_reachable(raw: &str) -> bool {
    let Ok(base_url) = normalize_desktop_app_url(raw) else {
        return false;
    };
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };
    client
        .get(format!("{base_url}/gateway/_health"))
        .send()
        .await
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

fn stop_running_canary_on_host() -> Result<()> {
    println!("Stopping any running {CANARY_APP_NAME} or {DEV_CANARY_APP_NAME} instance...");
    for bundle_id in [DEV_CANARY_BUNDLE_ID, CANARY_BUNDLE_ID] {
        run_best_effort(
            "osascript",
            &[
                "-e",
                &format!("tell application id \"{bundle_id}\" to quit"),
            ],
        );
    }
    for app_name in [DEV_CANARY_APP_NAME, CANARY_APP_NAME] {
        run_best_effort(
            "osascript",
            &["-e", &format!("tell application \"{app_name}\" to quit")],
        );
        run_best_effort("pkill", &["-TERM", "-x", app_name]);
    }
    terminate_rpc_port_processes(CANARY_RPC_PORT)?;
    Ok(())
}

fn run_best_effort(program: &str, args: &[&str]) {
    let _ = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

fn terminate_rpc_port_processes(port: u16) -> Result<()> {
    let mut pids = pids_listening_on_tcp_port(port)?;
    if pids.is_empty() {
        return Ok(());
    }
    kill_pids("-TERM", &pids)?;
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        thread::sleep(Duration::from_millis(250));
        pids = pids_listening_on_tcp_port(port)?;
        if pids.is_empty() {
            return Ok(());
        }
    }
    kill_pids("-KILL", &pids)
}

fn pids_listening_on_tcp_port(port: u16) -> Result<Vec<String>> {
    let output = Command::new("lsof")
        .args(["-ti", &format!("tcp:{port}")])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .context("failed to run lsof while stopping Fluxer Canary")?;
    if !output.status.success() {
        return Ok(Vec::new());
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .collect())
}

fn kill_pids(signal: &str, pids: &[String]) -> Result<()> {
    if pids.is_empty() {
        return Ok(());
    }
    let status = Command::new("kill")
        .arg(signal)
        .args(pids)
        .status()
        .context("failed to run kill while stopping Fluxer Canary")?;
    if status.success() {
        Ok(())
    } else {
        bail!(
            "failed to stop Fluxer Canary process(es): {}",
            pids.join(", ")
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_no_sandbox_only_by_container_policy() {
        let args = electron_args(&["--flag".to_owned()]);
        if cfg!(target_os = "linux")
            && Path::new("/.dockerenv").exists()
            && env::var("FLUXER_ELECTRON_NO_SANDBOX").as_deref() != Ok("0")
        {
            assert_eq!(args[0], "--no-sandbox");
        }
        assert!(args.contains(&"--flag".to_owned()));
    }

    #[test]
    fn normalizes_desktop_app_urls() {
        assert_eq!(
            normalize_desktop_app_url("https://dev.example.test/").unwrap(),
            "https://dev.example.test"
        );
        assert_eq!(
            normalize_desktop_app_url("http://localhost:8088").unwrap(),
            LOCAL_APP_URL
        );
        assert!(normalize_desktop_app_url("wss://dev.example.test").is_err());
    }

    #[test]
    fn disclaimed_electron_command_re_execs_through_the_launcher() {
        let command = disclaimed_electron_command(
            Path::new("/tmp/fluxer-dev"),
            Path::new("/tmp/Electron.app/Contents/MacOS/Electron"),
        );
        assert_eq!(
            command,
            vec![
                "/tmp/fluxer-dev",
                "desktop",
                "exec-disclaimed",
                "/tmp/Electron.app/Contents/MacOS/Electron",
                "."
            ]
        );
    }

    #[test]
    fn dev_electron_binary_path_points_inside_the_dev_bundle() {
        assert!(dev_electron_binary_path().ends_with(
            "fluxer_desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
        ));
    }

    #[test]
    fn dev_electron_plist_path_points_to_fluxer_desktop_electron_app() {
        assert!(dev_electron_info_plist_path().ends_with(
            "fluxer_desktop/node_modules/electron/dist/Electron.app/Contents/Info.plist"
        ));
    }

    #[test]
    fn dev_electron_install_script_path_points_to_electron_package() {
        assert!(
            dev_electron_install_script_path()
                .ends_with("fluxer_desktop/node_modules/electron/install.js")
        );
    }

    #[test]
    fn dev_electron_dist_path_points_to_electron_package_dist() {
        assert!(dev_electron_dist_path().ends_with("fluxer_desktop/node_modules/electron/dist"));
    }

    #[test]
    fn dev_electron_framework_versions_path_points_inside_electron_framework() {
        assert!(dev_electron_framework_versions_path().ends_with(
            "fluxer_desktop/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/Current"
        ));
    }

    #[test]
    fn macos_dev_electron_plist_strings_include_dev_identity() {
        assert!(MACOS_DEV_ELECTRON_PLIST_STRINGS.contains(&("CFBundleName", DEV_CANARY_APP_NAME)));
        assert!(
            MACOS_DEV_ELECTRON_PLIST_STRINGS
                .contains(&("CFBundleDisplayName", DEV_CANARY_APP_NAME))
        );
        assert!(
            MACOS_DEV_ELECTRON_PLIST_STRINGS
                .contains(&("CFBundleIdentifier", DEV_CANARY_BUNDLE_ID))
        );
    }

    #[test]
    fn dev_electron_usage_descriptions_include_audio_capture() {
        assert!(
            MACOS_DEV_ELECTRON_PLIST_STRINGS
                .iter()
                .any(|(key, _)| *key == "NSAudioCaptureUsageDescription")
        );
    }
}
