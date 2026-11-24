//! 查 ME ID：Stargate `/metaearth.did.Query/Did`。
//!
//! 已查證（openmetaearth/me-hub app/keepers/wasm_me_query.go、wasmd v0.43.0 AcceptListStargateQuerier）：
//! - request data 是 protobuf 編碼的 `QueryDid { string address = 1; }`
//! - response 經 `ConvertProtoToJSONMarshal` 轉成 **JSON**，欄位名稱用 proto 原名，enum 是字串：
//!   `{"info":{"did":"2605105872869","address":"me1...","pubkey":"...","status":"DID_STATUS_ACTIVE","regionId":"me_earth","kycLevel":"KYC_LEVEL_TWO","sub_account":""}}`
//! - 地址沒有 ME ID 時 gRPC 回 ErrDidNotFound，合約這邊會收到 query error。

use cosmwasm_std::{to_json_vec, Binary, ContractResult, Empty, QuerierWrapper, QueryRequest, StdError, StdResult, SystemResult};
use serde::Deserialize;

pub const DID_QUERY_PATH: &str = "/metaearth.did.Query/Did";

#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct DidInfo {
    #[serde(default)]
    pub did: String,
    #[serde(default)]
    pub address: String,
    #[serde(default)]
    pub status: serde_json_wasm_value::EnumOrInt,
    #[serde(default, rename = "kycLevel")]
    pub kyc_level: serde_json_wasm_value::EnumOrInt,
}

#[derive(Deserialize, Debug)]
struct QueryDidResponse {
    info: Option<DidInfo>,
}

/// proto3 字串欄位：tag (field 1, wire type 2) = 0x0a，接 varint 長度，再接 UTF-8 bytes
pub fn encode_query_did(address: &str) -> Binary {
    let bytes = address.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() + 6);
    out.push(0x0a);
    let mut len = bytes.len() as u64;
    loop {
        let mut b = (len & 0x7f) as u8;
        len >>= 7;
        if len != 0 {
            b |= 0x80;
        }
        out.push(b);
        if len == 0 {
            break;
        }
    }
    out.extend_from_slice(bytes);
    Binary::from(out)
}

pub fn status_is_active(s: &serde_json_wasm_value::EnumOrInt) -> bool {
    match s {
        serde_json_wasm_value::EnumOrInt::Str(v) => v == "DID_STATUS_ACTIVE",
        serde_json_wasm_value::EnumOrInt::Int(n) => *n == 1,
        serde_json_wasm_value::EnumOrInt::Missing => false,
    }
}

pub fn kyc_level_num(k: &serde_json_wasm_value::EnumOrInt) -> u8 {
    match k {
        serde_json_wasm_value::EnumOrInt::Str(v) => match v.as_str() {
            "KYC_LEVEL_ONE" => 1,
            "KYC_LEVEL_TWO" => 2,
            _ => 0,
        },
        serde_json_wasm_value::EnumOrInt::Int(n) => (*n).min(255) as u8,
        serde_json_wasm_value::EnumOrInt::Missing => 0,
    }
}

/// Ok(Some(info)) = 有 ME ID；Ok(None) = 查詢被鏈拒絕（通常是 DID not found）。錯誤字串放在第二個值。
pub fn query_did(querier: &QuerierWrapper<Empty>, address: &str) -> StdResult<(Option<DidInfo>, Option<String>)> {
    #[allow(deprecated)]
    let req: QueryRequest<Empty> = QueryRequest::Stargate { path: DID_QUERY_PATH.to_string(), data: encode_query_did(address) };
    let raw = to_json_vec(&req)?;
    match querier.raw_query(&raw) {
        SystemResult::Err(e) => Ok((None, Some(format!("system: {e}")))),
        SystemResult::Ok(ContractResult::Err(e)) => Ok((None, Some(e))),
        SystemResult::Ok(ContractResult::Ok(bin)) => {
            let resp: QueryDidResponse = cosmwasm_std::from_json(&bin)
                .map_err(|e| StdError::generic_err(format!("parse did response: {e}")))?;
            match resp.info {
                Some(info) if !info.did.is_empty() => Ok((Some(info), None)),
                _ => Ok((None, Some("empty did info".to_string()))),
            }
        }
    }
}

/// enum 欄位可能是字串（JSON 正常情況）或數字，兩種都收
pub mod serde_json_wasm_value {
    use serde::{Deserialize, Deserializer};

    #[derive(Debug, Clone, PartialEq, Default)]
    pub enum EnumOrInt {
        Str(String),
        Int(u64),
        #[default]
        Missing,
    }

    impl<'de> Deserialize<'de> for EnumOrInt {
        fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
            #[derive(Deserialize)]
            #[serde(untagged)]
            enum Raw {
                S(String),
                I(u64),
            }
            Ok(match Raw::deserialize(d)? {
                Raw::S(s) => EnumOrInt::Str(s),
                Raw::I(i) => EnumOrInt::Int(i),
            })
        }
    }

    impl EnumOrInt {
        pub fn as_string(&self) -> String {
            match self {
                EnumOrInt::Str(s) => s.clone(),
                EnumOrInt::Int(i) => i.to_string(),
                EnumOrInt::Missing => String::new(),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_query_did_like_protobuf() {
        let b = encode_query_did("me1qzxz57yv6sekvkaahgh6tj6cwqc4ntc6xakplw");
        assert_eq!(b.as_slice()[0], 0x0a);
        assert_eq!(b.as_slice()[1], 41);
        assert_eq!(&b.as_slice()[2..], b"me1qzxz57yv6sekvkaahgh6tj6cwqc4ntc6xakplw");
    }

    #[test]
    fn parses_real_testnet_shape() {
        // 2026-11-24 測試網 REST 實際回應（與 Stargate JSON 同一個 codec）
        let json = br#"{"info":{"did":"2605105872869","address":"me1qzxz57yv6sekvkaahgh6tj6cwqc4ntc6xakplw","pubkey":"{\"@type\": \"/cosmos.crypto.secp256k1.PubKey\",\"key\": \"\"}","status":"DID_STATUS_ACTIVE","regionId":"me_earth","kycLevel":"KYC_LEVEL_TWO","sub_account":""}}"#;
        let r: QueryDidResponse = cosmwasm_std::from_json(json).unwrap();
        let info = r.info.unwrap();
        assert!(status_is_active(&info.status));
        assert_eq!(kyc_level_num(&info.kyc_level), 2);
    }
}
