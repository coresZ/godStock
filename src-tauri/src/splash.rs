//! Native startup overlay inside the main window.
//!
//! WebView2 needs roughly one to three seconds before it paints the first
//! frame. A Tauri window can look transparent or solid-black during that gap.
//! Instead of opening a second top-level splash window, this module creates a
//! **child window** covering the client area of the existing main window and
//! paints the brand animation with GDI. When the frontend reports that the
//! shell is mounted (`app_ready` command) the child layer is destroyed and the
//! already-rendered app is revealed — one window from start to finish.

#[cfg(windows)]
mod imp {
    use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
    use std::sync::{mpsc, OnceLock};
    use std::time::{Duration, Instant};

    use windows_sys::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, RECT, SIZE, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{
        BeginPaint, CreateFontW, CreatePen, CreateSolidBrush, DeleteObject, Ellipse, EndPaint,
        FillRect, GetTextExtentPoint32W, HDC, InvalidateRect, LineTo, MoveToEx, SelectObject,
        SetBkMode, SetTextColor, TextOutW, UpdateWindow, CLEARTYPE_QUALITY, DEFAULT_CHARSET,
        DEFAULT_PITCH, FF_DONTCARE, FW_NORMAL, HFONT, HGDIOBJ, PAINTSTRUCT, PS_SOLID, TRANSPARENT,
    };
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetClientRect,
        GetMessageW, GetParent, KillTimer, LoadCursorW, PostMessageW, PostQuitMessage,
        RegisterClassW, SetTimer, SetWindowPos, ShowWindow, TranslateMessage, HWND_TOP, IDC_ARROW,
        MSG, SWP_NOACTIVATE, SWP_SHOWWINDOW, SW_SHOW, WM_CLOSE, WM_DESTROY, WM_ERASEBKGND,
        WM_PAINT, WM_TIMER, WNDCLASSW, WS_CHILD, WS_CLIPSIBLINGS, WS_VISIBLE,
    };

    static HWND_VALUE: AtomicIsize = AtomicIsize::new(0);
    static DARK: AtomicBool = AtomicBool::new(true);
    static START: OnceLock<Instant> = OnceLock::new();
    static ATTACHED: AtomicBool = AtomicBool::new(false);
    /// Set when `close()` runs before the child window exists. The creator
    /// thread honours it right after publishing the handle, so a slow first
    /// paint can never leave the GDI layer covering the app forever.
    static CLOSE_REQUESTED: AtomicBool = AtomicBool::new(false);

    const CLASS_NAME: &[u16] = &[
        b'T' as u16, b'i' as u16, b'a' as u16, b'n' as u16, b'T' as u16, b'i' as u16,
        b'B' as u16, b'o' as u16, b'o' as u16, b't' as u16, 0,
    ];
    const WINDOW_TITLE: &[u16] = &[
        b'T' as u16, b'i' as u16, b'a' as u16, b'n' as u16, b'T' as u16, b'i' as u16, 0,
    ];

    const CONTENT_H: i32 = 210;

    struct Palette {
        bg: COLORREF,
        strong: COLORREF,
        muted: COLORREF,
        faint: COLORREF,
        line: COLORREF,
        brass: COLORREF,
        up: COLORREF,
    }

    fn rgb(r: u8, g: u8, b: u8) -> COLORREF {
        (r as u32) | ((g as u32) << 8) | ((b as u32) << 16)
    }

    fn palette() -> Palette {
        if DARK.load(Ordering::Relaxed) {
            Palette {
                bg: rgb(0x0B, 0x0C, 0x0F),
                strong: rgb(0xF4, 0xEE, 0xE2),
                muted: rgb(0x98, 0x9A, 0x9F),
                faint: rgb(0x7B, 0x7F, 0x88),
                line: rgb(0x24, 0x26, 0x2C),
                brass: rgb(0xC6, 0xA1, 0x5B),
                up: rgb(0xE1, 0x5A, 0x4D),
            }
        } else {
            Palette {
                bg: rgb(0xF2, 0xED, 0xE3),
                strong: rgb(0x11, 0x10, 0x0E),
                muted: rgb(0x6C, 0x67, 0x5E),
                faint: rgb(0x7C, 0x75, 0x69),
                line: rgb(0xDD, 0xD5, 0xC6),
                brass: rgb(0x8C, 0x6A, 0x2F),
                up: rgb(0xB9, 0x3C, 0x30),
            }
        }
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn create_font(height: i32, face: &[u16]) -> HFONT {
        unsafe {
            CreateFontW(
                height,
                0,
                0,
                0,
                FW_NORMAL as i32,
                0,
                0,
                0,
                DEFAULT_CHARSET as u32,
                0,
                0,
                CLEARTYPE_QUALITY as u32,
                (DEFAULT_PITCH as u32) | (FF_DONTCARE as u32),
                face.as_ptr(),
            )
        }
    }

    fn fill(hdc: HDC, rect: &RECT, color: COLORREF) {
        unsafe {
            let brush = CreateSolidBrush(color);
            FillRect(hdc, rect, brush);
            DeleteObject(brush as HGDIOBJ);
        }
    }

    fn line(hdc: HDC, color: COLORREF, width: i32, x1: i32, y1: i32, x2: i32, y2: i32) {
        unsafe {
            let pen = CreatePen(PS_SOLID, width, color);
            let old = SelectObject(hdc, pen as HGDIOBJ);
            MoveToEx(hdc, x1, y1, std::ptr::null_mut());
            LineTo(hdc, x2, y2);
            SelectObject(hdc, old);
            DeleteObject(pen as HGDIOBJ);
        }
    }

    fn dot(hdc: HDC, color: COLORREF, x: i32, y: i32, diameter: i32) {
        unsafe {
            let brush = CreateSolidBrush(color);
            let old = SelectObject(hdc, brush as HGDIOBJ);
            Ellipse(hdc, x, y, x + diameter, y + diameter);
            SelectObject(hdc, old);
            DeleteObject(brush as HGDIOBJ);
        }
    }

    fn text_centered(hdc: HDC, text: &[u16], font: HFONT, color: COLORREF, cx: i32, top: i32) {
        unsafe {
            let old = SelectObject(hdc, font as HGDIOBJ);
            SetBkMode(hdc, TRANSPARENT as i32);
            SetTextColor(hdc, color);
            let mut size = SIZE { cx: 0, cy: 0 };
            let len = text.len().saturating_sub(1) as i32;
            GetTextExtentPoint32W(hdc, text.as_ptr(), len, &mut size);
            TextOutW(hdc, cx - size.cx / 2, top, text.as_ptr(), len);
            SelectObject(hdc, old);
        }
    }

    fn paint(hwnd: HWND) {
        let colors = palette();
        let mut paint = PAINTSTRUCT::default();
        unsafe {
            let hdc = BeginPaint(hwnd, &mut paint);
            let mut client = RECT { left: 0, top: 0, right: 0, bottom: 0 };
            GetClientRect(hwnd, &mut client);
            let w = client.right;
            let h = client.bottom;
            if w <= 0 || h <= 0 {
                EndPaint(hwnd, &paint);
                return;
            }
            fill(hdc, &client, colors.bg);

            let cx = w / 2;
            let content_top = ((h - CONTENT_H) / 2).max(0);
            let word_font = create_font(-36, &wide("SimSun"));
            let sub_font = create_font(-12, &wide("Microsoft YaHei UI"));
            let tiny_font = create_font(-10, &wide("Microsoft YaHei UI"));

            // Staircase mark.
            let lx = cx - 40;
            let ly = content_top + 8;
            line(hdc, colors.brass, 4, lx, ly + 50, lx + 26, ly + 50);
            line(hdc, colors.brass, 4, lx + 26, ly + 50, lx + 26, ly + 30);
            line(hdc, colors.brass, 4, lx + 26, ly + 30, lx + 56, ly + 30);
            line(hdc, colors.brass, 4, lx + 56, ly + 30, lx + 56, ly + 10);
            line(hdc, colors.brass, 4, lx + 56, ly + 10, lx + 84, ly + 10);
            // Vermilion beacon above the highest step.
            dot(hdc, colors.up, lx + 88, ly - 2, 14);
            dot(hdc, colors.bg, lx + 92, ly + 2, 6);

            text_centered(hdc, &wide("天梯"), word_font, colors.strong, cx, content_top + 86);
            text_centered(hdc, &wide("A股涨停复盘"), sub_font, colors.muted, cx, content_top + 134);

            // Progress rail with a slow brass shuttle.
            let track_w = 172;
            let track_x = cx - track_w / 2;
            let track_y = content_top + 178;
            fill(
                hdc,
                &RECT { left: track_x, top: track_y, right: track_x + track_w, bottom: track_y + 1 },
                colors.line,
            );
            let elapsed = START.get_or_init(Instant::now).elapsed().as_secs_f32();
            let phase = (elapsed % 1.35) / 1.35;
            let eased = 0.5 - (std::f32::consts::PI * phase).cos() * 0.5;
            let segment_w = 56;
            let segment_x = track_x + ((track_w - segment_w) as f32 * eased) as i32;
            fill(
                hdc,
                &RECT { left: segment_x, top: track_y - 1, right: segment_x + segment_w, bottom: track_y + 2 },
                colors.brass,
            );

            let dots = 1 + ((elapsed * 2.2) as usize % 4);
            let status = format!("正在唤醒行情{}", "·".repeat(dots));
            text_centered(hdc, &wide(&status), tiny_font, colors.faint, cx, content_top + 190);

            DeleteObject(word_font as HGDIOBJ);
            DeleteObject(sub_font as HGDIOBJ);
            DeleteObject(tiny_font as HGDIOBJ);
            EndPaint(hwnd, &paint);
        }
    }

    /// Keep the child layer glued to the parent client area and on top of the
    /// WebView2 child window while the boot animation is running.
    fn sync_geometry(hwnd: HWND) {
        unsafe {
            let parent = GetParent(hwnd);
            if parent.is_null() {
                return;
            }
            let mut client = RECT { left: 0, top: 0, right: 0, bottom: 0 };
            GetClientRect(parent, &mut client);
            let width = client.right.max(1);
            let height = client.bottom.max(1);
            SetWindowPos(
                hwnd,
                HWND_TOP,
                0,
                0,
                width,
                height,
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            );
        }
    }

    unsafe extern "system" fn wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match msg {
            WM_PAINT => {
                paint(hwnd);
                0
            }
            WM_ERASEBKGND => 1,
            WM_TIMER => {
                sync_geometry(hwnd);
                InvalidateRect(hwnd, std::ptr::null(), 0);
                0
            }
            WM_CLOSE => {
                DestroyWindow(hwnd);
                0
            }
            WM_DESTROY => {
                KillTimer(hwnd, 1);
                PostQuitMessage(0);
                0
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }

    fn create_overlay(parent: HWND) -> Option<HWND> {
        unsafe {
            let instance = GetModuleHandleW(std::ptr::null());
            let cursor = LoadCursorW(std::ptr::null_mut(), IDC_ARROW);
            let class = WNDCLASSW {
                style: 0,
                lpfnWndProc: Some(wnd_proc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: instance,
                hIcon: std::ptr::null_mut(),
                hCursor: cursor,
                hbrBackground: CreateSolidBrush(palette().bg),
                lpszMenuName: std::ptr::null(),
                lpszClassName: CLASS_NAME.as_ptr(),
            };
            let atom = RegisterClassW(&class);
            if atom == 0 {
                let err = windows_sys::Win32::Foundation::GetLastError();
                if err != windows_sys::Win32::Foundation::ERROR_CLASS_ALREADY_EXISTS {
                    return None;
                }
            }
            let mut client = RECT { left: 0, top: 0, right: 0, bottom: 0 };
            GetClientRect(parent, &mut client);
            let width = client.right.max(1);
            let height = client.bottom.max(1);
            let child = CreateWindowExW(
                0,
                CLASS_NAME.as_ptr(),
                WINDOW_TITLE.as_ptr(),
                WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
                0,
                0,
                width,
                height,
                parent,
                std::ptr::null_mut(),
                instance,
                std::ptr::null(),
            );
            if child.is_null() {
                return None;
            }
            SetWindowPos(
                child,
                HWND_TOP,
                0,
                0,
                width,
                height,
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            );
            ShowWindow(child, SW_SHOW);
            UpdateWindow(child);
            SetTimer(child, 1, 33, None);
            Some(child)
        }
    }

    fn message_loop() {
        unsafe {
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }

    /// Attach the GDI boot animation to the already-created main window.
    pub fn attach(parent: isize, dark: bool) {
        if ATTACHED.swap(true, Ordering::SeqCst) {
            return;
        }
        DARK.store(dark, Ordering::Relaxed);
        START.get_or_init(Instant::now);
        let (tx, rx) = mpsc::channel::<isize>();
        std::thread::Builder::new()
            .name("tianti-boot".into())
            .spawn(move || match create_overlay(parent as HWND) {
                Some(child) => {
                    HWND_VALUE.store(child as isize, Ordering::SeqCst);
                    let _ = tx.send(child as isize);
                    if CLOSE_REQUESTED.swap(false, Ordering::SeqCst) {
                        unsafe {
                            PostMessageW(child, WM_CLOSE, 0, 0);
                        }
                    }
                    message_loop();
                }
                None => {
                    let _ = tx.send(0);
                }
            })
            .ok();
        let _ = rx.recv_timeout(Duration::from_millis(1500));
    }

    pub fn elapsed() -> Option<Duration> {
        START.get().map(|start| start.elapsed())
    }

    pub fn close() {
        let value = HWND_VALUE.swap(0, Ordering::SeqCst);
        if value == 0 {
            // The overlay may still be in `create_overlay`; the boot thread
            // closes it as soon as the handle is published.
            CLOSE_REQUESTED.store(true, Ordering::SeqCst);
            return;
        }
        unsafe {
            PostMessageW(value as HWND, WM_CLOSE, 0, 0);
        }
    }
}

#[cfg(windows)]
pub use imp::{attach, close, elapsed};

#[cfg(not(windows))]
pub fn attach(_parent: isize, _dark: bool) {}

#[cfg(not(windows))]
pub fn close() {}

#[cfg(not(windows))]
pub fn elapsed() -> Option<std::time::Duration> {
    None
}
