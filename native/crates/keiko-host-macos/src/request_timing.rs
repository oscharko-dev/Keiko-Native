use std::time::Instant;

use keiko_ui_port::ReasonCode;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CancellationSource {
    User,
    RendererLost,
    AppShutdown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct AcceptedCancellation {
    pub(crate) accepted_at: Instant,
    pub(crate) source: CancellationSource,
}

#[derive(Debug)]
pub(crate) struct InFlight {
    pub(crate) accepted_cancellation: Option<AcceptedCancellation>,
    pub(crate) cancelled_at_ms: Option<u64>,
    pub(crate) cancellation_source: Option<CancellationSource>,
    pub(crate) generation: u64,
    pub(crate) runtime_owned: bool,
    pub(crate) started_at_ms: u64,
    pub(crate) timeout_ms: u32,
}

impl InFlight {
    pub(crate) fn cancel(
        &mut self,
        now_ms: u64,
        accepted_at: Instant,
        source: CancellationSource,
    ) -> AcceptedCancellation {
        if self.accepted_cancellation.is_none() {
            self.accepted_cancellation = Some(AcceptedCancellation {
                accepted_at,
                source,
            });
            self.cancelled_at_ms = Some(now_ms);
            self.cancellation_source = Some(source);
        }
        self.accepted_cancellation.unwrap_or(AcceptedCancellation {
            accepted_at,
            source,
        })
    }
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

    pub(crate) fn now(&self) -> Instant {
        #[cfg(test)]
        if let Some(now_ms) = self.test_now_ms {
            return self
                .origin
                .checked_add(std::time::Duration::from_millis(now_ms))
                .unwrap_or(self.origin);
        }
        Instant::now()
    }

    #[cfg(test)]
    pub(crate) fn set_test_now_ms(&mut self, now_ms: u64) {
        self.test_now_ms = Some(now_ms);
    }
}

pub(crate) fn terminal_cutoff_exceeded(now: Instant, cutoff: Instant) -> bool {
    now > cutoff
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

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::{CancellationSource, InFlight, terminal_cutoff_exceeded};

    #[test]
    fn terminal_cutoff_is_exceeded_only_after_five_seconds() {
        let accepted_at = Instant::now();
        let cutoff = accepted_at + Duration::from_secs(5);
        for (elapsed_ms, expected) in [(4_999, false), (5_000, false), (5_001, true)] {
            assert_eq!(
                terminal_cutoff_exceeded(accepted_at + Duration::from_millis(elapsed_ms), cutoff,),
                expected,
                "elapsed {elapsed_ms}ms"
            );
        }
    }

    #[test]
    fn repeated_cancellation_preserves_the_first_acceptance() {
        let first_at = Instant::now();
        let mut in_flight = InFlight {
            accepted_cancellation: None,
            cancelled_at_ms: None,
            cancellation_source: None,
            generation: 1,
            runtime_owned: true,
            started_at_ms: 10,
            timeout_ms: 5_000,
        };
        let first = in_flight.cancel(20, first_at, CancellationSource::RendererLost);
        let replay = in_flight.cancel(
            30,
            first_at + Duration::from_millis(10),
            CancellationSource::AppShutdown,
        );

        assert_eq!(replay, first);
        assert_eq!(in_flight.cancelled_at_ms, Some(20));
        assert_eq!(
            in_flight.cancellation_source,
            Some(CancellationSource::RendererLost)
        );
    }
}
