//! RDP server input handler: injects client keyboard/mouse events into the
//! local desktop via `enigo`, the RemoteDesktop portal on Wayland, and native
//! CoreGraphics pointer events on macOS.
//!
//! ## Coordinates
//! [`MouseEvent::Move { x, y }`] carries coordinates in the advertised RDP
//! surface. On macOS that surface uses ScreenCaptureKit physical pixels while
//! CoreGraphics pointer events use global logical points, so [`MacInputMapping`]
//! scales and offsets absolute movement for Retina and secondary displays.
//!
//! ## Keyboard scancodes — the platform-specific part
//! RDP delivers PC/AT **Set 1** scancodes (`KeyboardEvent::Pressed { code, extended }`).
//! How those reach the OS differs by platform, so [`rdp_scancode_to_raw`] adapts:
//!   - **Windows**: `enigo.raw()` takes a scancode directly (`KEYEVENTF_SCANCODE`),
//!     so we pass the Set-1 code through (extended keys keep the `0xE0` prefix bit).
//!   - **X11/Linux**: `enigo.raw()` takes an *X11 keycode* = Linux evdev code + 8.
//!     RDP Set-1 codes equal evdev codes across the main block, so
//!     `x11_keycode = scancode + 8` is correct for ordinary keys; extended keys
//!     (arrows, Ctrl-right, etc.) need an explicit evdev remap.
//!   - **macOS**: `enigo.raw()` takes a CGKeyCode; we map the common keys and
//!     fall back to `enigo.key()` for the rest.
//!
//! `view_only` short-circuits all injection.

use std::collections::VecDeque;
#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Instant;

#[cfg(target_os = "macos")]
use core_foundation::base::TCFType;
#[cfg(target_os = "macos")]
use core_foundation::boolean::CFBoolean;
#[cfg(target_os = "macos")]
use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
#[cfg(target_os = "macos")]
use core_foundation::string::{CFString, CFStringRef};
use enigo::{
    Axis, Button, Coordinate, Direction,
    Direction::{Press, Release},
    Enigo, Key, Keyboard, Mouse, Settings,
};
#[cfg(target_os = "macos")]
use ironrdp::server::DesktopSize;
use ironrdp::server::{KeyboardEvent, MouseEvent, RdpServerInputHandler};
#[cfg(target_os = "macos")]
use objc2_core_foundation::{CFRetained, CGPoint};
#[cfg(target_os = "macos")]
use objc2_core_graphics::{
    CGEvent, CGEventField, CGEventSource, CGEventSourceStateID, CGEventTapLocation, CGEventType,
    CGMouseButton,
};

use super::ControlGate;
#[cfg(target_os = "linux")]
use super::capture::PortalInput;
use super::metrics::RdpMetrics;
use crate::servers::engine::LogEmitter;

/// A single input action to replay on the local desktop. Every field is plain
/// `Send` data (ints / `Copy` enums / `char`), so the command — and the
/// `Sender` that carries it — is `Send` on every platform.
enum InputCmd {
    Raw { code: u16, dir: Direction },
    Key { key: Key, dir: Direction },
    Button { button: Button, dir: Direction },
    MoveMouse { x: i32, y: i32, coord: Coordinate },
    Scroll { length: i32, axis: Axis },
}

impl InputCmd {
    fn is_mouse_move(&self) -> bool {
        matches!(self, Self::MoveMouse { .. })
    }
}

/// Timestamping is intentionally attached to the command rather than the
/// handler: it measures the full queueing delay before the thread-affine
/// Enigo actor applies the input event.
struct QueuedInput {
    received_at: Instant,
    cmd: InputCmd,
}

/// High-frequency mouse movement is advisory: only the most recent position
/// before the next key/button/scroll boundary matters. This queue collapses
/// consecutive moves, and has a soft bound for move traffic so a busy Windows
/// client cannot make macOS replay stale coordinates for seconds. Semantic
/// events are never discarded, even when the soft move bound is reached.
#[derive(Clone)]
struct InputQueue {
    inner: Arc<(Mutex<InputQueueState>, Condvar)>,
}

struct InputQueueState {
    commands: VecDeque<QueuedInput>,
    closed: bool,
}

enum InputQueuePush {
    Enqueued,
    Coalesced,
    DroppedMove,
    Closed,
}

const MAX_PENDING_INPUTS: usize = 128;

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
    static kAXTrustedCheckOptionPrompt: CFStringRef;
}

#[cfg(target_os = "macos")]
fn accessibility_permission(prompt: bool) -> bool {
    let key = unsafe { CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt) };
    let value = if prompt {
        CFBoolean::true_value()
    } else {
        CFBoolean::false_value()
    };
    let options = CFDictionary::from_CFType_pairs(&[(key, value)]);
    unsafe { AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef()) }
}

#[cfg(target_os = "macos")]
pub(crate) fn control_permission_granted() -> bool {
    accessibility_permission(false)
}

#[cfg(target_os = "macos")]
pub(crate) fn request_control_permission() -> bool {
    accessibility_permission(true)
}

#[cfg(target_os = "macos")]
#[derive(Clone, Debug)]
pub(crate) struct MacInputMapping {
    origin_x: f64,
    origin_y: f64,
    logical_width: f64,
    logical_height: f64,
    surface_size: Arc<AtomicU32>,
}

