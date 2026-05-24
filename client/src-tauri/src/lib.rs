#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![discover_spotifu_servers])
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

use mdns_sd::{ServiceDaemon, ServiceEvent};
use serde::Serialize;
use std::collections::HashMap;
use std::time::{Duration, Instant};

#[derive(Serialize, Clone)]
struct DiscoveredServer {
    name: String,
    host: String,
    port: u16,
}

#[tauri::command]
fn discover_spotifu_servers() -> Result<Vec<DiscoveredServer>, String> {
    let mdns = ServiceDaemon::new().map_err(|e| e.to_string())?;
    let receiver = mdns
        .browse("_spotifu._tcp.local.")
        .map_err(|e| e.to_string())?;

    let mut servers: HashMap<String, DiscoveredServer> = HashMap::new();
    let deadline = Instant::now() + Duration::from_secs(3);

    while Instant::now() < deadline {
        match receiver.recv_timeout(Duration::from_millis(200)) {
            Ok(ServiceEvent::ServiceResolved(info)) => {
                let host = info.get_hostname().trim_end_matches('.').to_string();
                let port = info.get_port();
                let key = format!("{}:{}", host, port);
                servers.insert(
                    key,
                    DiscoveredServer {
                        name: host.clone(),
                        host,
                        port,
                    },
                );
            }
            Ok(_) => {}
            Err(_) => {}
        }
    }

    mdns.shutdown().map_err(|e| e.to_string())?;
    Ok(servers.into_values().collect())
}
