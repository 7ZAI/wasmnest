//! Plugin Types（2026-10-25 按域拆分，本文件只做再导出，`types::*` 外部路径不变）

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

mod contributions;
mod manifest;
mod state;

#[cfg(test)]
mod tests;

pub use contributions::*;
pub use manifest::*;
pub use state::*;
