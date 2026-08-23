//! Redis backend via `redis-rs` over a multiplexed async connection.

use redis::{Value, aio::MultiplexedConnection};
use serde_json::json;
use tokio::sync::Mutex as AsyncMutex;

use super::{DbConfig, DbHandle, RedisKeyEntry, RedisScanPage, RedisValue};

pub async fn connect(config: &DbConfig, password: Option<&str>) -> Result<DbHandle, String> {
    let scheme = if config.ssl { "rediss" } else { "redis" };
    let host = if config.host.contains(':') && !config.host.starts_with('[') {
        format!("[{}]", config.host)
    } else {
        config.host.clone()
    };
    let username = config.username.as_deref().filter(|u| !u.is_empty());
    let password = password.filter(|p| !p.is_empty());
    let auth = match (username, password) {
        (Some(user), Some(pass)) => {
            format!(
                "{}:{}@",
                urlencoding::encode(user),
                urlencoding::encode(pass)
            )
        }
        (Some(user), None) => format!("{}@", urlencoding::encode(user)),
        (None, Some(pass)) => format!(":{}@", urlencoding::encode(pass)),
        (None, None) => String::new(),
    };
    let url = format!(
        "{scheme}://{auth}{host}:{}/{}",
        config.port,
        config.db_index.unwrap_or(0)
    );
    let client = redis::Client::open(url).map_err(|e| format!("Redis open failed: {e}"))?;
    let conn = client
        .get_multiplexed_async_connection()
        .await
        .map_err(|e| format!("Redis connect failed: {e}"))?;
    Ok(DbHandle::Redis(AsyncMutex::new(conn)))
}

pub async fn ping(conn: &AsyncMutex<MultiplexedConnection>) -> Result<String, String> {
    let mut c = conn.lock().await;
    let pong: String = redis::cmd("PING")
        .query_async(&mut *c)
        .await
        .map_err(|e| format!("Redis ping failed: {e}"))?;
    Ok(format!("Redis connection OK ({pong})"))
}

pub async fn list_keys(
    conn: &AsyncMutex<MultiplexedConnection>,
    pattern: &str,
    cursor: &str,
    count: u64,
) -> Result<RedisScanPage, String> {
    let mut c = conn.lock().await;
    let pat = if pattern.is_empty() { "*" } else { pattern };
    let count = if count == 0 { 200 } else { count };
    let (next_cursor, keys): (String, Vec<String>) = redis::cmd("SCAN")
        .arg(cursor)
        .arg("MATCH")
        .arg(pat)
        .arg("COUNT")
        .arg(count)
        .query_async(&mut *c)
        .await
        .map_err(|e| format!("SCAN failed: {e}"))?;

    let mut entries = Vec::with_capacity(keys.len());
    for key in keys {
        // TYPE + TTL per key. A key can disappear between SCAN and here, in
        // which case TYPE returns "none" — keep it so the UI can prune.
        let kind: String = redis::cmd("TYPE")
            .arg(&key)
            .query_async(&mut *c)
            .await
            .unwrap_or_else(|_| "none".to_string());
        let ttl: i64 = redis::cmd("TTL")
            .arg(&key)
            .query_async(&mut *c)
            .await
            .unwrap_or(-1);
        entries.push(RedisKeyEntry { key, kind, ttl });
    }
    Ok(RedisScanPage {
        cursor: next_cursor,
        keys: entries,
    })
}

