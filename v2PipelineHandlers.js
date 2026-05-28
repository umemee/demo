// v2PipelineHandlers.js
const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");

const config = require("./config.js");
const utils = require("./utils.js");
const v2Handlers = require("./v2Handlers.js");

const { REPO_ROOT, V2_PIPELINE_RUNS_DIR, V2_CANDIDATE_RETRIEVAL_DIR, V2_AI_MATCHER_PACKAGE_DIR, V2_SAFE_INPUT_VALUE_FIELDS } = config;
const { json, slugify, readRequestBody, toRepoPath, hasMeaningfulValue } = utils;
const { loadV2SafeInputFromPath, retrieveV2CandidatePrograms, buildV2CandidateRetrievalResult, prepareV2PipelineArtifactsFromSafeInput, loadV2ProgramIndex, buildV2AiMatcherPackage, sanitizeV2PackageId, findV2SensitivePackageFieldPaths, normalizeToV2SafeInput } = v2Handlers;

// ✂️ 👇 2번 단계에서 v2Handlers.js로부터 잘라낸 3개의 함수를 이 아래에 붙여넣으세요! 👇 ✂️

async function handleRetrieveV2Candidates(req, res) {
  const now = new Date().toISOString();
  let retrievalId = null;
  let caseId = null;
  let sourceSafeInputPath = null;

  try {
    const contentType = String(req.headers["content-type"] || "");
    if (!contentType.includes("application/json")) {
      return json(res, 415, { ok: false, error: "application/json request body is required." });
    }

    const body = await readRequestBody(req);
    let payload;
    try {
      payload = JSON.parse(body || "{}");
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON request body." });
    }

    let safeInput = null;
    if (payload.safe_input_path || payload.v2_safe_input_path) {
      const loaded = await loadV2SafeInputFromPath(payload.safe_input_path || payload.v2_safe_input_path);
      sourceSafeInputPath = loaded.safeInputPath;
      safeInput = loaded.safeInput;
    } else if (payload.safe_input && typeof payload.safe_input === "object" && !Array.isArray(payload.safe_input)) {
      safeInput = payload.safe_input;
    } else if (payload.v2_safe_input && typeof payload.v2_safe_input === "object" && !Array.isArray(payload.v2_safe_input)) {
      safeInput = payload.v2_safe_input;
    } else {
      const directFieldHints = V2_SAFE_INPUT_VALUE_FIELDS.some((field) => hasMeaningfulValue(payload?.[field])) || hasMeaningfulValue(payload?.fields_needing_confirmation);
      if (directFieldHints || payload.schema_version || payload.safe_input_only) {
        safeInput = payload;
      }
    }

    if (!safeInput || typeof safeInput !== "object" || Array.isArray(safeInput)) {
      return json(res, 400, {
        ok: false,
        error: "A V2 safe input object or a safe_input_path under app_v1/runtime/v2_safe_input/ is required."
      });
    }

    caseId = slugify(payload.case_id || safeInput.case_id || safeInput.company_name_or_alias || safeInput.company_name || payload.retrieval_id || `v2_candidate_${now}`);
    retrievalId = slugify(payload.retrieval_id || safeInput.retrieval_id || caseId || `v2_candidate_${now}`);

    const programIndex = await loadV2ProgramIndex();
    const retrieval = retrieveV2CandidatePrograms(safeInput, {
      retrieval_id: retrievalId,
      case_id: caseId,
      program_index: programIndex
    });
    const result = buildV2CandidateRetrievalResult({
      retrievalId,
      caseId,
      sourceSafeInputPath,
      safeInput,
      programIndex,
      retrieval
    });

    await fs.mkdir(V2_CANDIDATE_RETRIEVAL_DIR, { recursive: true });
    const outputPath = path.join(V2_CANDIDATE_RETRIEVAL_DIR, `${retrievalId}_candidates.json`);
    await fs.writeFile(outputPath, JSON.stringify(result, null, 2), "utf8");

    return json(res, 200, {
      ...result,
      source_safe_input_path: result.source_safe_input_path,
      retrieval_output_path: toRepoPath(outputPath),
      message: "V2 candidate retrieval completed locally. No AI matcher was invoked."
    });
  } catch (error) {
    return json(res, 500, {
      ok: false,
      case_id: caseId,
      retrieval_id: retrievalId,
      source_safe_input_path: sourceSafeInputPath ? toRepoPath(sourceSafeInputPath) : null,
      error: error.message
    });
  }
}