#[cfg(target_os = "macos")]
impl MacInputMapping {
    pub(crate) fn new(
        bounds: super::capture::mac::DisplayBounds,
        surface_size: Arc<AtomicU32>,
    ) -> anyhow::Result<Self> {
        if bounds.width == 0 || bounds.height == 0 {
            anyhow::bail!("selected display has invalid logical bounds");
        }
        let surface = unpack_surface_size(surface_size.load(Ordering::Relaxed));
        if surface.width == 0 || surface.height == 0 {
            anyhow::bail!("RDP input surface has invalid dimensions");
        }
        Ok(Self {
            origin_x: f64::from(bounds.x),
            origin_y: f64::from(bounds.y),
            logical_width: f64::from(bounds.width),
            logical_height: f64::from(bounds.height),
            surface_size,
        })
    }

    fn absolute_point(&self, x: u16, y: u16) -> CGPoint {
        let surface = unpack_surface_size(self.surface_size.load(Ordering::Relaxed));
        CGPoint {
            x: map_surface_coordinate(x, surface.width, self.origin_x, self.logical_width),
            y: map_surface_coordinate(y, surface.height, self.origin_y, self.logical_height),
        }
    }
}

#[cfg(target_os = "macos")]
fn unpack_surface_size(packed: u32) -> DesktopSize {
    DesktopSize {
        width: (packed >> 16) as u16,
        height: packed as u16,
    }
}

#[cfg(any(target_os = "macos", test))]
fn map_surface_coordinate(
    value: u16,
    surface_extent: u16,
    origin: f64,
    logical_extent: f64,
) -> f64 {
    let clamped = value.min(surface_extent.saturating_sub(1));
    origin + f64::from(clamped) * logical_extent / f64::from(surface_extent)
}

#[cfg(target_os = "macos")]
struct MacMouse {
    source: CFRetained<CGEventSource>,
    mapping: MacInputMapping,
    pressed: [bool; 3],
    clicks: [ClickState; 3],
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Default)]
struct ClickState {
    last_press: Option<Instant>,
    x: f64,
    y: f64,
    count: i64,
}

#[cfg(target_os = "macos")]
impl MacMouse {
    fn new(mapping: MacInputMapping) -> Result<Self, String> {
        let source = CGEventSource::new(CGEventSourceStateID::Private)
            .ok_or_else(|| "could not create CoreGraphics input event source".to_string())?;
        Ok(Self {
            source,
            mapping,
            pressed: [false; 3],
            clicks: [ClickState::default(); 3],
        })
    }

    fn current_point(&self) -> Result<CGPoint, String> {
        let event = CGEvent::new(Some(&self.source))
            .ok_or_else(|| "could not read the current macOS pointer position".to_string())?;
        Ok(CGEvent::location(Some(&event)))
    }

    fn absolute_move(&mut self, x: u16, y: u16) -> Result<(), String> {
        let target = self.mapping.absolute_point(x, y);
        self.post_move(target)
    }

    fn relative_move(&mut self, x: i32, y: i32) -> Result<(), String> {
        let current = self.current_point()?;
        self.post_move(CGPoint {
            x: current.x + f64::from(x),
            y: current.y + f64::from(y),
        })
    }

    fn post_move(&mut self, target: CGPoint) -> Result<(), String> {
        let current = self.current_point()?;
        let (event_type, button) = if self.pressed[0] {
            (CGEventType::LeftMouseDragged, CGMouseButton::Left)
        } else if self.pressed[1] {
            (CGEventType::RightMouseDragged, CGMouseButton::Right)
        } else if self.pressed[2] {
            (CGEventType::OtherMouseDragged, CGMouseButton::Center)
        } else {
            (CGEventType::MouseMoved, CGMouseButton::Left)
        };
        let event = CGEvent::new_mouse_event(Some(&self.source), event_type, target, button)
            .ok_or_else(|| "could not create macOS pointer movement event".to_string())?;
        CGEvent::set_integer_value_field(
            Some(&event),
            CGEventField::MouseEventDeltaX,
            (target.x - current.x).round() as i64,
        );
        CGEvent::set_integer_value_field(
            Some(&event),
            CGEventField::MouseEventDeltaY,
            (target.y - current.y).round() as i64,
        );
        CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&event));
        Ok(())
    }

    fn button(&mut self, button: Button, direction: Direction) -> Result<(), String> {
        if direction == Direction::Click {
            self.button(button, Direction::Press)?;
            return self.button(button, Direction::Release);
        }
        let (index, cg_button, down_type, up_type) = match button {
            Button::Left => (
                0,
                CGMouseButton::Left,
                CGEventType::LeftMouseDown,
                CGEventType::LeftMouseUp,
            ),
            Button::Right => (
                1,
                CGMouseButton::Right,
                CGEventType::RightMouseDown,
                CGEventType::RightMouseUp,
            ),
            Button::Middle => (
                2,
                CGMouseButton::Center,
                CGEventType::OtherMouseDown,
                CGEventType::OtherMouseUp,
            ),
            _ => return Err("unsupported macOS pointer button".to_string()),
        };
        let point = self.current_point()?;
        let pressed = direction == Direction::Press;
        let click_count = if pressed {
            let state = &mut self.clicks[index];
            let repeated = state.last_press.is_some_and(|last| {
                last.elapsed() <= std::time::Duration::from_millis(500)
                    && (state.x - point.x).abs() <= 4.0
                    && (state.y - point.y).abs() <= 4.0
            });
            state.count = if repeated {
                state.count.saturating_add(1)
            } else {
                1
            };
            state.last_press = Some(Instant::now());
            state.x = point.x;
            state.y = point.y;
            state.count
        } else {
            self.clicks[index].count.max(1)
        };
        let event = CGEvent::new_mouse_event(
            Some(&self.source),
            if pressed { down_type } else { up_type },
            point,
            cg_button,
        )
        .ok_or_else(|| "could not create macOS pointer button event".to_string())?;
        CGEvent::set_integer_value_field(
            Some(&event),
            CGEventField::MouseEventClickState,
            click_count,
        );
        if index == 2 {
            CGEvent::set_integer_value_field(Some(&event), CGEventField::MouseEventButtonNumber, 2);
        }
        CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&event));
        self.pressed[index] = pressed;
        Ok(())
    }
}

