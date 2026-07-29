use serde::{Deserialize, Serialize};

pub const MAX_WORKSPACE_GENERATION: u64 = 9_007_199_254_740_991;
pub const MAX_WORKSPACE_DISPLAY_LABEL_BYTES: usize = 128;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkspaceClosedReason {
    Cancelled,
    PermissionDenied,
    Invalid,
    Unavailable,
    Unsafe,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WorkspaceRootIdentity {
    device: u64,
    inode: u64,
}

impl WorkspaceRootIdentity {
    pub const fn new(device: u64, inode: u64) -> Self {
        Self { device, inode }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidatedWorkspace {
    display_label: String,
    root_identity: WorkspaceRootIdentity,
}

impl ValidatedWorkspace {
    pub fn new(
        root_identity: WorkspaceRootIdentity,
        display_label: String,
    ) -> Result<Self, WorkspaceError> {
        if display_label.trim().is_empty()
            || display_label.len() > MAX_WORKSPACE_DISPLAY_LABEL_BYTES
            || display_label.chars().any(char::is_control)
        {
            return Err(WorkspaceError::InvalidDisplayLabel);
        }
        Ok(Self {
            display_label,
            root_identity,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceBinding {
    generation: u64,
    selection: ValidatedWorkspace,
}

impl WorkspaceBinding {
    pub const fn generation(&self) -> u64 {
        self.generation
    }

    pub const fn root_identity(&self) -> WorkspaceRootIdentity {
        self.selection.root_identity
    }

    pub fn display_label(&self) -> &str {
        &self.selection.display_label
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum WorkspaceView {
    Empty {
        generation: u64,
    },
    Selecting {
        generation: u64,
    },
    Bound {
        generation: u64,
        #[serde(rename = "displayLabel")]
        display_label: String,
    },
    Closed {
        generation: u64,
        reason: WorkspaceClosedReason,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceError {
    GenerationExhausted,
    InvalidDisplayLabel,
    StaleGeneration,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum WorkspaceState {
    Empty,
    Selecting,
    Bound(WorkspaceBinding),
    Closed(WorkspaceClosedReason),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceApplication {
    generation: u64,
    state: WorkspaceState,
}

impl Default for WorkspaceApplication {
    fn default() -> Self {
        Self {
            generation: 0,
            state: WorkspaceState::Empty,
        }
    }
}

impl WorkspaceApplication {
    pub const fn current_generation(&self) -> u64 {
        self.generation
    }

    pub fn begin_selection(&mut self) -> Result<u64, WorkspaceError> {
        let generation = self.advance_generation()?;
        self.state = WorkspaceState::Selecting;
        Ok(generation)
    }

    pub fn clear(&mut self) -> Result<u64, WorkspaceError> {
        let generation = self.advance_generation()?;
        self.state = WorkspaceState::Empty;
        Ok(generation)
    }

    pub fn accept_selection(
        &mut self,
        generation: u64,
        selection: ValidatedWorkspace,
    ) -> Result<(), WorkspaceError> {
        self.ensure_selecting(generation)?;
        self.state = WorkspaceState::Bound(WorkspaceBinding {
            generation,
            selection,
        });
        Ok(())
    }

    pub fn close_selection(
        &mut self,
        generation: u64,
        reason: WorkspaceClosedReason,
    ) -> Result<(), WorkspaceError> {
        self.ensure_selecting(generation)?;
        self.state = WorkspaceState::Closed(reason);
        Ok(())
    }

    pub fn close_binding(
        &mut self,
        generation: u64,
        reason: WorkspaceClosedReason,
    ) -> Result<(), WorkspaceError> {
        if self.binding(generation).is_none() {
            return Err(WorkspaceError::StaleGeneration);
        }
        self.state = WorkspaceState::Closed(reason);
        Ok(())
    }

    pub fn close_if_current(&mut self, generation: u64, reason: WorkspaceClosedReason) -> bool {
        let is_current = match &self.state {
            WorkspaceState::Selecting => self.generation == generation,
            WorkspaceState::Bound(binding) => binding.generation == generation,
            WorkspaceState::Empty | WorkspaceState::Closed(_) => false,
        };
        if is_current {
            self.state = WorkspaceState::Closed(reason);
        }
        is_current
    }

    pub fn binding(&self, generation: u64) -> Option<&WorkspaceBinding> {
        match &self.state {
            WorkspaceState::Bound(binding) if binding.generation == generation => Some(binding),
            _ => None,
        }
    }

    pub fn view(&self) -> WorkspaceView {
        match &self.state {
            WorkspaceState::Empty => WorkspaceView::Empty {
                generation: self.generation,
            },
            WorkspaceState::Selecting => WorkspaceView::Selecting {
                generation: self.generation,
            },
            WorkspaceState::Bound(binding) => WorkspaceView::Bound {
                generation: binding.generation,
                display_label: binding.selection.display_label.clone(),
            },
            WorkspaceState::Closed(reason) => WorkspaceView::Closed {
                generation: self.generation,
                reason: *reason,
            },
        }
    }

    fn ensure_selecting(&self, generation: u64) -> Result<(), WorkspaceError> {
        if generation == self.generation && self.state == WorkspaceState::Selecting {
            Ok(())
        } else {
            Err(WorkspaceError::StaleGeneration)
        }
    }

    fn advance_generation(&mut self) -> Result<u64, WorkspaceError> {
        let generation = self
            .generation
            .checked_add(1)
            .filter(|generation| *generation <= MAX_WORKSPACE_GENERATION)
            .ok_or(WorkspaceError::GenerationExhausted)?;
        self.generation = generation;
        Ok(generation)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reselection_invalidates_the_old_binding_before_a_cancelled_picker_returns() {
        let mut application = WorkspaceApplication::default();
        let first_generation = application.begin_selection().expect("first generation");
        application
            .accept_selection(
                first_generation,
                ValidatedWorkspace::new(
                    WorkspaceRootIdentity::new(7, 11),
                    "Keiko Native".to_owned(),
                )
                .expect("validated workspace"),
            )
            .expect("current selection");

        let second_generation = application.begin_selection().expect("next generation");
        assert_ne!(second_generation, first_generation);
        assert!(application.binding(first_generation).is_none());
        application
            .close_selection(second_generation, WorkspaceClosedReason::Cancelled)
            .expect("current cancellation");

        assert_eq!(
            application.view(),
            WorkspaceView::Closed {
                generation: second_generation,
                reason: WorkspaceClosedReason::Cancelled,
            }
        );
        assert!(application.binding(second_generation).is_none());
    }

    #[test]
    fn clearing_a_binding_retires_its_generation_and_rejects_late_completion() {
        let mut application = WorkspaceApplication::default();
        let first_generation = application.begin_selection().expect("first generation");
        let next_generation = application.clear().expect("clear generation");

        assert_ne!(next_generation, first_generation);
        assert_eq!(
            application.accept_selection(
                first_generation,
                ValidatedWorkspace::new(WorkspaceRootIdentity::new(7, 11), "stale".to_owned(),)
                    .expect("validated workspace"),
            ),
            Err(WorkspaceError::StaleGeneration)
        );
        assert_eq!(
            application.view(),
            WorkspaceView::Empty {
                generation: next_generation,
            }
        );
    }

    #[test]
    fn display_labels_are_bounded_unicode_without_control_characters() {
        for rejected in [
            String::new(),
            "   ".to_owned(),
            "unsafe\nlabel".to_owned(),
            "x".repeat(MAX_WORKSPACE_DISPLAY_LABEL_BYTES + 1),
        ] {
            assert_eq!(
                ValidatedWorkspace::new(WorkspaceRootIdentity::new(7, 11), rejected),
                Err(WorkspaceError::InvalidDisplayLabel)
            );
        }
        assert!(
            ValidatedWorkspace::new(
                WorkspaceRootIdentity::new(7, 11),
                "Grüße かな 😀".to_owned(),
            )
            .is_ok()
        );
    }

    #[test]
    fn revalidation_failure_closes_only_the_current_bound_generation() {
        let mut application = WorkspaceApplication::default();
        let generation = application.begin_selection().expect("generation");
        application
            .accept_selection(
                generation,
                ValidatedWorkspace::new(
                    WorkspaceRootIdentity::new(7, 11),
                    "Keiko Native".to_owned(),
                )
                .expect("validated workspace"),
            )
            .expect("binding");

        assert_eq!(
            application.close_binding(generation - 1, WorkspaceClosedReason::Unsafe),
            Err(WorkspaceError::StaleGeneration)
        );
        application
            .close_binding(generation, WorkspaceClosedReason::Unavailable)
            .expect("current binding");
        assert_eq!(
            application.view(),
            WorkspaceView::Closed {
                generation,
                reason: WorkspaceClosedReason::Unavailable,
            }
        );
        assert!(application.binding(generation).is_none());
    }

    #[test]
    fn cleanup_closes_only_the_current_selecting_or_bound_generation() {
        let mut application = WorkspaceApplication::default();
        let selecting = application.begin_selection().expect("selecting generation");
        assert!(!application.close_if_current(selecting + 1, WorkspaceClosedReason::Unavailable));
        assert_eq!(
            application.view(),
            WorkspaceView::Selecting {
                generation: selecting,
            }
        );
        assert!(application.close_if_current(selecting, WorkspaceClosedReason::Unavailable));

        let bound = application.begin_selection().expect("bound generation");
        application
            .accept_selection(
                bound,
                ValidatedWorkspace::new(
                    WorkspaceRootIdentity::new(7, 11),
                    "Keiko Native".to_owned(),
                )
                .expect("validated workspace"),
            )
            .expect("binding");
        assert!(application.close_if_current(bound, WorkspaceClosedReason::Cancelled));
        assert!(!application.close_if_current(bound, WorkspaceClosedReason::Cancelled));
    }

    #[test]
    fn binding_contract_exposes_only_identity_label_and_current_generation() {
        let mut application = WorkspaceApplication::default();
        assert_eq!(application.view(), WorkspaceView::Empty { generation: 0 });
        assert_eq!(application.current_generation(), 0);
        let generation = application.begin_selection().expect("generation");
        assert_eq!(application.view(), WorkspaceView::Selecting { generation });
        application
            .accept_selection(
                generation,
                ValidatedWorkspace::new(
                    WorkspaceRootIdentity::new(17, 23),
                    "Repository".to_owned(),
                )
                .expect("validated workspace"),
            )
            .expect("binding");
        let binding = application.binding(generation).expect("current binding");
        assert_eq!(binding.generation(), generation);
        assert_eq!(binding.root_identity(), WorkspaceRootIdentity::new(17, 23));
        assert_eq!(binding.display_label(), "Repository");
        assert_eq!(
            application.view(),
            WorkspaceView::Bound {
                generation,
                display_label: "Repository".to_owned(),
            }
        );
    }

    #[test]
    fn generation_exhaustion_fails_without_changing_the_current_state() {
        let mut application = WorkspaceApplication {
            generation: MAX_WORKSPACE_GENERATION,
            state: WorkspaceState::Empty,
        };
        assert_eq!(
            application.begin_selection(),
            Err(WorkspaceError::GenerationExhausted)
        );
        assert_eq!(
            application.clear(),
            Err(WorkspaceError::GenerationExhausted)
        );
        assert_eq!(
            application.view(),
            WorkspaceView::Empty {
                generation: MAX_WORKSPACE_GENERATION,
            }
        );
    }
}
