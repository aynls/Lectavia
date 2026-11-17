use std::{collections::HashMap, future::Future, sync::Mutex};

use tauri::State;
use tokio::sync::watch;

use crate::error::AppError;

#[derive(Default)]
pub struct TaskRuns(Mutex<HashMap<String, watch::Sender<()>>>);

impl TaskRuns {
    pub fn subscribe(&self, run_id: &str) -> Result<watch::Receiver<()>, AppError> {
        self.0
            .lock()
            .unwrap()
            .get(run_id)
            .map(watch::Sender::subscribe)
            .ok_or_else(|| "error.taskCancelled".into())
    }

    pub async fn run<T>(
        &self,
        run_id: &str,
        operation: impl Future<Output = Result<T, AppError>>,
    ) -> Result<T, AppError> {
        let mut cancellation = self.subscribe(run_id)?;
        tokio::select! {
            biased;
            _ = cancellation.changed() => Err("error.taskCancelled".into()),
            result = operation => result,
        }
    }
}

#[tauri::command]
pub fn begin_task_run(runs: State<'_, TaskRuns>, run_id: String) {
    runs.0
        .lock()
        .unwrap()
        .entry(run_id)
        .or_insert_with(|| watch::channel(()).0);
}

#[tauri::command]
pub fn end_task_run(runs: State<'_, TaskRuns>, run_id: String) {
    // Dropping the sender wakes every operation still waiting on this run.
    runs.0.lock().unwrap().remove(&run_id);
}