impl InputQueue {
    fn new() -> Self {
        Self {
            inner: Arc::new((
                Mutex::new(InputQueueState {
                    commands: VecDeque::new(),
                    closed: false,
                }),
                Condvar::new(),
            )),
        }
    }

    fn push(&self, queued: QueuedInput) -> InputQueuePush {
        let (lock, wake) = &*self.inner;
        let Ok(mut state) = lock.lock() else {
            return InputQueuePush::Closed;
        };
        if state.closed {
            return InputQueuePush::Closed;
        }

        if queued.cmd.is_mouse_move()
            && state
                .commands
                .back()
                .is_some_and(|last| last.cmd.is_mouse_move())
        {
            *state.commands.back_mut().expect("tail checked above") = queued;
            wake.notify_one();
            return InputQueuePush::Coalesced;
        }

        if queued.cmd.is_mouse_move() && state.commands.len() >= MAX_PENDING_INPUTS {
            return InputQueuePush::DroppedMove;
        }

        state.commands.push_back(queued);
        wake.notify_one();
        InputQueuePush::Enqueued
    }

    fn recv(&self) -> Option<QueuedInput> {
        let (lock, wake) = &*self.inner;
        let mut state = lock.lock().ok()?;
        loop {
            if let Some(queued) = state.commands.pop_front() {
                return Some(queued);
            }
            if state.closed {
                return None;
            }
            state = wake.wait(state).ok()?;
        }
    }

    fn close(&self) {
        let (lock, wake) = &*self.inner;
        if let Ok(mut state) = lock.lock() {
            state.closed = true;
            state.commands.clear();
        }
        wake.notify_all();
    }
}

/// RDP server input handler.
///
/// `Enigo` is **not `Send`** on macOS (it holds a `CGEventSource`, a thread-affine
/// `NonNull` pointer), yet `RdpServerInputHandler: Send` and `ironrdp-server`
/// actually moves the handler onto `spawn_blocking` worker threads. Wrapping the
/// `Enigo` in a `Mutex` does *not* help — `Mutex<T>: Send` still requires
/// `T: Send`. So instead of holding the `Enigo` directly, we own it on a single
/// dedicated thread (the actor) and keep only an [`InputQueue`] here.
/// `InputQueue` is `Send`, which makes `RdpInput`
/// `Send` uniformly across platforms — no `unsafe impl Send`, no per-OS `cfg`.
/// As a bonus, all CGEvent posting happens on one consistent thread.
pub(crate) struct RdpInput {
    log: LogEmitter,
    view_only: bool,
    /// `None` if enigo failed to initialize (no display / no permission) or the
    /// actor thread has exited; we log once and then silently drop input.
    tx: Option<InputQueue>,
    warned: bool,
    control_gate: Option<std::sync::Arc<ControlGate>>,
    metrics: RdpMetrics,
}

impl RdpInput {
    pub(crate) fn new(
        log: LogEmitter,
        view_only: bool,
        control_gate: Option<std::sync::Arc<ControlGate>>,
        metrics: RdpMetrics,
        #[cfg(target_os = "linux")] portal_tx: Option<mpsc::SyncSender<PortalInput>>,
        #[cfg(target_os = "macos")] mapping: Option<MacInputMapping>,
    ) -> Self {
        let tx = if view_only {
            None
        } else {
            Self::spawn_actor(
                &log,
                metrics.clone(),
                #[cfg(target_os = "linux")]
                portal_tx,
                #[cfg(target_os = "macos")]
                mapping,
            )
        };
        Self {
            log,
            view_only,
            tx,
            warned: false,
            control_gate,
            metrics,
        }
    }

