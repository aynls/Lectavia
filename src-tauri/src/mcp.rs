mod jobs;

use jobs::{Jobs, VideoInput};
use std::process::ExitCode;

use rmcp::{
    ServerHandler, ServiceExt,
    handler::server::wrapper::Parameters,
    model::{CallToolResult, Implementation, ServerCapabilities, ServerConfig},
    tool, tool_handler, tool_router,
    transport::stdio,
};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    error::AppError,
    locale::Locale,
    media::MediaTools,
    video::{inspect, parse_source},
};

#[derive(Clone)]
struct Lectavia {
    jobs: Jobs,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct InspectVideo {
    /// Local video path or HTTPS Bilibili / YouTube video URL.
    video: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct TranscriptionRequest {
    /// Unique to this operation. Reuse the same value when resending it.
    request_id: String,
    #[serde(flatten)]
    source: VideoInput,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct JobId {
    job_id: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ReadResult {
    /// A transcript_id or document_id returned by get_job.
    result_id: String,
    /// Omit on the first page, then pass the exact next_cursor.
    cursor: Option<usize>,
    /// Maximum Unicode characters on this page (default 4000).
    #[schemars(range(min = 1, max = 16000))]
    limit: Option<usize>,
}

fn response(result: Result<Value, AppError>) -> CallToolResult {
    match result {
        Ok(value) => CallToolResult::structured(value),
        Err(error) => CallToolResult::structured_error(json!({
            "error": error,
            "message": Locale::En.error(&error),
        })),
    }
}

#[tool_router]
impl Lectavia {
    #[tool(
        description = "Read one page of a transcript or document. Continue with next_cursor until it is null."
    )]
    fn read_result(&self, Parameters(input): Parameters<ReadResult>) -> CallToolResult {
        response(self.jobs.read(
            &input.result_id,
            input.cursor.unwrap_or(0),
            input.limit.unwrap_or(4000),
        ))
    }
    #[tool(
        description = "Get job status, current phase, and the status, results and errors of each selected part."
    )]
    fn get_job(&self, Parameters(input): Parameters<JobId>) -> CallToolResult {
        response(self.jobs.snapshot(&input.job_id))
    }
    #[tool(
        description = "Submit raw video transcription. Returns job_id immediately. Poll get_job, then use read_result with each transcript_id."
    )]
    fn transcribe_video(
        &self,
        Parameters(input): Parameters<TranscriptionRequest>,
    ) -> CallToolResult {
        response(self.jobs.submit(input.request_id, input.source))
    }

    #[tool(description = "Inspect video metadata and available Bilibili parts.")]
    async fn inspect_video(&self, Parameters(input): Parameters<InspectVideo>) -> CallToolResult {
        response(
            async {
                let video = inspect(&MediaTools::cli(), parse_source(input.video.into())?).await?;
                let parts: Vec<_> = video
                    .parts
                    .iter()
                    .map(|part| {
                        json!({
                            "number": part.number, "title": part.title
                        })
                    })
                    .collect();
                Ok(json!({
                    "title": video.title, "description": video.description,
                    "preferred_part": video.preferred_part, "parts": parts,
                }))
            }
            .await,
        )
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

#[tokio::main(flavor = "current_thread")]
pub async fn run() -> ExitCode {
    let result: Result<(), Box<dyn std::error::Error>> = async {
        let server = Lectavia { jobs: Jobs::new()? };
        server.serve(stdio()).await?.waiting().await?;
        Ok(())
    }
    .await;
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("lectavia-mcp: {error}");
            ExitCode::FAILURE
        }
    }
}
