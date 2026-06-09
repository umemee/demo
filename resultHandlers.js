// resultHandlers.js
const fs = require("fs/promises");
const path = require("path");

// 설정과 도구 불러오기
const {
  PORT, ROOT, REPO_ROOT, RUNTIME, COMPANY_INPUTS, CLI_INPUTS, RESULTS, SESSIONS, UPLOADS,
  MATCHER_CATALOG_PATH, TOP2_RUNTIME_MATCHER_CATALOG_PATH, RUNTIME_MATCHER_SOURCE_TYPE,
  MAX_UPLOAD_BYTES, MAX_UPLOAD_REQUEST_BYTES, UPLOAD_TOO_LARGE_MESSAGE, EXTRACTION_PREVIEW_NOTE,
  OPENDATALOADER_COMMAND, AUTOFILL_ALLOWED_FIELDS, AUTOFILL_BLOCKED_FIELDS,
  AUTOFILL_EXPANDED_V2_SAFE_FIELDS, V2_SAFE_INPUT_VALUE_FIELDS, V2_SAFE_INPUT_ARRAY_FIELDS,
  V2_SAFE_INPUT_ALLOWED_INDUSTRIES, V2_SAFE_INPUT_ALLOWED_GREEN_FLAGS,
  V2_SAFE_INPUT_ALLOWED_BUSINESS_AGE_CATEGORIES, V2_SAFE_INPUT_ALLOWED_CERTIFICATION_NEEDS,
  V2_SAFE_INPUT_ALLOWED_CURRENT_STAGE_VALUES, V2_SAFE_INPUT_DIR, V2_PROGRAM_INDEX_PATH,
  V2_PROGRAMS_DIR, V2_CANDIDATE_RETRIEVAL_DIR, V2_PIPELINE_RUNS_DIR, V2_AI_MATCHER_PACKAGE_DIR,
  V2_AI_MATCHER_PROMPT_DRAFT_PATH, V2_AI_MATCHER_OUTPUT_SCHEMA_DRAFT_PATH,
  FAST_MATCH_CARD_DB_PATH, FAST_MATCH_CONTEXT_SCRIPT_PATH, FAST_KOREAN_BRIEFING_SCRIPT_PATH,
  CORE_FIELDS, CONDITIONAL_FIELDS, MATCHER_FIELD_ALIAS_MAP
} = require("./config.js");

const {
  send, json, slugify, slugifyCaseIdCandidate, formatUploadTimestamp, generateUploadCaseId, readRequestBody
} = require("./utils.js");

const crypto = require("crypto");

// --- 사라졌던 도우미 함수들 복구 ---
function isSafePreviewCaseId(caseId) { return /^[A-Za-z0-9_-]+$/.test(String(caseId || "").trim()); }
function isSafeResultCaseId(caseId) { return /^[A-Za-z0-9_-]+$/.test(String(caseId || "").trim()); }