    /// Spawn the dedicated input thread that owns the `Enigo`. Returns the
    /// command sender, or `None` if enigo could not be initialized (no display
    /// / no accessibility permission) — in which case the connection stays
    /// view-only. `Enigo::new` runs *inside* the thread because the resulting
    /// value is `!Send` on macOS and so cannot be constructed here and moved in.
    fn spawn_actor(
        log: &LogEmitter,
        metrics: RdpMetrics,
        #[cfg(target_os = "linux")] portal_tx: Option<mpsc::SyncSender<PortalInput>>,
        #[cfg(target_os = "macos")] mapping: Option<MacInputMapping>,
    ) -> Option<InputQueue> {
        let tx = InputQueue::new();
        let rx = tx.clone();
        // Bootstrap channel: the thread reports back whether `Enigo::new`
        // succeeded so `new()` can decide view-only vs interactive synchronously.
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
        let actor_log = log.clone();

        let spawned = std::thread::Builder::new()
            .name("rdp-input".to_string())
            .spawn(move || {
                let settings = Settings {
                    #[cfg(target_os = "macos")]
                    open_prompt_to_get_permissions: false,
                    ..Settings::default()
                };
                #[cfg(target_os = "linux")]
                let mut enigo = if portal_tx.is_some() {
                    None
                } else {
                    match Enigo::new(&settings) {
                        Ok(e) => Some(e),
                        Err(e) => {
                            let _ = ready_tx.send(Err(e.to_string()));
                            return;
                        }
                    }
                };
                #[cfg(not(target_os = "linux"))]
                let mut enigo = match Enigo::new(&settings) {
                    Ok(e) => e,
                    Err(e) => {
                        let _ = ready_tx.send(Err(e.to_string()));
                        return;
                    }
                };
                #[cfg(target_os = "macos")]
                let mut mac_mouse = match mapping
                    .ok_or_else(|| "macOS input display mapping is unavailable".to_string())
                    .and_then(MacMouse::new)
                {
                    Ok(mouse) => mouse,
                    Err(error) => {
                        let _ = ready_tx.send(Err(error));
                        return;
                    }
                };
                let _ = ready_tx.send(Ok(()));
                drop(ready_tx);
                #[cfg(target_os = "macos")]
                let mut permission_checked_at = Instant::now();

                // Drain commands until the server drops the queue on shutdown.
                while let Some(queued) = rx.recv() {
                    metrics.record_input_handoff(queued.received_at);
                    #[cfg(target_os = "macos")]
                    if permission_checked_at.elapsed() >= std::time::Duration::from_secs(1) {
                        if !control_permission_granted() {
                            actor_log.line(
                                "input injection stopped: macOS Accessibility permission was revoked",
                            );
                            rx.close();
                            break;
                        }
                        permission_checked_at = Instant::now();
                    }
                    #[cfg(target_os = "linux")]
                    let result = if let Some(portal_tx) = &portal_tx {
                        input_cmd_to_portal(queued.cmd)
                            .ok_or_else(|| "unsupported input command for Wayland portal".to_string())
                            .and_then(|input| {
                                portal_tx
                                    .send(input)
                                    .map_err(|_| "Wayland portal input channel closed".to_string())
                            })
                    } else {
                        match enigo.as_mut() {
                            Some(enigo) => apply(
                                enigo,
                                #[cfg(target_os = "macos")]
                                &mut mac_mouse,
                                queued.cmd,
                            ),
                            None => Err("input backend was not initialized".to_string()),
                        }
                    };
                    #[cfg(not(target_os = "linux"))]
                    let result = apply(
                        &mut enigo,
                        #[cfg(target_os = "macos")]
                        &mut mac_mouse,
                        queued.cmd,
                    );
                    if let Err(error) = result {
                        actor_log.line(format!("input injection stopped: {error}"));
                        rx.close();
                        break;
                    }
                    metrics.report_if_due();
                }
            });

        if let Err(e) = spawned {
            log.line(format!(
                "input injection unavailable (cannot start input thread: {e}); connection will be view-only"
            ));
            return None;
        }

        match ready_rx.recv() {
            Ok(Ok(())) => Some(tx),
            Ok(Err(e)) => {
                log.line(format!(
                    "input injection unavailable ({e}); connection will be view-only"
                ));
                None
            }
            Err(_) => {
                // Thread died before reporting — treat as unavailable.
                log.line("input injection unavailable (input thread exited during init); connection will be view-only");
                None
            }
        }
    }

    fn warn_if_missing(&mut self) {
        if !self.view_only && self.tx.is_none() && !self.warned {
            self.warned = true;
            self.log.line("input dropped: no injection backend");
        }
    }

    /// Send one command to the actor thread. Drops the sender (and warns once)
    /// if the actor has exited so a dead thread doesn't silently swallow input.
    fn send(&mut self, cmd: InputCmd) {
        if self.view_only {
            return;
        }
        self.warn_if_missing();
        if self.tx.is_none() {
            return;
        }
        if self
            .control_gate
            .as_ref()
            .is_some_and(|gate| !gate.ensure_approved())
        {
            return;
        }
        if let Some(tx) = &self.tx {
            match tx.push(QueuedInput {
                received_at: Instant::now(),
                cmd,
            }) {
                InputQueuePush::Enqueued => {}
                InputQueuePush::Coalesced => self.metrics.record_input_coalesced(),
                InputQueuePush::DroppedMove => self.metrics.record_input_dropped(),
                InputQueuePush::Closed => {
                    // Actor thread is gone; stop trying and warn once.
                    self.tx = None;
                    self.warned = false;
                    self.warn_if_missing();
                }
            }
        }
    }

