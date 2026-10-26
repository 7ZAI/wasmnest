//! host-crypto 端到端探针 fixture 插件（票 02 批次 04 自 wasip3 夹具拆出）
use wasmnest_plugin_api::types::{PluginManifest, PluginType};
use wasmnest_plugin_api::wasm::WasmPlugin;
use wasmnest_plugin_api::wasm_entry;
use wasmnest_plugin_api::wasm_host::WasmHost;

pub struct CryptoProbePlugin;

impl WasmPlugin for CryptoProbePlugin {
    const ID: &'static str = "com.wasmnest.crypto-test";

    fn manifest() -> PluginManifest {
        PluginManifest {
            id: Self::ID.to_string(),
            name: "crypto-test".to_string(),
            version: "0.1.0".to_string(),
            description: "host-crypto 端到端探针插件".to_string(),
            // 探针覆盖三权限域；权限门与域隔离的否定路径由宿主单测另行断言
            permissions: vec![
                "crypto:aead".to_string(),
                "crypto:kdf".to_string(),
                "crypto:asym".to_string(),
            ],
            plugin_type: PluginType::Rust,
            ..Default::default()
        }
    }

    fn activate() -> anyhow::Result<()> {
        Ok(())
    }

    fn deactivate() -> anyhow::Result<()> {
        Ok(())
    }

    fn invoke_command(name: &str, _args: serde_json::Value) -> anyhow::Result<serde_json::Value> {
        match name {
            // 插件从 wasm 侧按名调用宿主加密引擎原语（自 wasip3 夹具原样迁入）
            "host-crypto.roundtrip" => {
                use wasmnest_plugin_api::host::HostCrypto;
                let host = WasmHost;

                // 1) AEAD：aes-256-gcm 生成 key/nonce → 加密 → 解密往返
                let key = HostCrypto::aead_generate_key(&host, "aes-256-gcm")
                    .map_err(|e| anyhow::anyhow!("aead_generate_key: {}", e))?;
                let nonce = HostCrypto::aead_generate_nonce(&host, "aes-256-gcm")
                    .map_err(|e| anyhow::anyhow!("aead_generate_nonce: {}", e))?;
                let ct = HostCrypto::aead_encrypt(
                    &host,
                    "aes-256-gcm",
                    &key,
                    &nonce,
                    b"payload",
                    Some(b"aad"),
                )
                .map_err(|e| anyhow::anyhow!("aead_encrypt: {}", e))?;
                let pt =
                    HostCrypto::aead_decrypt(&host, "aes-256-gcm", &key, &nonce, &ct, Some(b"aad"))
                        .map_err(|e| anyhow::anyhow!("aead_decrypt: {}", e))?;
                if pt != b"payload" {
                    return Err(anyhow::anyhow!("aead roundtrip mismatch"));
                }

                // 2) 未知算法名必须失败（fail-visible）
                if HostCrypto::aead_generate_key(&host, "toy-cipher").is_ok() {
                    return Err(anyhow::anyhow!("unknown algorithm must fail"));
                }

                // 3) X25519 双端共享密钥一致
                let alice = HostCrypto::key_agreement_generate(&host, "x25519")
                    .map_err(|e| anyhow::anyhow!("keygen alice: {}", e))?;
                let bob = HostCrypto::key_agreement_generate(&host, "x25519")
                    .map_err(|e| anyhow::anyhow!("keygen bob: {}", e))?;
                let s_a =
                    HostCrypto::key_agreement_shared(&host, "x25519", &alice.private, &bob.public)
                        .map_err(|e| anyhow::anyhow!("shared a: {}", e))?;
                let s_b =
                    HostCrypto::key_agreement_shared(&host, "x25519", &bob.private, &alice.public)
                        .map_err(|e| anyhow::anyhow!("shared b: {}", e))?;
                if s_a != s_b || s_a.len() != 32 {
                    return Err(anyhow::anyhow!("x25519 shared mismatch"));
                }

                // 4) KDF 派生
                let dk = HostCrypto::kdf_derive(
                    &host,
                    "hkdf-sha256",
                    Some(b"salt"),
                    b"ikm",
                    b"info",
                    32,
                )
                .map_err(|e| anyhow::anyhow!("kdf: {}", e))?;
                if dk.len() != 32 {
                    return Err(anyhow::anyhow!("kdf wrong length"));
                }

                Ok(
                    serde_json::json!({ "ok": true, "aead": "aes-256-gcm", "kdf": "hkdf-sha256", "x25519": true }),
                )
            }
            _ => Err(anyhow::anyhow!("unknown command: {}", name)),
        }
    }
}

wasm_entry!(CryptoProbePlugin);