function compactErrorText(value, maxLength = 1600) {
  const text = String(value || "").trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}... [truncated]`;
}

function isPathInside(parentDir, childPath) {
  const relative = path.relative(path.resolve(parentDir), path.resolve(childPath));
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function createManifestBase(caseId, now, currentState, extra = {}) {
  return { case_id: caseId, current_state: currentState, last_updated_at: now, ...extra };
}

function ensureManifestShape(manifest, caseId, now, currentState) {
  return { ...createManifestBase(caseId, now, currentState), ...(manifest || {}), case_id: caseId, current_state: currentState, last_updated_at: now };
}

async function readManifest(manifestPath) {
  try { return JSON.parse(await fs.readFile(manifestPath, "utf8")); } catch { return null; }
}

async function writeManifest(manifestPath, manifest) {
  await fs.mkdir(SESSIONS, { recursive: true });
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
}

async function readJsonFileIfExists(filePath) {
  try { return JSON.parse(await fs.readFile(filePath, "utf8")); } catch { return null; }
}

async function sha256FileIfExists(filePath) {
  try { return crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex"); } catch { return null; }
}

function getGemmaMatchRuntimePaths(caseId) {
  return { runMetadataPath: path.join(RUNTIME, "gemma_match_outputs", `${caseId}_gemma_match_run_metadata.json`) };
}

async function readGemmaRunMetadata(caseId) {
  const paths = getGemmaMatchRuntimePaths(caseId);
  const computedHash = await sha256FileIfExists(path.join(RESULTS, caseId, "result_view_model.json"));
  const diskMetadata = await readJsonFileIfExists(paths.runMetadataPath);
  if (diskMetadata && typeof diskMetadata === "object") {
    return { ...diskMetadata, result_view_model_hash: diskMetadata.result_view_model_hash ?? computedHash ?? null, metadata_path: toRepoPath(paths.runMetadataPath) };
  }
  return null;
}
// ---------------------------------

function toRepoPath(filePath) {
  return path.relative(REPO_ROOT, filePath).replace(/\\/g, "/");
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// ✂️ 👇 2번 단계에서 잘라낸 handleLoad~ 함수들을 이 아래 빈 공간에 붙여넣으세요! 👇 ✂️
// 💡 [Gemma 매칭 결과 자동 병합 도우미] 
// 페이지를 새로고침(F5)하여 과거 데이터를 불러올 때도, AI가 생성한 최신 대조쌍(matched_evidence_pairs)을 잃어버리지 않고 강제로 덮어씌워주는 구세주 함수입니다.
async function mergeGemmaMatchData(caseId, viewModel) {
  try {
    const gemmaPath = path.join(RUNTIME, "gemma_match_outputs", `${caseId}_gemma_match_output.manual.json`);
    if (await pathExists(gemmaPath)) {
      const gemmaData = JSON.parse(await fs.readFile(gemmaPath, "utf8"));
      
      // 하이브리드 배열 규격 지원 (recommendations, recommended, conditional 프로토콜 전수 수집)
      const gemmaRecs = gemmaData.recommendations || gemmaData.recommended || gemmaData.conditional || [];
      
      if (gemmaData && Array.isArray(gemmaRecs)) {
        // 만약 받아온 기초 뷰모델에 배열이 초기화되어 있지 않다면 강제 생성
        if (!viewModel.recommendations || !Array.isArray(viewModel.recommendations)) {
          viewModel.recommendations = [];
        }

        gemmaRecs.forEach(gRec => {
          const targetName = (gRec.program_name || gRec.program_id || "").trim();
          let exist = viewModel.recommendations.find(r => (r.program_name || r.program_id || "").trim() === targetName);
          
          if (!exist) {
            // 메인 타겟 컨테이너에 누락된 캐시 항목이 있다면 데이터 단절 방지를 위해 전방위 주입
            exist = { ...gRec };
            viewModel.recommendations.push(exist);
          } else {
            // 대조 데이터 병합 가동 (계산 불능 차단 및 팩트 체인 매핑)
            exist.matched_evidence_pairs = gRec.matched_evidence_pairs || exist.matched_evidence_pairs || [];
            exist.short_reason = gRec.short_reason || exist.short_reason || "";
            exist.fit_status = gRec.fit_status || exist.fit_status || "적합";
            exist.caution_flags = gRec.caution_flags || exist.caution_flags || [];
            exist.conditions = gRec.conditions || gRec.confirmation_needed_items || exist.conditions || [];
            
            // 고급 타당성 구조체(match_reason_advanced) 깊은 병합 보정
            if (gRec.match_reason_advanced || gRec.match_reason) {
              const srcAdv = gRec.match_reason_advanced || {};
              exist.match_reason_advanced = {
                selection_justification: srcAdv.selection_justification || gRec.reason || gRec.short_reason || "선정 타당성 분석 수집 완료",
                proposal_enhancement_advice: srcAdv.proposal_enhancement_advice || gRec.match_reason || "사업계획서 보완 조언 수집 완료"
              };
            }
          }
        });
      }
    }
  } catch (e) {
    console.warn(`[Core Bridge Exception] Gemma merge failed for ${caseId}:`, e.message);
  }
  return viewModel;
}
async function handleLoadPass1Result(req, res, url) {
  const caseId = slugify(url.searchParams.get("case_id"));
  const resultPath = path.join(RESULTS, caseId, "pass1_result.md");
  const manifestPath = path.join(SESSIONS, `${caseId}_session_manifest.json`);

  try {
    const content = await fs.readFile(resultPath, "utf8");
    const now = new Date().toISOString();
    const manifest = ensureManifestShape(await readManifest(manifestPath), caseId, now, "PASS1_RESULT_AVAILABLE");
    manifest.pass1_result_path = toRepoPath(resultPath);
    await writeManifest(manifestPath, manifest);

    json(res, 200, {
      ok: true,
      case_id: caseId,
      pass1_result_path: toRepoPath(resultPath),
      content,
      manifest
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      return json(res, 404, { ok: false, message: "No PASS1 result file yet for this case." });
    }
    return json(res, 500, { ok: false, error: error.message });
  }
}

async function handleLoadFollowupNeeded(req, res, url) {
  const caseId = slugify(url.searchParams.get("case_id"));
  const resultPath = path.join(RESULTS, caseId, "followup_needed.md");
  const manifestPath = path.join(SESSIONS, `${caseId}_session_manifest.json`);

  try {
    const content = await fs.readFile(resultPath, "utf8");
    const now = new Date().toISOString();
    const manifest = ensureManifestShape(await readManifest(manifestPath), caseId, now, "FOLLOWUP_NEEDED_AVAILABLE");
    manifest.followup_needed_path = toRepoPath(resultPath);
    await writeManifest(manifestPath, manifest);

    json(res, 200, {
      ok: true,
      case_id: caseId,
      followup_needed_path: toRepoPath(resultPath),
      content,
      manifest
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      return json(res, 404, { ok: false, message: "No FOLLOW-UP NEEDED file yet for this case." });
    }
    return json(res, 500, { ok: false, error: error.message });
  }
}

async function handleLoadFollowupAnswers(req, res, url) {
  const caseId = slugify(url.searchParams.get("case_id"));
  const resultPath = path.join(RESULTS, caseId, "followup_answers.json");
  const manifestPath = path.join(SESSIONS, `${caseId}_session_manifest.json`);

  try {
    const content = await fs.readFile(resultPath, "utf8");
    JSON.parse(content);
    const now = new Date().toISOString();
    const manifest = ensureManifestShape(await readManifest(manifestPath), caseId, now, "FOLLOWUP_ANSWERS_AVAILABLE");
    manifest.followup_answers_path = toRepoPath(resultPath);
    await writeManifest(manifestPath, manifest);

    json(res, 200, {
      ok: true,
      case_id: caseId,
      followup_answers_path: toRepoPath(resultPath),
      content,
      manifest
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      return json(res, 404, { ok: false, message: "No follow-up answers file yet for this case." });
    }
    return json(res, 500, { ok: false, error: error.message });
  }
}

async function handleLoadRefinedResult(req, res, url) {
  const caseId = slugify(url.searchParams.get("case_id"));
  const resultPath = path.join(RESULTS, caseId, "refined_result.md");
  const manifestPath = path.join(SESSIONS, `${caseId}_session_manifest.json`);

  try {
    const content = await fs.readFile(resultPath, "utf8");
    const now = new Date().toISOString();
    const manifest = ensureManifestShape(await readManifest(manifestPath), caseId, now, "REFINED_RESULT_AVAILABLE");
    manifest.refined_result_path = toRepoPath(resultPath);
    await writeManifest(manifestPath, manifest);

    json(res, 200, {
      ok: true,
      case_id: caseId,
      refined_result_path: toRepoPath(resultPath),
      content,
      manifest
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      return json(res, 404, { ok: false, message: "No REFINED result file yet for this case." });
    }
    return json(res, 500, { ok: false, error: error.message });
  }
}

async function handleLoadRedactedPreview(req, res, url) {
  const rawCaseId = String(url.searchParams.get("case_id") || "").trim();

  if (!rawCaseId) {
    return json(res, 400, {
      ok: false,
      error: "case_id is required.",
      case_id: null,
      redacted_text: null,
      manifest: null,
      redacted_text_path: null,
      manifest_path: null,
      warnings: ["case_id is required."],
      missing_files: []
    });
  }

  if (!isSafePreviewCaseId(rawCaseId)) {
    return json(res, 400, {
      ok: false,
      error: "Invalid case_id.",
      case_id: rawCaseId,
      redacted_text: null,
      manifest: null,
      redacted_text_path: null,
      manifest_path: null,
      warnings: ["Invalid case_id."],
      missing_files: []
    });
  }

  const caseId = rawCaseId;
  const uploadDir = path.resolve(UPLOADS, caseId);
  const resolvedUploadDir = path.resolve(UPLOADS);
  const redactedTextPath = path.join(uploadDir, "redacted_text.md");
  const manifestPath = path.join(uploadDir, "privacy_filter_manifest.json");
  const missingFiles = [];
  const warnings = [];
  let redactedText = null;
  let manifest = null;

  if (!isPathInside(resolvedUploadDir, uploadDir)) {
    return json(res, 400, {
      ok: false,
      error: "Unsafe case path rejected.",
      case_id: caseId,
      redacted_text: null,
      manifest: null,
      redacted_text_path: toRepoPath(redactedTextPath),
      manifest_path: toRepoPath(manifestPath),
      warnings: ["Unsafe case path rejected."],
      missing_files: ["redacted_text.md", "privacy_filter_manifest.json"]
    });
  }

  try {
    if (await pathExists(redactedTextPath)) {
      redactedText = await fs.readFile(redactedTextPath, "utf8");
    } else {
      missingFiles.push("redacted_text.md");
    }

    if (await pathExists(manifestPath)) {
      const manifestText = await fs.readFile(manifestPath, "utf8");
      try {
        manifest = JSON.parse(manifestText);
      } catch (error) {
        warnings.push(`privacy_filter_manifest.json JSON parse failed: ${error.message}`);
      }
    } else {
      missingFiles.push("privacy_filter_manifest.json");
    }

    if (manifest?.warnings && Array.isArray(manifest.warnings)) {
      warnings.push(...manifest.warnings);
    }
    if (manifest?.known_limitations && Array.isArray(manifest.known_limitations)) {
      warnings.push(...manifest.known_limitations.map((item) => `known limitation: ${item}`));
    }

    const response = {
      ok: missingFiles.length === 0 && !!manifest && !!redactedText,
      case_id: caseId,
      redacted_text: redactedText,
      manifest,
      redacted_text_path: toRepoPath(redactedTextPath),
      manifest_path: toRepoPath(manifestPath),
      warnings,
      missing_files: missingFiles
    };

    if (!response.ok && !warnings.length) {
      warnings.push("Privacy Filter preview could not be fully loaded.");
    }

    return json(res, 200, response);
  } catch (error) {
    return json(res, 500, {
      ok: false,
      error: error.message,
      case_id: caseId,
      redacted_text: null,
      manifest: null,
      redacted_text_path: toRepoPath(redactedTextPath),
      manifest_path: toRepoPath(manifestPath),
      warnings: [error.message],
      missing_files: ["redacted_text.md", "privacy_filter_manifest.json"]
    });
  }
}

async function handleLoadResultViewModel(req, res, url) {
  const rawCaseId = String(url.searchParams.get("case_id") || "").trim();

  if (!rawCaseId) {
    return json(res, 400, {
      ok: false,
      case_id: null,
      source_type: "missing",
      result_view_model: null,
      result_view_model_path: null,
      warnings: ["case_id is required."],
      missing_files: []
    });
  }

  if (!isSafeResultCaseId(rawCaseId)) {
    return json(res, 400, {
      ok: false,
      case_id: rawCaseId,
      source_type: "missing",
      result_view_model: null,
      result_view_model_path: null,
      warnings: ["Invalid case_id."],
      missing_files: []
    });
  }

  const caseId = rawCaseId;
  const caseResultDir = path.join(RESULTS, caseId);
  const manualResultPath = path.join(caseResultDir, "result_view_model.json");
  const dryRunResultPath = path.join(caseResultDir, "matcher_dry_run_result_view_model.json");
  const missingFiles = [];

  const readJsonArtifact = async (artifactPath, sourceType) => {
    try {
      const raw = await fs.readFile(artifactPath, "utf8");
      return {
        ok: true,
        source_type: sourceType,
        result_view_model: JSON.parse(raw),
        result_view_model_path: toRepoPath(artifactPath),
        warnings: []
      };
    } catch (error) {
      if (error.code === "ENOENT") {
        missingFiles.push(toRepoPath(artifactPath));
        return { ok: false, missing: true };
      }
      if (error instanceof SyntaxError) {
        return {
          ok: false,
          parse_error: true,
          source_type: sourceType,
          result_view_model: null,
          result_view_model_path: toRepoPath(artifactPath),
          warnings: [`${path.basename(artifactPath)} JSON parse failed: ${compactErrorText(error.message, 300)}`]
        };
      }
      throw error;
    }
  };

  const manualResult = await readJsonArtifact(manualResultPath, "manual_result_view_model");
  if (manualResult.ok) {
    const sourceType = manualResult.result_view_model?.metadata?.is_runtime_matcher_output || manualResult.result_view_model?.generated_from?.generation_mode === "runtime_matcher"
      ? RUNTIME_MATCHER_SOURCE_TYPE
      : manualResult.source_type;
      
    // 🚀 [해결책] 화면이 렌더링 되기 직전, AI가 만든 최신 대조쌍 데이터를 강제로 주입합니다.
    const finalViewModel = await mergeGemmaMatchData(caseId, manualResult.result_view_model);

    return json(res, 200, {
      ok: true,
      case_id: caseId,
      source_type: sourceType,
      result_view_model: finalViewModel,
      result_view_model_path: manualResult.result_view_model_path,
      warnings: manualResult.warnings,
      missing_files: missingFiles
    });
  }

  const dryRunResult = await readJsonArtifact(dryRunResultPath, "matcher_dry_run_result_view_model");
  if (dryRunResult.ok) {
    const warnings = dryRunResult.warnings.slice();
    if (missingFiles.length) {
      warnings.unshift("result_view_model.json was not found; using matcher_dry_run_result_view_model.json fallback.");
    }
    
    // 🚀 [해결책] 폴백 데이터에도 동일하게 주입합니다.
    const finalViewModel = await mergeGemmaMatchData(caseId, dryRunResult.result_view_model);

    return json(res, 200, {
      ok: true,
      case_id: caseId,
      source_type: dryRunResult.source_type,
      result_view_model: finalViewModel,
      result_view_model_path: dryRunResult.result_view_model_path,
      warnings,
      missing_files: missingFiles
    });
  }
  if (dryRunResult.parse_error) {
    return json(res, 200, {
      ok: false,
      case_id: caseId,
      source_type: dryRunResult.source_type,
      result_view_model: null,
      result_view_model_path: dryRunResult.result_view_model_path,
      warnings: dryRunResult.warnings,
      missing_files: missingFiles
    });
  }

  const warnings = [];
  if (missingFiles.length) {
    warnings.push("result_view_model.json and matcher_dry_run_result_view_model.json were not found.");
  } else {
    warnings.push("No compatible result_view_model JSON was found.");
  }

  return json(res, 200, {
    ok: false,
    case_id: caseId,
    source_type: "missing",
    result_view_model: null,
    result_view_model_path: null,
    warnings,
    missing_files: missingFiles.length ? missingFiles : [toRepoPath(manualResultPath), toRepoPath(dryRunResultPath)]
  });
}

async function handleLoadFastMatchResult(req, res, url) {
  const prefix = "/api/fast-match-result/";
  const rawCaseId = decodeURIComponent(String(url.pathname || "").slice(prefix.length)).trim();

  if (!rawCaseId) {
    return json(res, 400, {
      ok: false,
      case_id: null,
      error: "case_id is required.",
      expected_path: null
    });
  }

  if (!isSafeResultCaseId(rawCaseId)) {
    return json(res, 400, {
      ok: false,
      case_id: rawCaseId,
      error: "Invalid case_id.",
      expected_path: null
    });
  }

  const caseId = rawCaseId;
  const sourcePath = path.join(RUNTIME, "v2_pipeline_runs", caseId, "fast_ai_briefing_output", "fast_briefing_result.json");
  try {
    const raw = await fs.readFile(sourcePath, "utf8");
    const result = JSON.parse(raw);
    return json(res, 200, {
      ok: true,
      case_id: caseId,
      result,
      source_path: toRepoPath(sourcePath)
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      return json(res, 404, {
        ok: false,
        case_id: caseId,
        error: "Fast briefing result was not found.",
        expected_path: toRepoPath(sourcePath)
      });
    }
    if (error instanceof SyntaxError) {
      return json(res, 400, {
        ok: false,
        case_id: caseId,
        error: `Fast briefing result JSON parse failed: ${compactErrorText(error.message, 300)}`,
        expected_path: toRepoPath(sourcePath)
      });
    }
    throw error;
  }
}



function isDiagnosticPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeDiagnosticV2RecommendationItem(item, positionMap = {}) {
  if (!isDiagnosticPlainObject(item)) return null;
  const sourcePosition = String(item.recommendation_position || "").trim();
  if (sourcePosition === "excluded") return null;
  const cloned = JSON.parse(JSON.stringify(item));
  const normalizedPosition = positionMap[sourcePosition] || sourcePosition || "primary";
  cloned.recommendation_position = normalizedPosition;
  if (normalizedPosition === "primary") {
    cloned.lane_label = "추천";
    cloned.display_status = cloned.display_status || "추천 후보";
  } else if (normalizedPosition === "secondary_conditional") {
    cloned.lane_label = "추천";
    cloned.display_status = cloned.display_status || "추가 확인 필요";
  } else if (normalizedPosition === "future_option") {
    cloned.lane_label = "참고";
    cloned.display_status = cloned.display_status || "참고 후보";
  }
  return cloned;
}

function normalizeDiagnosticV2ResultViewModel(sampleId, sourceViewModel) {
  const normalized = JSON.parse(JSON.stringify(sourceViewModel || {}));
  const recommendations = Array.isArray(normalized.recommendations) ? normalized.recommendations : [];
  const supportingPrograms = Array.isArray(normalized.supporting_programs) ? normalized.supporting_programs : [];
  const excludedPrograms = Array.isArray(normalized.excluded_programs) ? normalized.excluded_programs : [];
  const referencePrograms = Array.isArray(normalized.reference_programs) ? normalized.reference_programs : [];
  const notRecommendedPrograms = Array.isArray(normalized.not_recommended_programs) ? normalized.not_recommended_programs : [];
  const referenceLanePrograms = [...supportingPrograms, ...referencePrograms];

  normalized.case_id = sampleId;
  normalized.recommendations = recommendations
    .map((item) => normalizeDiagnosticV2RecommendationItem(item, {
      main_shortlist: "primary",
      reference_only: "secondary_conditional"
    }))
    .filter(Boolean);
  normalized.future_recommendations = referenceLanePrograms
    .map((item) => normalizeDiagnosticV2RecommendationItem(item, {
      main_shortlist: "future_option",
      reference_only: "future_option"
    }))
    .filter(Boolean);
  normalized.secondary_recommendations = recommendations
    .map((item) => normalizeDiagnosticV2RecommendationItem(item, {
      main_shortlist: "secondary_conditional",
      reference_only: "secondary_conditional"
    }))
    .filter((item) => item && item.recommendation_position === "secondary_conditional");
  normalized.excluded_programs = excludedPrograms.map((item) => {
    if (!isDiagnosticPlainObject(item)) return item;
    const cloned = JSON.parse(JSON.stringify(item));
    cloned.recommendation_position = "excluded";
    cloned.lane_label = "제외";
    return cloned;
  }).concat(notRecommendedPrograms.map((item) => {
    if (!isDiagnosticPlainObject(item)) return item;
    const cloned = JSON.parse(JSON.stringify(item));
    cloned.recommendation_position = "excluded";
    cloned.lane_label = "제외";
    return cloned;
  }));
  normalized.diagnostic_v2_loader = true;
  normalized.live_matcher_replaced = false;
  normalized.source_sample_id = sampleId;
  normalized.metadata = {
    ...(isDiagnosticPlainObject(normalized.metadata) ? normalized.metadata : {}),
    diagnostic_v2_loader: true,
    live_matcher_replaced: false,
    source_sample_id: sampleId
  };
  normalized.generated_from = {
    ...(isDiagnosticPlainObject(normalized.generated_from) ? normalized.generated_from : {}),
    diagnostic_v2_loader: true,
    live_matcher_replaced: false,
    source_sample_id: sampleId
  };
  return normalized;
}

function normalizeDiagnosticV2PipelineResultViewModel(caseId, sourceViewModel) {
  const normalized = normalizeDiagnosticV2ResultViewModel(caseId, sourceViewModel);
  normalized.diagnostic_v2_pipeline_loader = true;
  normalized.source_case_id = caseId;
  delete normalized.source_sample_id;
  if (isDiagnosticPlainObject(normalized.metadata)) delete normalized.metadata.source_sample_id;
  if (isDiagnosticPlainObject(normalized.generated_from)) delete normalized.generated_from.source_sample_id;
  normalized.metadata = {
    ...(isDiagnosticPlainObject(normalized.metadata) ? normalized.metadata : {}),
    diagnostic_v2_pipeline_loader: true,
    source_case_id: caseId
  };
  normalized.generated_from = {
    ...(isDiagnosticPlainObject(normalized.generated_from) ? normalized.generated_from : {}),
    diagnostic_v2_pipeline_loader: true,
    source_case_id: caseId
  };
  return normalized;
}

async function handleLoadV2ResultViewModelSample(req, res, url) {
  const prefix = "/api/v2-result-view-model-sample/";
  const sampleId = decodeURIComponent(String(url.pathname || "").slice(prefix.length)).trim();
  const allowed = new Set([
    "sample_01_startup_agrifood",
    "sample_02_smart_agri_tech",
    "sample_03_market_channel"
  ]);

  if (!allowed.has(sampleId)) {
    return json(res, 404, {
      ok: false,
      diagnostic_v2_loader: true,
      live_matcher_replaced: false,
      source_sample_id: sampleId || null,
      source_type: "missing",
      result_view_model: null,
      result_view_model_path: null,
      warnings: ["Unknown diagnostic V2 sample id."],
      missing_files: []
    });
  }

  const sourcePath = path.join(REPO_ROOT, "app_v1", "runtime", "v2_result_view_models", sampleId, "result_view_model.json");
  try {
    const raw = await fs.readFile(sourcePath, "utf8");
    const sourceViewModel = JSON.parse(raw);
    const normalized = normalizeDiagnosticV2ResultViewModel(sampleId, sourceViewModel);
    return json(res, 200, {
      ok: true,
      diagnostic_v2_loader: true,
      live_matcher_replaced: false,
      source_sample_id: sampleId,
      case_id: sampleId,
      source_type: "diagnostic_v2_result_view_model",
      result_view_model: normalized,
      result_view_model_path: toRepoPath(sourcePath),
      warnings: [],
      missing_files: []
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      return json(res, 404, {
        ok: false,
        diagnostic_v2_loader: true,
        live_matcher_replaced: false,
        source_sample_id: sampleId,
        case_id: sampleId,
        source_type: "missing",
        result_view_model: null,
        result_view_model_path: toRepoPath(sourcePath),
        warnings: ["Diagnostic V2 result_view_model.json was not found."],
        missing_files: [toRepoPath(sourcePath)]
      });
    }
    if (error instanceof SyntaxError) {
      return json(res, 400, {
        ok: false,
        diagnostic_v2_loader: true,
        live_matcher_replaced: false,
        source_sample_id: sampleId,
        case_id: sampleId,
        source_type: "parse_error",
        result_view_model: null,
        result_view_model_path: toRepoPath(sourcePath),
        warnings: [`Diagnostic V2 result_view_model.json JSON parse failed: ${compactErrorText(error.message, 300)}`],
        missing_files: []
      });
    }
    throw error;
  }
}

async function handleLoadGemmaMatchResult(req, res, url) {
  const prefix = "/api/gemma-match-result/";
  const rawCaseId = decodeURIComponent(String(url.pathname || "").slice(prefix.length)).trim();

  if (!rawCaseId) {
    return json(res, 400, {
      ok: false,
      case_id: null,
      error: "case_id is required."
    });
  }

  if (!isSafeResultCaseId(rawCaseId)) {
    return json(res, 400, {
      ok: false,
      case_id: rawCaseId,
      error: "Invalid case_id."
    });
  }

  const caseId = rawCaseId;
  const sourcePath = path.join(RUNTIME, "gemma_match_outputs", `${caseId}_gemma_match_output.manual.json`);

  try {
    const raw = await fs.readFile(sourcePath, "utf8");
    const result = JSON.parse(raw);
    const runMetadata = await readGemmaRunMetadata(caseId);
    return json(res, 200, {
      ok: true,
      case_id: caseId,
      source: "gemma_local_output",
      result,
      cache_status: runMetadata?.cache_status || "unknown",
      cache_key: runMetadata?.cache_key || null,
      ollama_skipped: typeof runMetadata?.ollama_skipped === "boolean" ? runMetadata.ollama_skipped : "unknown",
      raw_output_hash: runMetadata?.raw_output_hash || null,
      manual_output_hash: runMetadata?.manual_output_hash || null,
      result_view_model_hash: runMetadata?.result_view_model_hash || null,
      run_metadata_path: runMetadata?.metadata_path || null,
      run_metadata: runMetadata || null
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      return json(res, 404, {
        ok: false,
        case_id: caseId,
        error: "Gemma match output was not found."
      });
    }
    if (error instanceof SyntaxError) {
      return json(res, 500, {
        ok: false,
        case_id: caseId,
        error: "Gemma match output JSON could not be parsed."
      });
    }
    return json(res, 500, {
      ok: false,
      case_id: caseId,
      error: "Gemma match output could not be loaded."
    });
  }
}

async function handleLoadV2PipelineResultViewModel(req, res, url) {
  const prefix = "/api/v2-pipeline-result/";
  const caseId = decodeURIComponent(String(url.pathname || "").slice(prefix.length)).trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(caseId)) {
    return json(res, 400, {
      ok: false,
      diagnostic_v2_pipeline_loader: true,
      live_matcher_replaced: false,
      source_case_id: caseId || null,
      case_id: caseId || null,
      source_type: "invalid_case_id",
      result_view_model: null,
      result_view_model_path: null,
      warnings: ["Invalid V2 pipeline case_id."],
      missing_files: []
    });
  }

  const sourcePath = path.join(REPO_ROOT, "app_v1", "runtime", "v2_pipeline_runs", caseId, "result_view_model", "result_view_model.json");
  try {
    const raw = await fs.readFile(sourcePath, "utf8");
    const sourceViewModel = JSON.parse(raw);
    const normalized = normalizeDiagnosticV2PipelineResultViewModel(caseId, sourceViewModel);
            
    // 🚀 [해결책] V2 파이프라인 로더를 거칠 때도 AI가 만든 최신 대조쌍 데이터를 주입합니다.
    const finalViewModel = await mergeGemmaMatchData(caseId, normalized);

    return json(res, 200, {
      ok: true,
      diagnostic_v2_loader: true,
      diagnostic_v2_pipeline_loader: true,
      live_matcher_replaced: false,
      source_case_id: caseId,
      case_id: caseId,
      source_type: "diagnostic_v2_pipeline_result_view_model",
      result_view_model: finalViewModel,
      result_view_model_path: toRepoPath(sourcePath),
      warnings: [],
      missing_files: []
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      return json(res, 404, {
        ok: false,
        diagnostic_v2_loader: true,
        diagnostic_v2_pipeline_loader: true,
        live_matcher_replaced: false,
        source_case_id: caseId,
        case_id: caseId,
        source_type: "missing",
        result_view_model: null,
        result_view_model_path: toRepoPath(sourcePath),
        warnings: ["Diagnostic V2 pipeline result_view_model.json was not found."],
        missing_files: [toRepoPath(sourcePath)]
      });
    }
    if (error instanceof SyntaxError) {
      return json(res, 400, {
        ok: false,
        diagnostic_v2_loader: true,
        diagnostic_v2_pipeline_loader: true,
        live_matcher_replaced: false,
        source_case_id: caseId,
        case_id: caseId,
        source_type: "parse_error",
        result_view_model: null,
        result_view_model_path: toRepoPath(sourcePath),
        warnings: [`Diagnostic V2 pipeline result_view_model.json JSON parse failed: ${compactErrorText(error.message, 300)}`],
        missing_files: []
      });
    }
    throw error;
  }
}

async function handleLoad(req, res, url) {
  const caseId = slugify(url.searchParams.get("case_id"));
  const standardPath = path.join(COMPANY_INPUTS, `${caseId}_standard_company_input.json`);
  const manifestPath = path.join(SESSIONS, `${caseId}_session_manifest.json`);
  const safeInputPath = path.join(V2_PIPELINE_RUNS_DIR, caseId, "v2_safe_input.json");
  const autofillDraftPath = path.join(UPLOADS, caseId, "autofill_draft.json");
  try {
    const saved = JSON.parse(await fs.readFile(standardPath, "utf8"));
    const manifest = await readManifest(manifestPath);
    let v2SafeInput = null;
    try {
      v2SafeInput = JSON.parse(await fs.readFile(safeInputPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    let autofillDraft = null;
    try {
      autofillDraft = JSON.parse(await fs.readFile(autofillDraftPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    json(res, 200, {
      ok: true,
      case_id: caseId,
      standard_company_input_path: toRepoPath(standardPath),
      saved,
      manifest,
      v2_safe_input: v2SafeInput,
      v2_safe_input_path: v2SafeInput ? toRepoPath(safeInputPath) : null,
      autofill_draft: autofillDraft,
      autofill_draft_path: autofillDraft ? toRepoPath(autofillDraftPath) : null
    });
  } catch {
    json(res, 404, { ok: false, error: `No saved input found for case_id=${caseId}` });
  }
}
// ✂️ 👆 여기까지 붙여넣으세요! 👆 ✂️

// 메인 서버에서 쓸 수 있게 내보냅니다. (이름표 달아주기)
module.exports = {
  handleLoadGemmaMatchResult,
  handleLoadPass1Result,
  handleLoadFollowupNeeded,
  handleLoadFollowupAnswers,
  handleLoadRefinedResult,
  handleLoadRedactedPreview,
  handleLoadFastMatchResult,
  handleLoadV2PipelineResultViewModel,
  handleLoadV2ResultViewModelSample,
  handleLoadResultViewModel,
  handleLoad
};