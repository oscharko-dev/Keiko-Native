use std::time::Instant;

use keiko_ui_port::ReasonCode;

#[derive(Debug)]
pub(crate) struct InFlight {
    pub(crate) cancelled_at_ms: Option<u64>,
    pub(crate) generation: u64,
    pub(crate) started_at_ms: u64,
    pub(crate) timeout_ms: u16,
}

#[derive(Debug)]
pub(crate) struct MonotonicClock {
    origin: Instant,
    #[cfg(test)]
    test_now_ms: Option<u64>,
}

impl Default for MonotonicClock {
    fn default() -> Self {
        Self {
            origin: Instant::now(),
            #[cfg(test)]
            test_now_ms: None,
        }
    }
}

impl MonotonicClock {
    pub(crate) fn now_ms(&self) -> u64 {
        #[cfg(test)]
        if let Some(now_ms) = self.test_now_ms {
            return now_ms;
        }
        u64::try_from(self.origin.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    #[cfg(test)]
    pub(crate) fn set_test_now_ms(&mut self, now_ms: u64) {
        self.test_now_ms = Some(now_ms);
    }
}

pub(crate) fn terminal_reason(
    in_flight: &InFlight,
    completed_at_ms: u64,
    host_available: bool,
) -> Option<ReasonCode> {
    if !host_available {
        return Some(ReasonCode::HostUnavailable);
    }
    if in_flight.cancelled_at_ms.is_some_and(|cancelled_at_ms| {
        cancelled_at_ms.saturating_sub(in_flight.started_at_ms) < u64::from(in_flight.timeout_ms)
    }) {
        return Some(ReasonCode::Cancelled);
    }
    if completed_at_ms.saturating_sub(in_flight.started_at_ms) >= u64::from(in_flight.timeout_ms) {
        return Some(ReasonCode::TimedOut);
    }
    None
}