    fn sync_lock_keys(&mut self, flags: ironrdp::pdu::input::fast_path::SynchronizeFlags) {
        use ironrdp::pdu::input::fast_path::SynchronizeFlags;
        // RDP Set-1 scancodes for lock keys.
        const SC_CAPS: u8 = 0x3A;
        const SC_NUM: u8 = 0x45;
        const SC_SCROLL: u8 = 0x46;
        for (flag, sc) in [
            (SynchronizeFlags::CAPS_LOCK, SC_CAPS),
            (SynchronizeFlags::NUM_LOCK, SC_NUM),
            (SynchronizeFlags::SCROLL_LOCK, SC_SCROLL),
        ] {
            if flags.contains(flag) {
                if let Some(raw) = rdp_scancode_to_raw(sc, false) {
                    self.send(InputCmd::Raw {
                        code: raw,
                        dir: Press,
                    });
                    self.send(InputCmd::Raw {
                        code: raw,
                        dir: Release,
                    });
                }
            }
        }
    }
}

impl Drop for RdpInput {
    fn drop(&mut self) {
        if let Some(tx) = &self.tx {
            tx.close();
        }
    }
}

#[cfg(target_os = "linux")]
fn input_cmd_to_portal(cmd: InputCmd) -> Option<PortalInput> {
    match cmd {
        // Enigo's Linux raw key API takes X11 keycodes (evdev + 8), while the
        // RemoteDesktop portal takes Linux evdev keycodes directly.
        InputCmd::Raw { code, dir } => Some(PortalInput::Keycode {
            code: i32::from(code.saturating_sub(8)),
            pressed: dir == Press,
        }),
        InputCmd::Key {
            key: Key::Unicode(ch),
            dir,
        } => Some(PortalInput::Keysym {
            keysym: unicode_to_keysym(ch),
            pressed: dir == Press,
        }),
        InputCmd::Key { .. } => None,
        InputCmd::Button { button, dir } => Some(PortalInput::Button {
            button: match button {
                Button::Left => 0x110,
                Button::Right => 0x111,
                Button::Middle => 0x112,
                Button::Back => 0x116,
                Button::Forward => 0x115,
                _ => return None,
            },
            pressed: dir == Press,
        }),
        InputCmd::MoveMouse { x, y, coord } => match coord {
            Coordinate::Abs => Some(PortalInput::MotionAbsolute {
                x: f64::from(x),
                y: f64::from(y),
            }),
            Coordinate::Rel => Some(PortalInput::MotionRelative {
                dx: f64::from(x),
                dy: f64::from(y),
            }),
        },
        InputCmd::Scroll { length, axis } => Some(PortalInput::Scroll {
            horizontal: axis == Axis::Horizontal,
            steps: length,
        }),
    }
}

#[cfg(any(target_os = "linux", test))]
fn unicode_to_keysym(ch: char) -> i32 {
    let codepoint = u32::from(ch);
    let keysym = if codepoint <= 0xff {
        codepoint
    } else {
        0x0100_0000 | codepoint
    };
    i32::try_from(keysym).expect("Unicode keysym fits in a signed 32-bit portal value")
}

