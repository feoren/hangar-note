//! The server's proof that it knows the token (ADR 0002, "Local channel"; security review of
//! phase 1, finding M1). An `endpoint.json` left behind by a crash names a port that another
//! local program may bind; a client must not hand its content to that program.
//!
//! - The client sends a fresh nonce (32 random bytes, 64 lowercase hex digits) in
//!   [`NONCE_HEADER`], first on `POST /v1/hello` without its token or any content, then on the
//!   real request.
//! - The server answers every request that carries a nonce with [`PROOF_HEADER`]:
//!   `hex(HMAC-SHA256(key, nonce || status || body))`, where `key` is
//!   `SHA-256("hangar-channel-server" || token)`, `nonce` the 64 ASCII hex digits as sent,
//!   `status` the HTTP status as 3 ASCII digits and `body` the exact bytes of the answer's body.
//!   `token` is the token as written in `endpoint.json`: its 64 ASCII hex digits.
//! - The client compares in constant time. Only after a valid proof on the hello does it send its
//!   token and content; a real answer without a valid proof counts as not delivered.
//!
//! HMAC (RFC 2104) is written out here on `sha2` instead of adding RustCrypto's `hmac` crate:
//! `hmac` would bring `hmac` and `subtle` into the tree for about fifteen lines, the RFC 4231 test
//! vectors below pin the construction, and Hangar can take this file unchanged for its side.

use std::io;

use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use super::token_eq;

pub const NONCE_HEADER: &str = "X-Channel-Nonce";
pub const PROOF_HEADER: &str = "X-Channel-Proof";
pub const NONCE_BYTES: usize = 32;
/// Hex digits of a nonce and of a proof.
pub const HEX_LEN: usize = 64;
/// Separates this key from any other use of the token.
const KEY_LABEL: &[u8] = b"hangar-channel-server";
const BLOCK: usize = 64;
const OUTPUT: usize = 32;

/// The proof key of a token.
pub fn key(token: &str) -> Zeroizing<[u8; OUTPUT]> {
    let mut hasher = Sha256::new();
    hasher.update(KEY_LABEL);
    hasher.update(token.as_bytes());
    let mut key = Zeroizing::new([0u8; OUTPUT]);
    key.copy_from_slice(&hasher.finalize());
    key
}

/// HMAC-SHA256 over the concatenation of `parts`.
pub fn hmac_sha256(key: &[u8], parts: &[&[u8]]) -> [u8; OUTPUT] {
    let mut block = Zeroizing::new([0u8; BLOCK]);
    if key.len() > BLOCK {
        block[..OUTPUT].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner_pad = Zeroizing::new([0x36u8; BLOCK]);
    let mut outer_pad = Zeroizing::new([0x5cu8; BLOCK]);
    for ((inner, outer), byte) in inner_pad
        .iter_mut()
        .zip(outer_pad.iter_mut())
        .zip(block.iter())
    {
        *inner ^= byte;
        *outer ^= byte;
    }
    let mut inner = Sha256::new();
    inner.update(&inner_pad[..]);
    for part in parts {
        inner.update(part);
    }
    let mut outer = Sha256::new();
    outer.update(&outer_pad[..]);
    outer.update(inner.finalize());
    let mut out = [0u8; OUTPUT];
    out.copy_from_slice(&outer.finalize());
    out
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 64 lowercase hex digits: the only form a nonce or a proof takes, so every byte of it is fixed
/// and two spellings of the same value never exist.
pub fn is_hex64(text: &str) -> bool {
    text.len() == HEX_LEN && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// A fresh nonce from the operating system's random source.
pub fn new_nonce() -> io::Result<String> {
    let mut bytes = [0u8; NONCE_BYTES];
    getrandom::fill(&mut bytes).map_err(|error| io::Error::other(error.to_string()))?;
    Ok(hex(&bytes))
}

/// The proof of an answer to the request that carried `nonce`.
pub fn proof(key: &[u8; OUTPUT], nonce: &str, status: u16, body: &[u8]) -> String {
    let status = format!("{status:03}");
    hex(&hmac_sha256(
        key,
        &[nonce.as_bytes(), status.as_bytes(), body],
    ))
}

/// Whether `claimed` proves this answer, compared in constant time.
pub fn verify(key: &[u8; OUTPUT], nonce: &str, status: u16, body: &[u8], claimed: &str) -> bool {
    is_hex64(claimed)
        && token_eq(
            proof(key, nonce, status, body).as_bytes(),
            claimed.as_bytes(),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 4231, test cases 1, 2 and 6 (a key longer than the block is hashed first).
    #[test]
    fn hmac_matches_rfc_4231() {
        assert_eq!(
            hex(&hmac_sha256(&[0x0b; 20], &[b"Hi There"])),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
        assert_eq!(
            hex(&hmac_sha256(
                b"Jefe",
                &[b"what do ya ", b"want for nothing?"]
            )),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        assert_eq!(
            hex(&hmac_sha256(
                &[0xaa; 131],
                &[b"Test Using Larger Than Block-Size Key - Hash Key First"]
            )),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    /// Known answers for Hangar's side of the contract, computed independently (Python's
    /// `hashlib` and `hmac`).
    #[test]
    fn the_proof_has_the_documented_shape() {
        let token = "0123456789abcdef".repeat(4);
        let nonce = "fedcba9876543210".repeat(4);
        let key = key(&token);
        assert_eq!(
            hex(&key[..]),
            "501e571ea9dc36ebcfd9e45779491798112bd6db3baa78483afd8961c4eabe0c"
        );
        let ok = "e3ad221eff7e1867f489a5e11f72acef5f310bb91349fb4c85416af3072d4bd8";
        assert_eq!(proof(&key, &nonce, 200, br#"{"version":1}"#), ok);
        assert!(verify(&key, &nonce, 200, br#"{"version":1}"#, ok));
        assert_eq!(
            proof(&key, &nonce, 409, br#"{"version":1,"error":"read-only"}"#),
            "5bb6e2528b6d08ef9bb603a514275f63bf735c0a91eb5d74e3f6a08619624c6d"
        );
        // Any other status, body, nonce or spelling fails.
        assert!(!verify(&key, &nonce, 201, br#"{"version":1}"#, ok));
        assert!(!verify(&key, &nonce, 200, br#"{"version":2}"#, ok));
        assert!(!verify(&key, &"0".repeat(64), 200, br#"{"version":1}"#, ok));
        assert!(!verify(
            &key,
            &nonce,
            200,
            br#"{"version":1}"#,
            &ok.to_uppercase()
        ));
        assert!(!verify(&key, &nonce, 200, br#"{"version":1}"#, &ok[1..]));
    }

    #[test]
    fn nonces_are_fresh_lowercase_hex() {
        let a = new_nonce().unwrap();
        assert!(is_hex64(&a));
        assert_ne!(a, new_nonce().unwrap());
        assert!(!is_hex64(&a.to_uppercase().replace(char::is_numeric, "A")));
        assert!(!is_hex64("g".repeat(64).as_str()));
    }
}
