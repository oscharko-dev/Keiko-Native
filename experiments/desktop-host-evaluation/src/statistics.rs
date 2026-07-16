use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct OrderedSamples(Vec<f64>);

impl OrderedSamples {
    pub fn new(samples: Vec<f64>) -> Result<Self, StatisticsError> {
        if samples.is_empty() {
            return Err(StatisticsError::Empty);
        }
        if samples
            .iter()
            .any(|value| !value.is_finite() || *value < 0.0)
        {
            return Err(StatisticsError::Invalid);
        }
        Ok(Self(samples))
    }

    pub fn raw(&self) -> &[f64] {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
pub struct Distribution {
    pub minimum: f64,
    pub p50: f64,
    pub p75: f64,
    pub p95: f64,
    pub maximum: f64,
}

impl Distribution {
    pub fn from_samples(samples: &OrderedSamples) -> Self {
        let mut sorted = samples.0.clone();
        sorted.sort_by(f64::total_cmp);
        Self {
            minimum: sorted[0],
            p50: nearest_rank(&sorted, 50),
            p75: nearest_rank(&sorted, 75),
            p95: nearest_rank(&sorted, 95),
            maximum: sorted[sorted.len() - 1],
        }
    }
}

fn nearest_rank(sorted: &[f64], percentile: usize) -> f64 {
    let rank = (percentile * sorted.len()).div_ceil(100);
    sorted[rank.saturating_sub(1)]
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum StatisticsError {
    #[error("at least one sample is required")]
    Empty,
    #[error("samples must be finite and non-negative")]
    Invalid,
}