pub async fn get_key(
    conn: &AsyncMutex<MultiplexedConnection>,
    key: &str,
) -> Result<RedisValue, String> {
    let mut c = conn.lock().await;
    let kind: String = redis::cmd("TYPE")
        .arg(key)
        .query_async(&mut *c)
        .await
        .map_err(|e| format!("TYPE failed: {e}"))?;
    let ttl: i64 = redis::cmd("TTL")
        .arg(key)
        .query_async(&mut *c)
        .await
        .unwrap_or(-1);
    let encoding: Option<String> = redis::cmd("OBJECT")
        .arg("ENCODING")
        .arg(key)
        .query_async(&mut *c)
        .await
        .ok();
    let memory_usage: Option<i64> = redis::cmd("MEMORY")
        .arg("USAGE")
        .arg(key)
        .query_async(&mut *c)
        .await
        .ok();

    let value = match kind.as_str() {
        "string" => {
            let s: Option<String> = redis::cmd("GET")
                .arg(key)
                .query_async(&mut *c)
                .await
                .map_err(|e| format!("GET failed: {e}"))?;
            json!(s.unwrap_or_default())
        }
        "hash" => {
            let pairs: Vec<(String, String)> = redis::cmd("HGETALL")
                .arg(key)
                .query_async(&mut *c)
                .await
                .map_err(|e| format!("HGETALL failed: {e}"))?;
            json!(
                pairs
                    .into_iter()
                    .map(|(f, v)| json!([f, v]))
                    .collect::<Vec<_>>()
            )
        }
        "list" => {
            // Page the first 100 items; the UI fetches more via redis_exec.
            let items: Vec<String> = redis::cmd("LRANGE")
                .arg(key)
                .arg(0)
                .arg(99)
                .query_async(&mut *c)
                .await
                .map_err(|e| format!("LRANGE failed: {e}"))?;
            json!(items)
        }
        "set" => {
            let members: Vec<String> = redis::cmd("SMEMBERS")
                .arg(key)
                .query_async(&mut *c)
                .await
                .map_err(|e| format!("SMEMBERS failed: {e}"))?;
            json!(members)
        }
        "zset" => {
            let pairs: Vec<(String, String)> = redis::cmd("ZRANGE")
                .arg(key)
                .arg(0)
                .arg(-1)
                .arg("WITHSCORES")
                .query_async(&mut *c)
                .await
                .map_err(|e| format!("ZRANGE failed: {e}"))?;
            // pairs come back as [member, score]; emit [score, member] for the
            // UI's score-first two-column table.
            json!(
                pairs
                    .into_iter()
                    .map(|(member, score)| json!([score, member]))
                    .collect::<Vec<_>>()
            )
        }
        "stream" => {
            let value: Value = redis::cmd("XRANGE")
                .arg(key)
                .arg("-")
                .arg("+")
                .arg("COUNT")
                .arg(100)
                .query_async(&mut *c)
                .await
                .map_err(|e| format!("XRANGE failed: {e}"))?;
            stream_to_json(&value)
        }
        _ => json!(null),
    };

    Ok(RedisValue {
        kind,
        value,
        ttl,
        encoding,
        memory_usage,
    })
}

/// Convert an XRANGE reply into `[{id, fields: [[k,v],...]}, ...]`.
fn stream_to_json(value: &Value) -> serde_json::Value {
    let entries = match value {
        Value::Array(items) | Value::Set(items) => items,
        _ => return json!([]),
    };
    let mut out = Vec::new();
    for entry in entries {
        if let Value::Array(parts) = entry {
            if parts.len() == 2 {
                let id = value_to_string(&parts[0]).unwrap_or_default();
                let mut fields = Vec::new();
                if let Value::Array(kvs) = &parts[1] {
                    let mut iter = kvs.iter();
                    while let (Some(k), Some(v)) = (iter.next(), iter.next()) {
                        fields.push(json!([
                            value_to_string(k).unwrap_or_default(),
                            value_to_string(v).unwrap_or_default()
                        ]));
                    }
                }
                out.push(json!({ "id": id, "fields": fields }));
            }
        }
    }
    json!(out)
}

pub async fn set_key(
    conn: &AsyncMutex<MultiplexedConnection>,
    key: &str,
    kind: &str,
    value: serde_json::Value,
    ttl: Option<i64>,
) -> Result<(), String> {
    let mut c = conn.lock().await;
    match kind {
        "string" => {
            let s = value
                .as_str()
                .map(|s| s.to_string())
                .unwrap_or_else(|| value.to_string());
            redis::cmd("SET")
                .arg(key)
                .arg(s)
                .query_async::<()>(&mut *c)
                .await
                .map_err(|e| format!("SET failed: {e}"))?;
        }
        "hash" => {
            // Replace the whole hash: DEL then HSET field/value pairs.
            redis::cmd("DEL")
                .arg(key)
                .query_async::<i64>(&mut *c)
                .await
                .ok();
            let pairs = value
                .as_array()
                .ok_or("hash value must be an array of [field,value]")?;
            if !pairs.is_empty() {
                let mut cmd = redis::cmd("HSET");
                cmd.arg(key);
                for pair in pairs {
                    let p = pair.as_array().ok_or("hash entry must be [field,value]")?;
                    cmd.arg(json_str(&p[0]))
                        .arg(json_str(p.get(1).unwrap_or(&json!(""))));
                }
                cmd.query_async::<()>(&mut *c)
                    .await
                    .map_err(|e| format!("HSET failed: {e}"))?;
            }
        }
        "list" => {
            redis::cmd("DEL")
                .arg(key)
                .query_async::<i64>(&mut *c)
                .await
                .ok();
            let items = value.as_array().ok_or("list value must be an array")?;
            if !items.is_empty() {
                let mut cmd = redis::cmd("RPUSH");
                cmd.arg(key);
                for item in items {
                    cmd.arg(json_str(item));
                }
                cmd.query_async::<()>(&mut *c)
                    .await
                    .map_err(|e| format!("RPUSH failed: {e}"))?;
            }
        }
        "set" => {
            redis::cmd("DEL")
                .arg(key)
                .query_async::<i64>(&mut *c)
                .await
                .ok();
            let members = value.as_array().ok_or("set value must be an array")?;
            if !members.is_empty() {
                let mut cmd = redis::cmd("SADD");
                cmd.arg(key);
                for m in members {
                    cmd.arg(json_str(m));
                }
                cmd.query_async::<()>(&mut *c)
                    .await
                    .map_err(|e| format!("SADD failed: {e}"))?;
            }
        }
        "zset" => {
            redis::cmd("DEL")
                .arg(key)
                .query_async::<i64>(&mut *c)
                .await
                .ok();
            let pairs = value
                .as_array()
                .ok_or("zset value must be an array of [score,member]")?;
            if !pairs.is_empty() {
                let mut cmd = redis::cmd("ZADD");
                cmd.arg(key);
                for pair in pairs {
                    let p = pair.as_array().ok_or("zset entry must be [score,member]")?;
                    cmd.arg(json_str(&p[0]))
                        .arg(json_str(p.get(1).unwrap_or(&json!(""))));
                }
                cmd.query_async::<()>(&mut *c)
                    .await
                    .map_err(|e| format!("ZADD failed: {e}"))?;
            }
        }
        other => return Err(format!("Unsupported Redis value kind for set: {other}")),
    }
    if let Some(secs) = ttl {
        if secs > 0 {
            redis::cmd("EXPIRE")
                .arg(key)
                .arg(secs)
                .query_async::<i64>(&mut *c)
                .await
                .map_err(|e| format!("EXPIRE failed: {e}"))?;
        }
    }
    Ok(())
}

