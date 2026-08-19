//! Local cron scheduler (no listening port).
//!
//! Reads `cronExpr` (a 5-field expression: minute hour day-of-month month
//! day-of-week), `command` (a shell command line) and `workingDir` from
//! `config.extra`. A lightweight matcher supports `*`, `*/n` step values,
//! comma lists, `a-b` ranges and explicit numbers in each field.
//!
//! The scheduler wakes roughly every 30s, aligned to minute boundaries, and
//! runs the command (via `sh -c` / `cmd /C`) whenever the expression matches
//! the current local minute — at most once per minute. Command stdout/stderr
//! are streamed to the server log along with start/finish + exit code.

use std::process::Stdio;

use chrono::{Datelike, Local, Timelike};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use super::ServerConfig;
use super::engine::{ServerCtx, ServerStarted};

pub async fn start(ctx: ServerCtx, config: ServerConfig) -> Result<ServerStarted, String> {
    let expr = config.str_field("cronExpr", "").trim().to_string();
    if expr.is_empty() {
        return Err("cronExpr is required".to_string());
    }
    let command = config.str_field("command", "").trim().to_string();
    if command.is_empty() {
        return Err("command is required".to_string());
    }
    let working_dir = config.str_field("workingDir", "").to_string();

    // Validate the expression up-front so a bad schedule surfaces as a startup
    // error rather than silently never firing.
    let schedule = CronSchedule::parse(&expr)?;

    ctx.log.line(format!(
        "Cron scheduler started — '{}' runs: {}",
        command, expr
    ));

    let cancel = ctx.cancel.clone();
    let log = ctx.log.clone();
    let task = tokio::spawn(async move {
        // Track the last minute we fired on so a 30s tick can't double-run.
        let mut last_run_minute: Option<i64> = None;

        loop {
            let now = Local::now();
            if schedule.matches(&now) {
                let minute_id = now.timestamp() / 60;
                if last_run_minute != Some(minute_id) {
                    last_run_minute = Some(minute_id);
                    run_command(&command, &working_dir, &log).await;
                }
            }

            // Sleep until the next ~30s boundary, but wake promptly on cancel.
            let secs = now.second() as u64;
            let sleep_for = if secs < 30 { 30 - secs } else { 60 - secs };
            tokio::select! {
                _ = cancel.cancelled() => {
                    log.line("Cron scheduler stopping");
                    break;
                }
                _ = tokio::time::sleep(std::time::Duration::from_secs(sleep_for.max(1))) => {}
            }
        }
    });

    Ok(ServerStarted { pid: None, task })
}

/// Run the configured command through the platform shell, streaming output.
async fn run_command(command: &str, working_dir: &str, log: &super::engine::LogEmitter) {
    log.line(format!("Running: {}", command));

    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(command);
        c
    } else {
        let mut c = Command::new("sh");
        c.arg("-c").arg(command);
        c
    };

    if !working_dir.is_empty() {
        cmd.current_dir(working_dir);
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            log.line(format!("Failed to start command: {}", e));
            return;
        }
    };

    if let Some(stdout) = child.stdout.take() {
        let log = log.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log.line(line);
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let log = log.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log.line(line);
            }
        });
    }

    match child.wait().await {
        Ok(status) => {
            let code = status.code().unwrap_or(-1);
            log.line(format!("Command finished (exit code {})", code));
        }
        Err(e) => log.line(format!("Command wait error: {}", e)),
    }
}

/// A parsed 5-field cron schedule. Each field holds the set of values it
/// permits (already expanded from `*`, steps, ranges and lists).
struct CronSchedule {
    minute: FieldMatcher,
    hour: FieldMatcher,
    dom: FieldMatcher,
    month: FieldMatcher,
    dow: FieldMatcher,
}

impl CronSchedule {
    fn parse(expr: &str) -> Result<Self, String> {
        let fields: Vec<&str> = expr.split_whitespace().collect();
        if fields.len() != 5 {
            return Err(format!(
                "cron expression must have 5 fields, got {}",
                fields.len()
            ));
        }
        Ok(Self {
            minute: FieldMatcher::parse(fields[0], 0, 59)?,
            hour: FieldMatcher::parse(fields[1], 0, 23)?,
            dom: FieldMatcher::parse(fields[2], 1, 31)?,
            month: FieldMatcher::parse(fields[3], 1, 12)?,
            // Accept both 0 and 7 for Sunday; normalize 7 -> 0 in matching.
            dow: FieldMatcher::parse(fields[4], 0, 7)?,
        })
    }

    fn matches(&self, now: &chrono::DateTime<Local>) -> bool {
        let minute = now.minute() as u32;
        let hour = now.hour() as u32;
        let dom = now.day() as u32;
        let month = now.month() as u32;
        let dow = now.weekday().num_days_from_sunday() as u32; // 0=Sun

        // Allow 7 as Sunday in the expression in addition to 0.
        let dow_match = self.dow.contains(dow) || (dow == 0 && self.dow.contains(7));
        // Standard cron rule: when both DOM and DOW are restricted (neither is
        // `*`), a match on EITHER fires the job; otherwise both must match.
        let day_ok = if self.dom.is_wildcard || self.dow.is_wildcard {
            self.dom.contains(dom) && dow_match
        } else {
            self.dom.contains(dom) || dow_match
        };

        self.minute.contains(minute)
            && self.hour.contains(hour)
            && self.month.contains(month)
            && day_ok
    }
}

