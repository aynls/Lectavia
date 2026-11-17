fn main() {
    println!("cargo:rerun-if-changed=tauri.conf.json");
    let config: serde_json::Value =
        serde_json::from_str(include_str!("tauri.conf.json")).expect("invalid Tauri configuration");
    let identifier = config["identifier"]
        .as_str()
        .expect("missing app identifier");
    println!("cargo:rustc-env=LECTAVIA_APP_IDENTIFIER={identifier}");

    #[cfg(feature = "desktop")]
    tauri_build::build();
}