async function handleBuildV2AiMatcherPackage(req, res) {
  const now = new Date();
  let packageId = null;
  try {
    const contentType = String(req.headers["content-type"] || "");
    if (!contentType.includes("application/json")) {
      return json(res, 415, { ok: false, error: "application/json request body is required." });
    }

    const body = await readRequestBody(req);
    let payload;
    try {
      payload = JSON.parse(body || "{}");
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON request body." });
    }

    packageId = sanitizeV2PackageId(payload.package_id || payload.package_name || payload.case_id || payload.retrieval_id || payload.safe_input?.company_name_or_alias || "v2_ai_package", now);
    const safeInputPath = payload.safe_input_path || payload.v2_safe_input_path || null;
    const candidateRetrievalPath = payload.candidate_retrieval_path || payload.retrieval_path || null;
    if (!candidateRetrievalPath) {
      return json(res, 400, { ok: false, package_id: packageId, error: "candidate_retrieval_path is required." });
    }

    let safeInput = null;
    let resolvedSafeInputPath = null;
    if (safeInputPath) {
      const loaded = await loadV2SafeInputFromPath(safeInputPath);
      safeInput = loaded.safeInput;
      resolvedSafeInputPath = loaded.safeInputPath;
    } else if (payload.safe_input && typeof payload.safe_input === "object" && !Array.isArray(payload.safe_input)) {
      safeInput = payload.safe_input;
    } else if (payload.v2_safe_input && typeof payload.v2_safe_input === "object" && !Array.isArray(payload.v2_safe_input)) {
      safeInput = payload.v2_safe_input;
    } else {
      return json(res, 400, { ok: false, package_id: packageId, error: "A safe_input object or safe_input_path is required." });
    }

    const sensitivePaths = findV2SensitivePackageFieldPaths(safeInput);
    if (sensitivePaths.length) {
      return json(res, 400, {
        ok: false,
        package_id: packageId,
        error: `Rejected unsafe safe input fields: ${sensitivePaths.join(", ")}`
      });
    }

    const packageInfo = await buildV2AiMatcherPackage({
      safeInput,
      safeInputPath: resolvedSafeInputPath,
      candidateRetrievalPath,
      packageId,
      now
    });

    return json(res, 200, {
      ok: true,
      ...packageInfo,
      message: "V2 AI matcher package built locally. No AI matcher was run."
    });
  } catch (error) {
    return json(res, 500, {
      ok: false,
      package_id: packageId,
      error: error.message
    });
  }
}

