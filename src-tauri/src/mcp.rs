pub(crate) mod desktop;
mod stdio_server;

use rmcp::{
    ServerHandler,
    handler::server::wrapper::Parameters,
    model::{CallToolResult, Implementation, ServerCapabilities, ServerConfig},
    tool, tool_handler, tool_router,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{
    error::AppError,
    locale::Locale,
    tasks::{GenerationRequest, Tasks},
};

#[derive(Clone)]
struct Lectavia {
    tasks: Tasks,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct InspectVideo {
    /// Local video path or HTTPS Bilibili / YouTube video URL.
    video: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct JobId {
    job_id: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct JobSelection {
    job_id: String,
    /// Part IDs from get_job. Omit to select the whole job.
    part_ids: Option<Vec<String>>,
}

fn response<T: Serialize>(result: Result<T, AppError>) -> CallToolResult {
    match result {
        Ok(value) => CallToolResult::structured(json!(value)),
        Err(error) => CallToolResult::structured_error(json!({
            "error": error,
            "message": Locale::En.error(&error),
        })),
    }
}

#[tool_router]
impl Lectavia {
    #[tool(description = "Inspect video metadata and available Bilibili parts.")]
    async fn inspect_video(&self, Parameters(input): Parameters<InspectVideo>) -> CallToolResult {
        response(self.tasks.inspect_video(input.video).await)
    }

    #[tool(
        description = "Generate local md or txt files. Supply video (with optional Bilibili parts) or transcript_paths. \
                       Document mode automatically uses Lectavia's built-in editing prompt. Pass instructions only \
                       when the user asks for extra editing requirements. For speech recognition only, use transcript \
                       mode and omit instructions. Returns job_id immediately. Poll get_job for output paths and read \
                       the files directly."
    )]
    fn generate_document(
        &self,
        Parameters(input): Parameters<GenerationRequest>,
    ) -> CallToolResult {
        response(
            self.tasks
                .submit(input, None)
                .map(|id| json!({ "job_id": id })),
        )
    }

    #[tool(
        description = "Get task status, per-part progress, errors and absolute output_path values. Read completed files directly using their paths."
    )]
    fn get_job(&self, Parameters(input): Parameters<JobId>) -> CallToolResult {
        response(self.tasks.get(&input.job_id))
    }

    #[tool(
        description = "Cancel pending or running work for a job or selected parts. Completed files stay available."
    )]
    fn cancel_job(&self, Parameters(input): Parameters<JobSelection>) -> CallToolResult {
        response(self.tasks.cancel(&input.job_id, input.part_ids.as_deref()))
    }
}

#[tool_handler]
impl ServerHandler for Lectavia {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build()).with_server_info(
            Implementation::new("lectavia-mcp", env!("CARGO_PKG_VERSION")),
        )
    }
}
