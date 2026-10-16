//! Fault injection for the switch's own tests (tests/design-engine-switch.test.ts): a named entry point answers
//! wrong on purpose, so a test proves that `both` mode sees a wrong wasm answer and names the path, or panics
//! (`normalize.panic`, tests/design-engine-crash.test.ts). Off unless a test turns it on; one string compare per call
//! of the entry points that check it.
//!
//! Also the panic hook: a panic traps the module (`unreachable`), so its message is kept for `last_panic`, which
//! shared/design/engine-switch.ts reads when it records the crash.

use std::cell::RefCell;
use wasm_bindgen::prelude::*;

thread_local! {
    static FAULT: RefCell<String> = const { RefCell::new(String::new()) };
}

/// Makes the entry point `name` (`"geometry.localMatrix"`, `"geometry.worldBox"`, `"ops.mergeChange"`) answer wrong, or
/// `"normalize.panic"` panic, until it is cleared with `""`.
#[wasm_bindgen]
pub fn debug_fault(name: &str) {
    FAULT.with(|fault| *fault.borrow_mut() = name.to_owned());
}

pub(crate) fn is_on(name: &str) -> bool {
    FAULT.with(|fault| {
        let fault = fault.borrow();
        !fault.is_empty() && *fault == name
    })
}

thread_local! {
    static LAST_PANIC: RefCell<String> = const { RefCell::new(String::new()) };
}

/// Installed when the module is instantiated (the web build's `init()`, the nodejs build's `require`).
#[wasm_bindgen(start)]
pub fn keep_panics() {
    std::panic::set_hook(Box::new(|info| {
        let message = info.to_string();
        LAST_PANIC.with(|last| *last.borrow_mut() = message);
    }));
}

/// The message of the last Rust panic (empty when none happened).
#[wasm_bindgen]
pub fn last_panic() -> String {
    LAST_PANIC.with(|last| last.borrow().clone())
}
