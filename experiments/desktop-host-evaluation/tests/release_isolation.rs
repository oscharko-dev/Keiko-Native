use keiko_eval::package::{ReleaseSurface, inspect_release_surface};

#[test]
fn release_surface_rejects_driver_markers_and_debug_listeners() {
    for bytes in [
        b"normal EVALUATION_DRIVER_V1 normal".as_slice(),
        b"--remote-debugging-port=9222".as_slice(),
        b"test-credential".as_slice(),
    ] {
        assert!(inspect_release_surface(bytes).is_err());
    }
    assert_eq!(
        inspect_release_surface(b"release shell").unwrap(),
        ReleaseSurface::Clean
    );
}
