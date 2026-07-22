#[derive(Debug, Default)]
pub(crate) struct AcknowledgementState {
    emitted: bool,
    first_health_succeeded: bool,
}

impl AcknowledgementState {
    pub(crate) fn record_success(&mut self, sequence: u64) -> bool {
        if sequence == 1 {
            self.first_health_succeeded = true;
            return false;
        }
        if sequence == 2 && self.first_health_succeeded && !self.emitted {
            self.emitted = true;
            return true;
        }
        false
    }
}