/// The set of allowed values for one cron field.
struct FieldMatcher {
    allowed: Vec<bool>, // index by value; len = max+1
    is_wildcard: bool,
}

impl FieldMatcher {
    fn parse(field: &str, min: u32, max: u32) -> Result<Self, String> {
        let mut allowed = vec![false; (max + 1) as usize];
        let is_wildcard = field == "*";

        for part in field.split(',') {
            let part = part.trim();
            if part.is_empty() {
                return Err(format!("empty cron field component in '{}'", field));
            }

            // Split off an optional "/step".
            let (range_part, step) = match part.split_once('/') {
                Some((r, s)) => {
                    let step: u32 = s
                        .parse()
                        .map_err(|_| format!("invalid step '{}' in '{}'", s, field))?;
                    if step == 0 {
                        return Err(format!("step cannot be zero in '{}'", field));
                    }
                    (r, step)
                }
                None => (part, 1),
            };

            // Determine the [start, end] range this component covers.
            let (start, end) = if range_part == "*" {
                (min, max)
            } else if let Some((a, b)) = range_part.split_once('-') {
                let a: u32 = a
                    .parse()
                    .map_err(|_| format!("invalid range start '{}' in '{}'", a, field))?;
                let b: u32 = b
                    .parse()
                    .map_err(|_| format!("invalid range end '{}' in '{}'", b, field))?;
                (a, b)
            } else {
                let v: u32 = range_part
                    .parse()
                    .map_err(|_| format!("invalid value '{}' in '{}'", range_part, field))?;
                (v, v)
            };

            if start < min || end > max || start > end {
                return Err(format!(
                    "value out of range [{}-{}] in cron field '{}'",
                    min, max, field
                ));
            }

            let mut v = start;
            while v <= end {
                allowed[v as usize] = true;
                v += step;
            }
        }

        Ok(Self {
            allowed,
            is_wildcard,
        })
    }

    fn contains(&self, value: u32) -> bool {
        self.allowed.get(value as usize).copied().unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> chrono::DateTime<Local> {
        Local.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap()
    }

    #[test]
    fn wildcard_matches_every_minute() {
        let s = CronSchedule::parse("* * * * *").unwrap();
        assert!(s.matches(&at(2026, 5, 30, 13, 7)));
    }

    #[test]
    fn step_minutes() {
        let s = CronSchedule::parse("*/15 * * * *").unwrap();
        assert!(s.matches(&at(2026, 5, 30, 1, 0)));
        assert!(s.matches(&at(2026, 5, 30, 1, 15)));
        assert!(!s.matches(&at(2026, 5, 30, 1, 16)));
    }

    #[test]
    fn explicit_minute_and_hour() {
        let s = CronSchedule::parse("30 9 * * *").unwrap();
        assert!(s.matches(&at(2026, 5, 30, 9, 30)));
        assert!(!s.matches(&at(2026, 5, 30, 10, 30)));
        assert!(!s.matches(&at(2026, 5, 30, 9, 31)));
    }

    #[test]
    fn lists_and_ranges() {
        let s = CronSchedule::parse("0 9-11,17 * * *").unwrap();
        for h in [9, 10, 11, 17] {
            assert!(s.matches(&at(2026, 5, 30, h, 0)), "hour {h} should match");
        }
        assert!(!s.matches(&at(2026, 5, 30, 12, 0)));
    }

    #[test]
    fn day_of_week_sunday_zero_or_seven() {
        // 2026-05-31 is a Sunday.
        let s0 = CronSchedule::parse("0 0 * * 0").unwrap();
        let s7 = CronSchedule::parse("0 0 * * 7").unwrap();
        let sunday = at(2026, 5, 31, 0, 0);
        assert!(s0.matches(&sunday));
        assert!(s7.matches(&sunday));
        // Saturday should not match a Sunday schedule.
        assert!(!s0.matches(&at(2026, 5, 30, 0, 0)));
    }

    #[test]
    fn dom_or_dow_semantics() {
        // When both restricted, match on EITHER. DOM=15 OR DOW=Mon(1).
        let s = CronSchedule::parse("0 0 15 * 1").unwrap();
        assert!(s.matches(&at(2026, 5, 15, 0, 0))); // 15th (a Friday)
        assert!(s.matches(&at(2026, 6, 1, 0, 0))); // a Monday, not the 15th
        assert!(!s.matches(&at(2026, 6, 2, 0, 0))); // Tuesday, not the 15th
    }

    #[test]
    fn rejects_bad_expressions() {
        assert!(CronSchedule::parse("* * * *").is_err()); // too few fields
        assert!(CronSchedule::parse("60 * * * *").is_err()); // minute out of range
        assert!(CronSchedule::parse("*/0 * * * *").is_err()); // zero step
        assert!(CronSchedule::parse("abc * * * *").is_err()); // non-numeric
    }
}