async function handleRunV2Pipeline(req, res) {
  const now = new Date();
  let caseId = null;
  let safeInputPath = null;
  let candidateRetrievalPath = null;
  let candidateRetrievalSourcePath = null;
  let packageId = null;
  let packagePath = null;
  let sourceSafeInputPath = null;
  try {
    const contentType = String(req.headers["content-type"] || "");
    if (!contentType.includes("application/json")) {
      return json(res, 415, { ok: false, error: "application/json request body is required." });
    }

    const body = await readRequestBody(req);
    let payload;
    try {
      payload = JSON.parse(body || "{}");
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON request body." });
    }

    const payloadSensitivePaths = findV2SensitivePackageFieldPaths(payload);
    if (payloadSensitivePaths.length) {
      return json(res, 400, {
        ok: false,
        v2_pipeline_step: "rejected_unsafe_input",
        case_id: null,
        safe_input_path: null,
        candidate_retrieval_path: null,
        package_path: null,
        package_id: null,
        candidate_count: 0,
        ai_matcher_run: false,
        result_view_model_created: false,
        live_top2_replaced: false,
        privacy_boundary_status: "blocked_raw_text_input",
        warnings: [`Unsafe input fields were rejected: ${payloadSensitivePaths.join(", ")}`],
        next_manual_step: "Remove raw PDF/OCR/upload text and resend confirmed safe input only."
      });
    }

    let safeInput = null;
    if (payload.safe_input_path || payload.v2_safe_input_path) {
      const loaded = await loadV2SafeInputFromPath(payload.safe_input_path || payload.v2_safe_input_path);
      safeInput = loaded.safeInput;
      sourceSafeInputPath = loaded.safeInputPath;
    } else if (payload.safe_input && typeof payload.safe_input === "object" && !Array.isArray(payload.safe_input)) {
      safeInput = payload.safe_input;
    } else if (payload.v2_safe_input && typeof payload.v2_safe_input === "object" && !Array.isArray(payload.v2_safe_input)) {
      safeInput = payload.v2_safe_input;
    } else if (payload.candidate_values && typeof payload.candidate_values === "object" && !Array.isArray(payload.candidate_values)) {
      safeInput = normalizeToV2SafeInput(payload.candidate_values, {
        synthetic_fixture: Boolean(payload.synthetic_fixture),
        schema_version: payload.schema_version || "v2_safe_input_draft",
        user_confirmed_fields: payload.user_confirmed_fields || payload.confirmed_fields || []
      });
    }

    if (!safeInput || typeof safeInput !== "object" || Array.isArray(safeInput)) {
      return json(res, 400, {
        ok: false,
        v2_pipeline_step: "missing_safe_input",
        case_id: null,
        safe_input_path: null,
        candidate_retrieval_path: null,
        package_path: null,
        package_id: null,
        candidate_count: 0,
        ai_matcher_run: false,
        result_view_model_created: false,
        live_top2_replaced: false,
        privacy_boundary_status: "missing_safe_input",
        warnings: ["A safe_input object, safe_input_path, or candidate_values object is required."],
        next_manual_step: "Provide confirmed safe input or candidate values and run again."
      });
    }

    const safeInputSensitivePaths = findV2SensitivePackageFieldPaths(safeInput);
    if (safeInputSensitivePaths.length) {
      return json(res, 400, {
        ok: false,
        v2_pipeline_step: "rejected_unsafe_safe_input",
        case_id: null,
        safe_input_path: null,
        candidate_retrieval_path: null,
        package_path: null,
        package_id: null,
        candidate_count: 0,
        ai_matcher_run: false,
        result_view_model_created: false,
        live_top2_replaced: false,
        privacy_boundary_status: "blocked_raw_text_input",
        warnings: [`Unsafe safe input fields were rejected: ${safeInputSensitivePaths.join(", ")}`],
        next_manual_step: "Remove raw PDF/OCR/upload text from the payload and resend confirmed safe input only."
      });
    }

    const prepared = await prepareV2PipelineArtifactsFromSafeInput(payload, safeInput, {
      sourceSafeInputPath,
      safeInputPath,
      now
    });
    return json(res, prepared.statusCode, prepared.body);
  } catch (error) {
    return json(res, 500, {
      ok: false,
      v2_pipeline_step: "error",
      case_id: caseId,
      safe_input_path: safeInputPath ? toRepoPath(safeInputPath) : null,
      candidate_retrieval_path: candidateRetrievalPath ? toRepoPath(candidateRetrievalPath) : null,
      package_path: packagePath || null,
      package_id: packageId,
      candidate_count: 0,
      ai_matcher_run: false,
      result_view_model_created: false,
      live_top2_replaced: false,
      privacy_boundary_status: "error",
      warnings: [error.message],
      next_manual_step: "Inspect the error, then rerun with confirmed safe input only."
    });
  }
}

// ✂️ 👆 여기까지 붙여넣으세요! 👆 ✂️

// 메인 서버와 다른 파일에서 쓸 수 있게 내보냅니다.
module.exports = {
  handleRetrieveV2Candidates,
  handleBuildV2AiMatcherPackage,
  handleRunV2Pipeline
};