const DOCUMENT_NONCE_BYTES: usize = 32;

pub fn generate_document_nonce(fill: impl FnOnce(&mut [u8]) -> bool) -> Option<String> {
    let mut bytes = [0_u8; DOCUMENT_NONCE_BYTES];
    if !fill(&mut bytes) {
        return None;
    }
    Some(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(target_os = "macos")]
pub fn secure_document_nonce() -> Option<String> {
    generate_document_nonce(|bytes| {
        // SAFETY: Security.framework receives a valid writable buffer for its exact length.
        unsafe { SecRandomCopyBytes(std::ptr::null(), bytes.len(), bytes.as_mut_ptr().cast()) == 0 }
    })
}

#[cfg(not(target_os = "macos"))]
pub fn secure_document_nonce() -> Option<String> {
    None
}

#[cfg(target_os = "macos")]
#[link(name = "Security", kind = "framework")]
unsafe extern "C" {
    fn SecRandomCopyBytes(
        random: *const std::ffi::c_void,
        count: usize,
        bytes: *mut std::ffi::c_void,
    ) -> i32;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_and_failed_nonce_generation_are_closed() {
        assert_eq!(
            generate_document_nonce(|bytes| {
                bytes.fill(0xab);
                true
            }),
            Some("ab".repeat(32))
        );
        assert_eq!(generate_document_nonce(|_| false), None);
        #[cfg(target_os = "macos")]
        {
            let first = secure_document_nonce().expect("Security.framework nonce");
            let second = secure_document_nonce().expect("Security.framework nonce");
            assert_eq!(first.len(), 64);
            assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
            assert_ne!(first, second);
        }
    }
}
