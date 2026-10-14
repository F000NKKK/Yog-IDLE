//! The designer backend over HTTP, for checking the designers in a browser
//! (Playwright) without the Tauri shell: `POST /<command>` with the
//! command's arguments as JSON answers what `invoke` would.
//!
//! `cargo run --example designer_bridge` → http://127.0.0.1:1421
//! (`book-harness.html` talks to it).

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::Path;

use serde_json::{Value, json};
use yog_idle_tauri_lib::bench::{book, images};

fn answer(command: &str, args: &Value) -> Value {
    match command {
        "book_designer_render" => match serde_json::from_value::<book::BookArgs>(args["args"].clone()) {
            Ok(a) => serde_json::to_value(book::render(&a)).unwrap_or(Value::Null),
            Err(e) => json!({ "error": e.to_string() }),
        },
        "book_designer_close" => {
            book::close(args["path"].as_str().unwrap_or(""));
            Value::Null
        }
        "yui_image_preview" => {
            let path = args["path"].as_str().unwrap_or("");
            let source = args["source"].as_str().unwrap_or("");
            let size = args["size"].as_u64().unwrap_or(32) as u32;
            json!(images::preview(Path::new(path), source, size))
        }
        "yui_image_sources" => json!(images::candidates(Path::new(args["path"].as_str().unwrap_or("")))),
        "read_text" | "file_read" => json!(std::fs::read_to_string(args["path"].as_str().unwrap_or("")).ok()),
        "dir_list" => {
            let dir = args["path"].as_str().unwrap_or("");
            let entries: Vec<Value> = std::fs::read_dir(dir)
                .into_iter()
                .flatten()
                .flatten()
                .map(|e| {
                    let p = e.path();
                    json!({
                        "name": e.file_name().to_string_lossy(),
                        "path": p.to_string_lossy(),
                        "kind": if p.is_dir() { "dir" } else { "file" },
                    })
                })
                .collect();
            json!(entries)
        }
        "mod_manifest_read" => {
            let root = args["projectRoot"].as_str().unwrap_or("");
            let toml = std::fs::read_to_string(Path::new(root).join("yog.toml")).unwrap_or_default();
            let id = toml
                .lines()
                .find_map(|l| l.trim().strip_prefix("id").map(|r| r.trim_start_matches([' ', '=']).trim().trim_matches('"').to_string()));
            json!({ "fields": { "id": id } })
        }
        _ => Value::Null,
    }
}

fn main() {
    let listener = TcpListener::bind("127.0.0.1:1421").expect("port 1421");
    eprintln!("designer bridge on http://127.0.0.1:1421");
    for stream in listener.incoming().flatten() {
        let mut reader = BufReader::new(stream.try_clone().expect("stream"));
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() {
            continue;
        }
        let mut parts = line.split_whitespace();
        let method = parts.next().unwrap_or("").to_string();
        let command = parts.next().unwrap_or("/").trim_start_matches('/').to_string();
        let mut length = 0;
        loop {
            let mut h = String::new();
            if reader.read_line(&mut h).is_err() || h.trim().is_empty() {
                break;
            }
            if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                length = v.trim().parse().unwrap_or(0);
            }
        }
        let mut body = vec![0; length];
        let _ = reader.read_exact(&mut body);
        let reply = if method == "POST" {
            let args: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            answer(&command, &args).to_string()
        } else {
            String::new()
        };
        let mut out = stream;
        let _ = write!(
            out,
            "HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: *\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            reply.len(),
            reply
        );
    }
}
