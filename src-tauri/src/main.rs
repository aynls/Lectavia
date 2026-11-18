// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() -> std::process::ExitCode {
    #[cfg(feature = "mcp")]
    if std::env::args_os()
        .nth(1)
        .is_some_and(|arg| arg == "--mcp-stdio")
    {
        return lectavia_lib::run_mcp();
    }
    lectavia_lib::run();
    std::process::ExitCode::SUCCESS
}