/// Replay one command on the thread-owned input backend. Returning an error
/// closes the actor so revoked permissions and backend failures are visible.
fn apply(
    enigo: &mut Enigo,
    #[cfg(target_os = "macos")] mac_mouse: &mut MacMouse,
    cmd: InputCmd,
) -> Result<(), String> {
    match cmd {
        InputCmd::Raw { code, dir } => {
            enigo.raw(code, dir).map_err(|e| e.to_string())?;
        }
        InputCmd::Key { key, dir } => {
            enigo.key(key, dir).map_err(|e| e.to_string())?;
        }
        InputCmd::Button { button, dir } => {
            #[cfg(target_os = "macos")]
            mac_mouse.button(button, dir)?;
            #[cfg(not(target_os = "macos"))]
            enigo.button(button, dir).map_err(|e| e.to_string())?;
        }
        InputCmd::MoveMouse { x, y, coord } => {
            #[cfg(target_os = "macos")]
            match coord {
                Coordinate::Abs => {
                    mac_mouse.absolute_move(
                        u16::try_from(x).unwrap_or(0),
                        u16::try_from(y).unwrap_or(0),
                    )?;
                }
                Coordinate::Rel => mac_mouse.relative_move(x, y)?,
            }
            #[cfg(not(target_os = "macos"))]
            enigo.move_mouse(x, y, coord).map_err(|e| e.to_string())?;
        }
        InputCmd::Scroll { length, axis } => {
            enigo.scroll(length, axis).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

impl RdpServerInputHandler for RdpInput {
    fn keyboard(&mut self, event: KeyboardEvent) {
        match event {
            KeyboardEvent::Pressed { code, extended } => {
                if let Some(raw) = rdp_scancode_to_raw(code, extended) {
                    self.send(InputCmd::Raw {
                        code: raw,
                        dir: Press,
                    });
                }
            }
            KeyboardEvent::Released { code, extended } => {
                if let Some(raw) = rdp_scancode_to_raw(code, extended) {
                    self.send(InputCmd::Raw {
                        code: raw,
                        dir: Release,
                    });
                }
            }
            KeyboardEvent::UnicodePressed(c) => {
                if let Some(ch) = char::from_u32(u32::from(c)) {
                    self.send(InputCmd::Key {
                        key: Key::Unicode(ch),
                        dir: Press,
                    });
                }
            }
            KeyboardEvent::UnicodeReleased(c) => {
                if let Some(ch) = char::from_u32(u32::from(c)) {
                    self.send(InputCmd::Key {
                        key: Key::Unicode(ch),
                        dir: Release,
                    });
                }
            }
            KeyboardEvent::Synchronize(flags) => {
                // Best-effort lock-key pulse: inject Caps/Num/Scroll press+release
                // so remote and local LED state tend to converge. Full host-state
                // reconciliation would need reading current lock state (platform API).
                self.sync_lock_keys(flags);
            }
        }
    }

    fn mouse(&mut self, event: MouseEvent) {
        match event {
            MouseEvent::Move { x, y } => {
                self.send(InputCmd::MoveMouse {
                    x: i32::from(x),
                    y: i32::from(y),
                    coord: Coordinate::Abs,
                });
            }
            MouseEvent::LeftPressed => {
                self.send(InputCmd::Button {
                    button: Button::Left,
                    dir: Press,
                });
            }
            MouseEvent::LeftReleased => {
                self.send(InputCmd::Button {
                    button: Button::Left,
                    dir: Release,
                });
            }
            MouseEvent::RightPressed => {
                self.send(InputCmd::Button {
                    button: Button::Right,
                    dir: Press,
                });
            }
            MouseEvent::RightReleased => {
                self.send(InputCmd::Button {
                    button: Button::Right,
                    dir: Release,
                });
            }
            MouseEvent::MiddlePressed => {
                self.send(InputCmd::Button {
                    button: Button::Middle,
                    dir: Press,
                });
            }
            MouseEvent::MiddleReleased => {
                self.send(InputCmd::Button {
                    button: Button::Middle,
                    dir: Release,
                });
            }
            MouseEvent::Button4Pressed => {
                // `Button::Back`/`Forward` don't exist on macOS in enigo 0.3.
                #[cfg(any(target_os = "windows", all(unix, not(target_os = "macos"))))]
                self.send(InputCmd::Button {
                    button: Button::Back,
                    dir: Press,
                });
            }
            MouseEvent::Button4Released => {
                #[cfg(any(target_os = "windows", all(unix, not(target_os = "macos"))))]
                self.send(InputCmd::Button {
                    button: Button::Back,
                    dir: Release,
                });
            }
            MouseEvent::Button5Pressed => {
                #[cfg(any(target_os = "windows", all(unix, not(target_os = "macos"))))]
                self.send(InputCmd::Button {
                    button: Button::Forward,
                    dir: Press,
                });
            }
            MouseEvent::Button5Released => {
                #[cfg(any(target_os = "windows", all(unix, not(target_os = "macos"))))]
                self.send(InputCmd::Button {
                    button: Button::Forward,
                    dir: Release,
                });
            }
            MouseEvent::VerticalScroll { value } => {
                // RDP wheel units are 120 per notch; positive = up. enigo's
                // `scroll` uses positive = down, so invert and normalize.
                let notches = -(i32::from(value) / 120);
                let notches = if notches == 0 {
                    if value > 0 {
                        -1
                    } else if value < 0 {
                        1
                    } else {
                        0
                    }
                } else {
                    notches
                };
                if notches != 0 {
                    self.send(InputCmd::Scroll {
                        length: notches,
                        axis: Axis::Vertical,
                    });
                }
            }
            MouseEvent::Scroll { x, y } => {
                if x != 0 {
                    self.send(InputCmd::Scroll {
                        length: x,
                        axis: Axis::Horizontal,
                    });
                }
                if y != 0 {
                    self.send(InputCmd::Scroll {
                        length: y,
                        axis: Axis::Vertical,
                    });
                }
            }
            MouseEvent::RelMove { x, y } => {
                self.send(InputCmd::MoveMouse {
                    x,
                    y,
                    coord: Coordinate::Rel,
                });
            }
        }
    }
}

/// Translate an RDP PC/AT Set-1 scancode + extended flag into the `u16` keycode
/// `enigo::Keyboard::raw` expects on this platform. Returns `None` for codes we
/// can't represent (caller then drops the event).
///
/// Split out as a free function so the mapping can be unit-tested without a real
/// `Enigo`/display.
pub(crate) fn rdp_scancode_to_raw(scancode: u8, extended: bool) -> Option<u16> {
    #[cfg(target_os = "windows")]
    {
        // Windows `raw()` takes the scancode directly. Mark extended keys with
        // the 0xE0 prefix bit so `MAPVK_VSC_TO_VK_EX` resolves the right VK.
        let mut sc = u16::from(scancode);
        if extended {
            sc |= 0xE000;
        }
        Some(sc)
    }

    #[cfg(target_os = "linux")]
    {
        Some(linux_scancode_to_keycode(scancode, extended))
    }

    #[cfg(target_os = "macos")]
    {
        if extended {
            macos_extended_scancode_to_keycode(scancode)
        } else {
            macos_scancode_to_keycode(scancode)
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        let _ = (scancode, extended);
        None
    }
}

/// X11 keycode for an RDP Set-1 scancode. X11 keycode = Linux evdev code + 8.
/// For the main keyboard block, RDP Set-1 codes equal evdev codes, so the base
/// case is `scancode + 8`. Extended (0xE0-prefixed) keys map to distinct evdev
/// codes and are handled explicitly.
#[cfg(any(target_os = "linux", test))]
pub(crate) fn linux_scancode_to_keycode(scancode: u8, extended: bool) -> u16 {
    // Selected extended-key evdev codes (Linux input-event-codes.h). These do
    // NOT equal `scancode + 8`, so they need an explicit table.
    if extended {
        let evdev = match scancode {
            0x1C => 96,  // KEY_KPENTER
            0x1D => 97,  // KEY_RIGHTCTRL
            0x35 => 98,  // KEY_KPSLASH
            0x38 => 100, // KEY_RIGHTALT
            0x47 => 102, // KEY_HOME
            0x48 => 103, // KEY_UP
            0x49 => 104, // KEY_PAGEUP
            0x4B => 105, // KEY_LEFT
            0x4D => 106, // KEY_RIGHT
            0x4F => 107, // KEY_END
            0x50 => 108, // KEY_DOWN
            0x51 => 109, // KEY_PAGEDOWN
            0x52 => 110, // KEY_INSERT
            0x53 => 111, // KEY_DELETE
            0x5B => 125, // KEY_LEFTMETA
            0x5C => 126, // KEY_RIGHTMETA
            0x5D => 127, // KEY_COMPOSE (menu)
            // Unknown extended key: best-effort base mapping.
            other => return u16::from(other) + 8,
        };
        return evdev + 8;
    }
    // Main block: evdev code == Set-1 scancode; X11 keycode = evdev + 8.
    u16::from(scancode) + 8
}

#[cfg(target_os = "macos")]
fn macos_scancode_to_keycode(scancode: u8) -> Option<u16> {
    // PC Set-1 → CGKeyCode for common keys (see HIToolbox Events.h).
    // Letters/digits use ANSI keycodes; unmapped codes fall through so the
    // Unicode path can still deliver text when the client sends it.
    let cg = match scancode {
        // Control keys
        0x01 => 53, // Escape
        0x0E => 51, // Delete (Backspace)
        0x0F => 48, // Tab
        0x1C => 36, // Return
        0x39 => 49, // Space
        0x3A => 57, // Caps Lock
        // Modifiers
        0x1D => 59, // Left Control
        0x2A => 56, // Left Shift
        0x36 => 60, // Right Shift
        0x38 => 58, // Left Option/Alt
        0x5B => 55, // Left Command (meta) — when not extended
        // Digits top row
        0x02 => 18, // 1
        0x03 => 19, // 2
        0x04 => 20, // 3
        0x05 => 21, // 4
        0x06 => 23, // 5
        0x07 => 22, // 6
        0x08 => 26, // 7
        0x09 => 28, // 8
        0x0A => 25, // 9
        0x0B => 29, // 0
        0x0C => 27, // -
        0x0D => 24, // =
        // Letters (QWERTY)
        0x10 => 12, // Q
        0x11 => 13, // W
        0x12 => 14, // E
        0x13 => 15, // R
        0x14 => 17, // T
        0x15 => 16, // Y
        0x16 => 32, // U
        0x17 => 34, // I
        0x18 => 31, // O
        0x19 => 35, // P
        0x1E => 0,  // A
        0x1F => 1,  // S
        0x20 => 2,  // D
        0x21 => 3,  // F
        0x22 => 5,  // G
        0x23 => 4,  // H
        0x24 => 38, // J
        0x25 => 40, // K
        0x26 => 37, // L
        0x2C => 6,  // Z
        0x2D => 7,  // X
        0x2E => 8,  // C
        0x2F => 9,  // V
        0x30 => 11, // B
        0x31 => 45, // N
        0x32 => 46, // M
        // Punctuation
        0x1A => 33, // [
        0x1B => 30, // ]
        0x27 => 41, // ;
        0x28 => 39, // '
        0x29 => 50, // `
        0x2B => 42, // \
        0x33 => 43, // ,
        0x34 => 47, // .
        0x35 => 44, // /
        // Function keys F1–F12
        0x3B => 122, // F1
        0x3C => 120, // F2
        0x3D => 99,  // F3
        0x3E => 118, // F4
        0x3F => 96,  // F5
        0x40 => 97,  // F6
        0x41 => 98,  // F7
        0x42 => 100, // F8
        0x43 => 101, // F9
        0x44 => 109, // F10
        0x57 => 103, // F11
        0x58 => 111, // F12
        _ => return None,
    };
    Some(cg)
}

/// Extended (E0) scancodes → CGKeyCode for arrows and navigation.
#[cfg(target_os = "macos")]
fn macos_extended_scancode_to_keycode(scancode: u8) -> Option<u16> {
    let cg = match scancode {
        0x48 => 126, // Up
        0x50 => 125, // Down
        0x4B => 123, // Left
        0x4D => 124, // Right
        0x47 => 115, // Home
        0x4F => 119, // End
        0x49 => 116, // Page Up
        0x51 => 121, // Page Down
        0x52 => 114, // Insert (Help on mac)
        0x53 => 117, // Forward Delete
        0x1D => 62,  // Right Control
        0x38 => 61,  // Right Option
        0x5B => 55,  // Left Command
        0x5C => 54,  // Right Command
        0x1C => 76,  // Keypad Enter
        _ => return None,
    };
    Some(cg)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn absolute_move(x: i32) -> QueuedInput {
        QueuedInput {
            received_at: Instant::now(),
            cmd: InputCmd::MoveMouse {
                x,
                y: 0,
                coord: Coordinate::Abs,
            },
        }
    }

    /// `RdpServerInputHandler: Send` and `ironrdp-server` moves the handler onto
    /// `spawn_blocking` threads, so `RdpInput` MUST be `Send` on every platform —
    /// including macOS, where `Enigo` is `!Send`. This static assertion fails to
    /// compile if someone reintroduces a non-`Send` field (e.g. holding `Enigo`
    /// directly again), catching the macOS-only build break on every platform.
    const _: fn() = || {
        fn assert_send<T: Send>() {}
        assert_send::<RdpInput>();
    };

    #[test]
    fn input_queue_coalesces_only_consecutive_mouse_moves() {
        let queue = InputQueue::new();
        assert!(matches!(
            queue.push(absolute_move(1)),
            InputQueuePush::Enqueued
        ));
        assert!(matches!(
            queue.push(absolute_move(2)),
            InputQueuePush::Coalesced
        ));
        assert!(matches!(
            queue.push(QueuedInput {
                received_at: Instant::now(),
                cmd: InputCmd::Button {
                    button: Button::Left,
                    dir: Press,
                },
            }),
            InputQueuePush::Enqueued
        ));
        assert!(matches!(
            queue.push(absolute_move(3)),
            InputQueuePush::Enqueued
        ));

        let first = queue.recv().unwrap();
        assert!(matches!(first.cmd, InputCmd::MoveMouse { x: 2, .. }));
        assert!(matches!(queue.recv().unwrap().cmd, InputCmd::Button { .. }));
        assert!(matches!(
            queue.recv().unwrap().cmd,
            InputCmd::MoveMouse { x: 3, .. }
        ));
    }

    #[test]
    fn retina_surface_coordinates_map_to_logical_display_points() {
        assert_eq!(map_surface_coordinate(0, 3840, 0.0, 1920.0), 0.0);
        assert_eq!(map_surface_coordinate(1920, 3840, 0.0, 1920.0), 960.0);
        assert_eq!(map_surface_coordinate(3839, 3840, 0.0, 1920.0), 1919.5);
    }

    #[test]
    fn secondary_display_mapping_preserves_negative_global_origins() {
        assert_eq!(map_surface_coordinate(0, 2560, -1280.0, 1280.0), -1280.0);
        assert_eq!(map_surface_coordinate(1280, 2560, -1280.0, 1280.0), -640.0);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn input_mapping_uses_the_latest_negotiated_surface_size() {
        fn packed(width: u16, height: u16) -> u32 {
            (u32::from(width) << 16) | u32::from(height)
        }

        let surface_size = Arc::new(AtomicU32::new(packed(3840, 2160)));
        let mapping = MacInputMapping::new(
            super::super::capture::mac::DisplayBounds {
                x: -1920,
                y: 120,
                width: 1920,
                height: 1080,
            },
            surface_size.clone(),
        )
        .unwrap();

        let retina_center = mapping.absolute_point(1920, 1080);
        assert_eq!(retina_center.x, -960.0);
        assert_eq!(retina_center.y, 660.0);

        surface_size.store(packed(1920, 1080), Ordering::Relaxed);
        let negotiated_center = mapping.absolute_point(960, 540);
        assert_eq!(negotiated_center.x, retina_center.x);
        assert_eq!(negotiated_center.y, retina_center.y);
    }

    #[test]
    fn main_block_is_scancode_plus_eight() {
        // 'A' is RDP Set-1 0x1E; evdev KEY_A is 30; X11 keycode 38.
        assert_eq!(linux_scancode_to_keycode(0x1E, false), 0x1E + 8);
        // Enter (main) 0x1C -> evdev 28 -> X11 36.
        assert_eq!(linux_scancode_to_keycode(0x1C, false), 28 + 8);
    }

    #[test]
    fn extended_keys_use_explicit_evdev_codes() {
        // Right Ctrl: extended 0x1D -> evdev 97 -> X11 105.
        assert_eq!(linux_scancode_to_keycode(0x1D, true), 97 + 8);
        // Up arrow: extended 0x48 -> evdev 103 -> X11 111.
        assert_eq!(linux_scancode_to_keycode(0x48, true), 103 + 8);
        // KP Enter: extended 0x1C -> evdev 96 (distinct from main Enter).
        assert_eq!(linux_scancode_to_keycode(0x1C, true), 96 + 8);
        assert_ne!(
            linux_scancode_to_keycode(0x1C, true),
            linux_scancode_to_keycode(0x1C, false)
        );
    }

    #[test]
    fn unknown_extended_falls_back_to_base() {
        // An unmapped extended code degrades to scancode+8 rather than panicking.
        assert_eq!(linux_scancode_to_keycode(0x7A, true), 0x7A + 8);
    }
}
