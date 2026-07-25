//! Verifies the SHA-256 helper in models::downloader.

use std::io::Write;
use taomni_lib::models::downloader::sha256_file;
use tempfile::NamedTempFile;

#[test]
fn sha256_matches_known_vector() {
    // Known SHA-256("hello world") == "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
    let mut tf = NamedTempFile::new().unwrap();
    tf.write_all(b"hello world").unwrap();
    let path = tf.into_temp_path();
    let digest = sha256_file(&path).unwrap();
    assert_eq!(
        digest,
        "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
    );
}