pub async fn del_key(conn: &AsyncMutex<MultiplexedConnection>, key: &str) -> Result<(), String> {
    let mut c = conn.lock().await;
    redis::cmd("DEL")
        .arg(key)
        .query_async::<i64>(&mut *c)
        .await
        .map_err(|e| format!("DEL failed: {e}"))?;
    Ok(())
}

pub async fn exec(
    conn: &AsyncMutex<MultiplexedConnection>,
    raw_command: &str,
) -> Result<String, String> {
    let parts = tokenize(raw_command);
    if parts.is_empty() {
        return Err("Empty command".into());
    }
    let mut c = conn.lock().await;
    let mut cmd = redis::cmd(&parts[0]);
    for arg in &parts[1..] {
        cmd.arg(arg);
    }
    let value: Value = cmd.query_async(&mut *c).await.map_err(|e| format!("{e}"))?;
    Ok(value_to_string(&value).unwrap_or_default())
}

fn json_str(v: &serde_json::Value) -> String {
    v.as_str()
        .map(|s| s.to_string())
        .unwrap_or_else(|| v.to_string())
}

/// Split a raw CLI line into tokens, honouring single/double quotes.
fn tokenize(input: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut has_token = false;
    for ch in input.chars() {
        match quote {
            Some(q) => {
                if ch == q {
                    quote = None;
                } else {
                    cur.push(ch);
                }
            }
            None => match ch {
                '\'' | '"' => {
                    quote = Some(ch);
                    has_token = true;
                }
                c if c.is_whitespace() => {
                    if has_token {
                        out.push(std::mem::take(&mut cur));
                        has_token = false;
                    }
                }
                c => {
                    cur.push(c);
                    has_token = true;
                }
            },
        }
    }
    if has_token {
        out.push(cur);
    }
    out
}

/// Render a RESP `Value` as the plain-text reply a CLI would print.
fn value_to_string(value: &Value) -> Option<String> {
    match value {
        Value::Nil => Some("(nil)".into()),
        Value::Int(i) => Some(i.to_string()),
        Value::BulkString(b) => Some(String::from_utf8_lossy(b).into_owned()),
        Value::SimpleString(s) => Some(s.clone()),
        Value::Okay => Some("OK".into()),
        Value::Double(d) => Some(d.to_string()),
        Value::Boolean(b) => Some(b.to_string()),
        Value::VerbatimString { text, .. } => Some(text.clone()),
        Value::BigNumber(n) => Some(String::from_utf8_lossy(n).into_owned()),
        Value::Array(items) | Value::Set(items) => Some(
            items
                .iter()
                .enumerate()
                .map(|(i, v)| format!("{}) {}", i + 1, value_to_string(v).unwrap_or_default()))
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        Value::Map(pairs) => Some(
            pairs
                .iter()
                .map(|(k, v)| {
                    format!(
                        "{} => {}",
                        value_to_string(k).unwrap_or_default(),
                        value_to_string(v).unwrap_or_default()
                    )
                })
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        Value::Attribute { data, .. } => value_to_string(data),
        Value::Push { data, .. } => Some(
            data.iter()
                .map(|v| value_to_string(v).unwrap_or_default())
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        Value::ServerError(e) => Some(format!(
            "(error) {} {}",
            e.code(),
            e.details().unwrap_or("")
        )),
        _ => None,
    }
}
