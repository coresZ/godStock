//! Small Windows shell helpers that keep the taskbar / Start menu icon in
//! sync with the portable executable.

use std::path::Path;

/// Tell the shell who we are. Without an explicit AppUserModelID a portable
/// exe can be grouped under a generic host and show a blank icon in the
/// taskbar / Start menu search results.
#[cfg(windows)]
pub fn prepare_process() {
    let app_id: Vec<u16> = "com.godstock.tianti\0".encode_utf16().collect();
    unsafe {
        windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(app_id.as_ptr());
    }
}

#[cfg(not(windows))]
pub fn prepare_process() {}

/// Ask Explorer to rebuild its icon cache once after the icon artwork or the
/// executable changes. Windows otherwise keeps showing the old (sometimes
/// blank) Start menu icon for portable apps.
#[cfg(windows)]
pub fn refresh_icons_once(db_path: &Path) {
    const ICON_VERSION: &str = "3";
    let Ok(conn) = crate::db::connect(db_path) else {
        return;
    };
    let current = crate::db::get_setting(&conn, "icon_v").ok().flatten();
    if current.as_deref() == Some(ICON_VERSION) {
        return;
    }
    unsafe {
        windows_sys::Win32::UI::Shell::SHChangeNotify(
            windows_sys::Win32::UI::Shell::SHCNE_ASSOCCHANGED as i32,
            windows_sys::Win32::UI::Shell::SHCNF_IDLIST,
            std::ptr::null(),
            std::ptr::null(),
        );
    }
    let _ = crate::db::set_setting(&conn, "icon_v", ICON_VERSION);
}

#[cfg(not(windows))]
pub fn refresh_icons_once(_db_path: &Path) {}
