//! 加密工具（真源已拆到 `wasmnest-crypto-engine`，本文件只保留 shim 路径）
//!
//! 保留 `crate::utils::crypto::*` 模块路径与全部公开名字（含平铺便捷名
//! `aes_decrypt` / `hkdf_sha256` 等），宿主其余代码引用不受影响。真源覆盖三类
//! 安全场景：HTTP 报文加密（AEAD + HKDF）、常规非对称加密（RSA-OAEP / RSA-PSS /
//! X25519 ECDH）、文件加密传输（混合加密）；算法族在能力 crate 内扁平拆分、互不依赖。

pub use wasmnest_crypto_engine::{aes_gcm, chacha, hybrid, kdf, rsa, x25519};

pub use wasmnest_crypto_engine::{
    aes_decrypt, aes_encrypt, aes_generate_key, aes_generate_nonce, chacha_decrypt, chacha_encrypt,
    chacha_generate_key, chacha_generate_nonce, derive_aes_key, hkdf_sha256, rsa_decrypt, rsa_encrypt_public,
    rsa_generate, rsa_sign, rsa_verify_public, x25519_decrypt, x25519_diffie_hellman, x25519_encrypt, x25519_generate,
    HybridCiphertext, HybridEnvelope, RsaKeyPair, RsaPublicKey, X25519KeyPair, X25519SharedSecret,
};
