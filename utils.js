//utils.js
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const config = require("./config.js");

// config에서 설정값 모두 가져오기
const { PORT, ROOT, REPO_ROOT, RUNTIME, COMPANY_INPUTS, CLI_INPUTS, RESULTS, SESSIONS, UPLOADS, MATCHER_CATALOG_PATH, TOP2_RUNTIME_MATCHER_CATALOG_PATH, RUNTIME_MATCHER_SOURCE_TYPE, MAX_UPLOAD_BYTES, MAX_UPLOAD_REQUEST_BYTES, UPLOAD_TOO_LARGE_MESSAGE, EXTRACTION_PREVIEW_NOTE, OPENDATALOADER_COMMAND, AUTOFILL_ALLOWED_FIELDS, AUTOFILL_BLOCKED_FIELDS, AUTOFILL_EXPANDED_V2_SAFE_FIELDS, V2_SAFE_INPUT_VALUE_FIELDS, V2_SAFE_INPUT_ARRAY_FIELDS, V2_SAFE_INPUT_ALLOWED_INDUSTRIES, V2_SAFE_INPUT_ALLOWED_GREEN_FLAGS, V2_SAFE_INPUT_ALLOWED_BUSINESS_AGE_CATEGORIES, V2_SAFE_INPUT_ALLOWED_CERTIFICATION_NEEDS, V2_SAFE_INPUT_ALLOWED_CURRENT_STAGE_VALUES, V2_SAFE_INPUT_DIR, V2_PROGRAM_INDEX_PATH, V2_PROGRAMS_DIR, V2_CANDIDATE_RETRIEVAL_DIR, V2_PIPELINE_RUNS_DIR, V2_AI_MATCHER_PACKAGE_DIR, V2_AI_MATCHER_PROMPT_DRAFT_PATH, V2_AI_MATCHER_OUTPUT_SCHEMA_DRAFT_PATH, FAST_MATCH_CARD_DB_PATH, FAST_MATCH_CONTEXT_SCRIPT_PATH, FAST_KOREAN_BRIEFING_SCRIPT_PATH, CORE_FIELDS, CONDITIONAL_FIELDS, MATCHER_FIELD_ALIAS_MAP } = config;
function send(res, status, body, contentType = "application/json; charset=utf-8") {
  res.writeHead(status, { "content-type": contentType });
  res.end(body);
}

function json(res, status, value) {
  send(res, status, JSON.stringify(value, null, 2));
}

function slugify(input) {
  const raw = String(input || "").trim();
  const firstToken = raw.split(/\s+\/\s+|\s+/)[0];
  const ascii = firstToken
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return ascii || `case_${Date.now()}`;
}

function slugifyCaseIdCandidate(value) {
  const raw = String(value || "").trim();
  return raw
    .replace(/\.pdf$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function formatUploadTimestamp(now = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  return [
    now.getUTCFullYear(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate())
  ].join("") + "_" + [
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
    pad(now.getUTCSeconds())
  ].join("") + `_${pad(now.getUTCMilliseconds(), 3)}`;
}

function generateUploadCaseId(filename, now = new Date()) {
  const filenameSlug = slugifyCaseIdCandidate(path.basename(String(filename || "")));
  const timestamp = formatUploadTimestamp(now);
  return filenameSlug ? `${filenameSlug}_${timestamp}` : `upload_${timestamp}`;
}

async function readRequestBody(req, maxBytes = null) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (maxBytes && totalBytes > maxBytes) {
      const error = new Error("Request body exceeds the upload size limit.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function hasMeaningfulValue(value) {
  if (Array.isArray(value)) {
    return value.some((item) => String(item || "").trim() !== "");
  }
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function hasMeaningfulMatcherFieldValue(fields, fieldName) {
  const record = resolveMatcherFieldRecord(fields, fieldName);
  const status = String(record?.status || "").trim().toLowerCase();
  return hasMeaningfulValue(record?.value) && status !== "blank" && status !== "unknown";
}

function hasMinimumCompanyInputForMatching(fields) {
  const hasIdentityOrContext = [
    "company_name_or_alias",
    "industry_field",
    "product_tech_summary"
  ].some((fieldName) => hasMeaningfulMatcherFieldValue(fields, fieldName));
  const hasMatchingSignal = [
    "industry_field",
    "product_tech_summary",
    "top_needs_or_pain_points",
    "current_stage"
  ].some((fieldName) => hasMeaningfulMatcherFieldValue(fields, fieldName));
  return hasIdentityOrContext && hasMatchingSignal;
}

function buildMinimumInputGateFollowupQuestions(fields) {
  const questionSpecs = [
    {
      field: "company_name_or_alias",
      question_id: "minimum_input_company_name",
      question: "회사명 또는 별칭을 입력해 주세요."
    },
    {
      field: "region",
      question_id: "minimum_input_region",
      question: "지역을 입력해 주세요."
    },
    {
      field: "industry_field",
      question_id: "minimum_input_industry_field",
      question: "업종/분야를 입력해 주세요."
    },
    {
      field: "product_tech_summary",
      question_id: "minimum_input_product_tech_summary",
      question: "제품/기술 요약을 입력해 주세요."
    },
    {
      field: "top_needs_or_pain_points",
      question_id: "minimum_input_top_needs",
      question: "지원 필요 사항 또는 주요 니즈를 입력해 주세요."
    },
    {
      field: "current_stage",
      question_id: "minimum_input_current_stage",
      question: "현재 단계를 입력해 주세요."
    }
  ];

  return questionSpecs
    .filter(({ field }) => !hasMeaningfulMatcherFieldValue(fields, field))
    .map(({ field, question_id, question }) => ({
      question_id,
      question,
      related_fields: [field],
      matcher_use_policy: "followup_question_only",
      program_id: null,
      program_name: null
    }));
}

function buildMinimumInputGateUncertainties(fields) {
  const uncertainties = [];
  if (!hasMeaningfulMatcherFieldValue(fields, "company_name_or_alias")) {
    uncertainties.push({
      uncertainty_id: "company_identity_missing",
      category: "input_gate",
      description: "회사명 또는 별칭이 비어 있어 대상 기업을 식별하기 어렵습니다.",
      affected_programs: [],
      needed_evidence: "회사명 또는 별칭",
      severity: "high",
      can_proceed_with_demo: true
    });
  }
  if (!hasMeaningfulMatcherFieldValue(fields, "region")) {
    uncertainties.push({
      uncertainty_id: "region_missing",
      category: "input_gate",
      description: "지역 정보가 비어 있어 지역 조건을 확인할 수 없습니다.",
      affected_programs: [],
      needed_evidence: "지역",
      severity: "medium",
      can_proceed_with_demo: true
    });
  }
  if (!hasMeaningfulMatcherFieldValue(fields, "industry_field") || !hasMeaningfulMatcherFieldValue(fields, "product_tech_summary")) {
    uncertainties.push({
      uncertainty_id: "business_context_missing",
      category: "input_gate",
      description: "업종/분야 또는 제품/기술 요약이 비어 있어 사업 맥락을 판단할 수 없습니다.",
      affected_programs: [],
      needed_evidence: "업종/분야, 제품/기술 요약",
      severity: "high",
      can_proceed_with_demo: true
    });
  }
  if (!hasMeaningfulMatcherFieldValue(fields, "top_needs_or_pain_points") || !hasMeaningfulMatcherFieldValue(fields, "current_stage")) {
    uncertainties.push({
      uncertainty_id: "matching_signal_missing",
      category: "input_gate",
      description: "지원 필요 사항 또는 현재 단계가 비어 있어 매칭 신호가 부족합니다.",
      affected_programs: [],
      needed_evidence: "지원 필요 사항, 현재 단계",
      severity: "high",
      can_proceed_with_demo: true
    });
  }
  return uncertainties;
}

function buildMinimumInputGateNextActions() {
  return [
    {
      action_id: "run_pdf_text_extraction_preview",
      action: "PDF 텍스트 추출 미리보기 실행",
      owner: "user",
      priority: "high",
      related_programs: [],
      depends_on: ["uploaded_pdf"],
      expected_output: "추출 텍스트가 준비됩니다.",
      demo_safe_wording: "PDF 텍스트 추출 미리보기를 먼저 실행해 주세요."
    },
    {
      action_id: "apply_input_draft",
      action: "입력 초안 만들고 적용",
      owner: "user",
      priority: "high",
      related_programs: [],
      depends_on: ["extracted_text.md"],
      expected_output: "초안이 입력폼에 반영됩니다.",
      demo_safe_wording: "추출 초안을 적용해 주세요."
    },
    {
      action_id: "enter_company_basics",
      action: "회사명, 업종/분야, 제품/기술 요약 중 최소 항목 입력",
      owner: "user",
      priority: "high",
      related_programs: [],
      depends_on: ["standard_company_input.json"],
      expected_output: "최소 입력 기준을 충족합니다.",
      demo_safe_wording: "핵심 회사 정보를 직접 입력해 주세요."
    }
  ];
}

function buildMinimumInputGateResult(caseId, standardCompanyInput, standardPath, catalog, catalogPath) {
  const fields = standardCompanyInput?.fields || {};
  const now = new Date().toISOString();
  const sourceStandardCompanyInputPath = toRepoPath(standardPath);
  const sourceCatalogPath = toRepoPath(catalogPath);
  const runtimeCatalogType = String(catalog?.catalog_source_type || "runtime_top2_catalog");
  const summaryValue = (fieldName) => {
    const value = resolveMatcherFieldRecord(fields, fieldName).value;
    if (Array.isArray(value)) {
      return value.map((item) => String(item || "").trim()).filter(Boolean).join(", ");
    }
    return String(value || "").trim();
  };
  const summaryStatus = (fieldName) => String(resolveMatcherFieldRecord(fields, fieldName).status || "blank");
  const followupQuestions = buildMinimumInputGateFollowupQuestions(fields);
  const remainingUncertainties = buildMinimumInputGateUncertainties(fields);
  const nextActions = buildMinimumInputGateNextActions();
  const companySummary = {
    company_name_or_alias: {
      value: summaryValue("company_name_or_alias"),
      status: summaryStatus("company_name_or_alias")
    },
    region: {
      value: summaryValue("region"),
      status: summaryStatus("region")
    },
    industry_field: {
      value: summaryValue("industry_field"),
      status: summaryStatus("industry_field")
    },
    product_tech_summary: {
      value: summaryValue("product_tech_summary"),
      status: summaryStatus("product_tech_summary")
    },
    top_needs_or_pain_points: {
      value: summaryValue("top_needs_or_pain_points"),
      status: summaryStatus("top_needs_or_pain_points")
    }
  };
  const displayWarnings = [
    "기업 정보가 부족해 추천 후보를 생성하지 않았습니다.",
    "PDF 텍스트 추출 후 입력 초안을 적용하거나, 핵심 정보를 직접 입력해 주세요.",
    "이 결과는 최종 자격판정이 아닙니다."
  ];
  const evidenceTrace = [
    {
      source_type: "standard_company_input",
      source_path: sourceStandardCompanyInputPath,
      field_or_section: "company_summary",
      excerpt: sanitizeDraftText([
        String(companySummary.company_name_or_alias.value || ""),
        String(companySummary.region.value || ""),
        String(companySummary.industry_field.value || ""),
        String(companySummary.product_tech_summary.value || "")
      ].join(" "), 260)
    },
    {
      source_type: "runtime_support_program_catalog",
      source_path: sourceCatalogPath,
      field_or_section: "program_catalog",
      excerpt: sanitizeDraftText((Array.isArray(catalog?.programs) ? catalog.programs : []).map((program) => program.program_name).join(" | "), 260)
    }
  ];

  return {
    schema_version: "v1",
    case_id: caseId,
    result_state: "NEEDS_INPUT",
    generated_from: {
      source_standard_company_input_path: sourceStandardCompanyInputPath,
      source_catalog_path: sourceCatalogPath,
      source_catalog_type: runtimeCatalogType,
      matcher_scope: "top2_runtime_catalog",
      candidate_source_set: [],
      generation_mode: "runtime_matcher",
      is_runtime_matcher_output: true,
      is_privacy_filter_output: false,
      is_final_eligibility_decision: false,
      privacy_filter_status: "not_run"
    },
    company_summary: {
      company_name_or_alias: companySummary.company_name_or_alias,
      region: companySummary.region,
      industry_field: companySummary.industry_field,
      product_tech_summary: companySummary.product_tech_summary,
      top_needs_or_pain_points: companySummary.top_needs_or_pain_points
    },
    recommendations: [],
    followup_questions: followupQuestions,
    remaining_uncertainties: remainingUncertainties,
    missing_documents: [],
    next_actions: nextActions,
    evidence_trace: evidenceTrace,
    display_warnings: displayWarnings,
    metadata: {
      generation_mode: "runtime_matcher",
      is_runtime_matcher_output: true,
      is_privacy_filter_output: false,
      is_final_eligibility_decision: false,
      matcher_scope: "top2_runtime_catalog",
      candidate_source_set: [],
      privacy_filter_status: "not_run",
      source_standard_company_input_path: sourceStandardCompanyInputPath,
      source_catalog_path: sourceCatalogPath,
      source_catalog_type: runtimeCatalogType
    }
  };
}

function getFieldCandidates(fieldName) {
  const canonical = String(fieldName || "").trim();
  const aliases = MATCHER_FIELD_ALIAS_MAP[canonical] || [];
  return [...new Set([canonical, ...aliases].filter(Boolean))];
}

function resolveMatcherFieldRecord(fields, fieldName) {
  const candidates = getFieldCandidates(fieldName);
  let fallbackRecord = null;
  for (const candidate of candidates) {
    const record = fields?.[candidate];
    if (!record) continue;
    if (String(record.status || "").trim() !== "blank" && String(record.status || "").trim() !== "unknown" && hasMeaningfulValue(record.value)) {
      return record;
    }
    if (!fallbackRecord) {
      fallbackRecord = record;
    }
  }
  return fallbackRecord || {};
}

function resolvePayloadFieldValue(inputObject, fieldName) {
  const candidates = getFieldCandidates(fieldName);
  let fallbackValue = "";
  for (const candidate of candidates) {
    if (!Object.prototype.hasOwnProperty.call(inputObject || {}, candidate)) continue;
    const value = inputObject?.[candidate];
    if (hasMeaningfulValue(value)) {
      return value;
    }
    if (fallbackValue === "") {
      fallbackValue = value;
    }
  }
  return fallbackValue;
}

function fieldObject(value, explicitStatus, label = "manual web form") {
  const hasValue = Array.isArray(value)
    ? value.length > 0
    : value !== null && value !== undefined && String(value).trim() !== "";
  const status = explicitStatus === "unknown" ? "unknown" : hasValue ? "confirmed" : "blank";
  return {
    value: status === "unknown" || status === "blank" ? null : value,
    status,
    source: { type: "manual", label },
    confidence: null,
    notes: ""
  };
}

function derivedObject(value, status, label, notes = "") {
  return {
    value,
    status,
    source: { type: "system_derived", label },
    confidence: null,
    notes
  };
}

function createManifestBase(caseId, now, currentState, extra = {}) {
  return {
    case_id: caseId,
    current_state: currentState,
    standard_company_input_path: null,
    pass1_cli_input_path: null,
    pass1_result_path: null,
    followup_needed_path: null,
    followup_answers_path: null,
    refined_result_path: null,
    last_updated_at: now,
    ...extra
  };
}

function ensureManifestShape(manifest, caseId, now, currentState) {
  return {
    ...createManifestBase(caseId, now, currentState),
    ...(manifest || {}),
    case_id: caseId,
    current_state: currentState,
    last_updated_at: now
  };
}

async function readManifest(manifestPath) {
  try {
    return JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch {
    return null;
  }
}

async function writeManifest(manifestPath, manifest) {
  await fs.mkdir(SESSIONS, { recursive: true });
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
}

function normalizePayload(payload) {
  const now = new Date().toISOString();
  const fieldsInput = payload.fields || {};
  const statuses = payload.statuses || {};
  const companyName = fieldsInput.company_name_or_alias || "";
  const caseId = slugify(payload.case_id || companyName);

  const fields = {};
  const allV2Fields = [
    "company_name_or_alias", "region", "industry_field", "product_tech_summary", "current_stage",
    "top_needs_or_pain_points", "applicant_type", "business_registration_status", "establishment_date",
    "business_age_category", "sme_status", "government_support_restriction_status", "duplicate_support_risk_status",
    "venture_confirmation_status", "investment_status", "self_funding_or_cost_share_status", "green_bio_or_smart_agri_flag",
    "technology_transfer_status", "certification_or_test_need", "sales_record_status", "export_intent",
    "target_country_or_market", "youth_founder_condition_status", "representative_age_condition_status", "additional_matching_notes"
  ];

  for (const field of allV2Fields) {
    let value = resolvePayloadFieldValue(fieldsInput, field);
    if (field === "top_needs_or_pain_points" && typeof value === "string") {
      value = value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
    }
    if (field === "target_country_or_market" && typeof value === "string") {
      value = value.split(/\r?\n|,|;|\/|\|/).map((item) => item.trim()).filter(Boolean);
    }
    fields[field] = fieldObject(value, resolvePayloadFieldValue(statuses, field), "manual web form");
  }

  for (const field of [
    "applicant_type",
    "business_registration_status",
    "business_age_category",
    "sme_status",
    "government_support_restriction_status",
    "duplicate_support_risk_status",
    "venture_confirmation_status",
    "investment_status",
    "self_funding_or_cost_share_status",
    "green_bio_or_smart_agri_flag",
    "technology_transfer_status",
    "certification_or_test_need",
    "sales_record_status",
    "export_intent",
    "target_country_or_market"
  ]) {
    let value = resolvePayloadFieldValue(fieldsInput, field);
    if (field === "target_country_or_market" && typeof value === "string") {
      value = value.split(/\r?\n|,|;|\/|\|/).map((item) => item.trim()).filter(Boolean);
    }
    fields[field] = fieldObject(value, resolvePayloadFieldValue(statuses, field), "not shown in minimum v1 input screen");
  }

  return {
    standardCompanyInput: {
      schema_version: "v1",
      case_id: caseId,
      input_mode: "manual",
      created_at: payload.created_at || now,
      updated_at: now,
      fields,
      derived_fields: {
        business_age: derivedObject("derived from establishment_date", "inferred", "computed from establishment_date", "Exact age computation can be added in the next implementation step."),
        youth_founder_status: derivedObject(null, "blank", "not inferred", "Age band is not part of the minimum input-save screen."),
        preliminary_founder_status: derivedObject(null, "blank", "not inferred", "Not inferred in this minimum input-save step."),
        current_application_possible_status: derivedObject("manual input saved", "inferred", "input-save state", "No matching result is generated in this step.")
      },
      internal_metadata: {
        operator_memo: fieldObject(payload.operator_memo || "", undefined, "manual web form"),
        raw_traceability_notes: fieldObject("Saved by app_v1/ui local manual input app.", undefined, "local runtime")
      }
    },
    caseId,
    now
  };
}

function toRepoPath(filePath) {
  return path.relative(REPO_ROOT, filePath).replace(/\\/g, "/");
}

function fromRepoPath(repoPath) {
  return path.resolve(REPO_ROOT, String(repoPath || ""));
}

function safeUploadFilename(filename) {
  const base = path.basename(String(filename || "upload.pdf")).trim() || "upload.pdf";
  return base
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120) || "upload.pdf";
}

function isPdfFilename(filename) {
  return /\.pdf$/i.test(path.basename(String(filename || "")));
}

function isAllowedPdfMimeType(mimeType) {
  const normalized = String(mimeType || "").trim().toLowerCase();
  return !normalized || normalized === "application/pdf" || normalized === "application/octet-stream";
}

async function writeExtractionManifest(manifestPath, manifest) {
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
}

function isPathInside(parentDir, childPath) {
  const relative = path.relative(path.resolve(parentDir), path.resolve(childPath));
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isSafePreviewCaseId(caseId) {
  return /^[A-Za-z0-9_-]+$/.test(String(caseId || "").trim());
}

function isSafeResultCaseId(caseId) {
  return /^[A-Za-z0-9_-]+$/.test(String(caseId || "").trim());
}

function parseScriptJsonOutput(text, label) {
  const raw = String(text || "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error(`Missing JSON object in ${label} output.`);
  }
  return JSON.parse(raw.slice(start, end + 1));
}

async function readJsonFileIfExists(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    return null;
  }
}

async function sha256FileIfExists(filePath) {
  try {
    const raw = await fs.readFile(filePath);
    return crypto.createHash("sha256").update(raw).digest("hex");
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    return null;
  }
}

function getGemmaMatchRuntimePaths(caseId) {
  return {
    pipelineSafeInputPath: path.join(RUNTIME, "v2_pipeline_runs", caseId, "v2_safe_input.json"),
    legacySafeInputPath: path.join(RUNTIME, "v2_safe_input", `${caseId}_v2_safe_input.json`),
    standardInputPath: path.join(RUNTIME, "company_inputs", `${caseId}_standard_company_input.json`),
    outputPath: path.join(RUNTIME, "gemma_match_outputs", `${caseId}_gemma_match_output.manual.json`),
    generatedInputPath: path.join(RUNTIME, "gemma_match_inputs", `${caseId}_gemma_match_input.json`),
    runMetadataPath: path.join(RUNTIME, "gemma_match_outputs", `${caseId}_gemma_match_run_metadata.json`)
  };
}

async function readGemmaRunMetadata(caseId, fallbackRunnerResult = null) {
  const paths = getGemmaMatchRuntimePaths(caseId);
  const computedResultViewModelHash = await sha256FileIfExists(path.join(RESULTS, caseId, "result_view_model.json"));
  const diskMetadata = await readJsonFileIfExists(paths.runMetadataPath);
  if (diskMetadata && typeof diskMetadata === "object") {
    const enriched = {
      ...diskMetadata,
      result_view_model_hash: diskMetadata.result_view_model_hash ?? computedResultViewModelHash ?? null,
      metadata_path: toRepoPath(paths.runMetadataPath)
    };
    return enriched;
  }

  const cacheManifest = fallbackRunnerResult && fallbackRunnerResult.cache_manifest && typeof fallbackRunnerResult.cache_manifest === "object"
    ? fallbackRunnerResult.cache_manifest
    : null;
  if (!cacheManifest) return null;

  const cacheStatus = String(fallbackRunnerResult.cache_status || "unknown").trim() || "unknown";
  return {
    case_id: caseId,
    cache_status: cacheStatus,
    cache_key: fallbackRunnerResult.cache_key || cacheManifest.cache_key || null,
    ollama_skipped: typeof fallbackRunnerResult.ollama_skipped === "boolean"
      ? fallbackRunnerResult.ollama_skipped
      : cacheStatus === "hit"
        ? true
        : cacheStatus === "force_rerun"
          ? false
          : "unknown",
    model: cacheManifest.model || null,
    decoding_options: cacheManifest.decoding_options || null,
    prompt_mode: cacheManifest.prompt_mode || null,
    input_hash: cacheManifest.input_hash || null,
    prompt_hash: cacheManifest.prompt_hash || null,
    raw_output_hash: cacheManifest.raw_output_hash || null,
    manual_output_hash: cacheManifest.manual_output_hash || null,
    result_view_model_hash: computedResultViewModelHash ?? null,
    elapsed_ms: Number.isFinite(Number(fallbackRunnerResult.elapsed_ms)) ? Number(fallbackRunnerResult.elapsed_ms) : null,
    created_at: cacheManifest.created_at || null,
    raw_ocr_pdf_text_exposed: false,
    metadata_path: toRepoPath(paths.runMetadataPath)
  };
}

async function hasAnyGemmaInputSource(caseId) {
  const paths = getGemmaMatchRuntimePaths(caseId);
  const candidates = [paths.pipelineSafeInputPath, paths.legacySafeInputPath, paths.standardInputPath];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return { ok: true, source_path: candidate };
    }
  }
  return { ok: false, source_path: null };
}

function classifyGemmaRunFailure(step, error) {
  const text = [
    error && error.message ? error.message : "",
    error && error.stdout ? error.stdout : "",
    error && error.stderr ? error.stderr : ""
  ].join("\n").toLowerCase();

  if (step === "precheck") {
    return { statusCode: 404, errorCode: "missing_saved_input", message: "저장된 기업 입력 또는 V2 안전 입력을 찾지 못했습니다." };
  }
  if (step === "generate_input") {
    return { statusCode: 500, errorCode: "gemma_input_generation_failed", message: "Gemma 입력 패키지를 생성하지 못했습니다." };
  }
  if (step === "run_ollama") {
    if (text.includes("could not reach ollama")) {
      return { statusCode: 503, errorCode: "ollama_unavailable", message: "로컬 Ollama를 찾지 못했습니다. Gemma 실행을 위해 로컬 모델이 필요합니다." };
    }
    if (text.includes("returned a non-200 response")) {
      return { statusCode: 503, errorCode: "ollama_unavailable", message: "로컬 Ollama 응답을 받지 못했습니다. Gemma 실행을 위해 로컬 모델이 필요합니다." };
    }
    if (text.includes("not valid json")) {
      return { statusCode: 500, errorCode: "ollama_invalid_output", message: "Gemma 실행 결과 형식이 올바르지 않습니다." };
    }
    if (text.includes("timed out") || error?.code === "ETIMEDOUT" || error?.signal === "SIGTERM") {
      return { statusCode: 504, errorCode: "ollama_timeout", message: "로컬 AI 응답이 오래 걸렸습니다. 잠시 후 다시 시도해 주세요." };
    }
    return { statusCode: 500, errorCode: "gemma_run_failed", message: "Gemma 실행 중 오류가 발생했습니다." };
  }
  if (step === "validate_output") {
    if (text.includes("must not contain placeholder dots") || text.includes("placeholder corruption")) {
      return { statusCode: 500, errorCode: "validation_failed", message: "Gemma 결과 검증에 실패했습니다." };
    }
    return { statusCode: 500, errorCode: "validation_failed", message: "Gemma 결과 검증에 실패했습니다." };
  }
  return { statusCode: 500, errorCode: "gemma_run_failed", message: "Gemma 실행 중 오류가 발생했습니다." };
}

function buildGemmaMatchWarnings(generationResult) {
  const warnings = [];
  if (!generationResult || typeof generationResult !== "object") return warnings;
  if (generationResult.source_type && generationResult.source_type !== "v2_pipeline_safe_input") {
    warnings.push("Gemma 입력이 V2 pipeline safe input이 아닌 보조 입력을 사용했습니다.");
  }
  if (typeof generationResult.candidate_count === "number" && generationResult.candidate_count > 0 && generationResult.candidate_count < 5) {
    warnings.push("후보 프로그램 수가 적습니다.");
  }
  if (Array.isArray(generationResult.top_candidate_names) && generationResult.top_candidate_names.length === 0) {
    warnings.push("상위 후보명이 비어 있습니다.");
  }
  return warnings;
}

const GEMMA_RUNTIME_DEFAULTS = {
  OLLAMA_MODEL: "gemma3:1b",
  OLLAMA_TIMEOUT_MS: "300000",
  OLLAMA_TEMPERATURE: "0",
  OLLAMA_SEED: "42"
};
const GEMMA_RUNNER_TIMEOUT_BUFFER_MS = 60000;

function getGemmaRuntimeEnv() {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(GEMMA_RUNTIME_DEFAULTS)) {
    if (!String(env[key] || "").trim()) {
      env[key] = value;
    }
  }
  return env;
}

function getGemmaRuntimeTimeoutMs(env = getGemmaRuntimeEnv()) {
  const rawTimeoutMs = Number.parseInt(String(env.OLLAMA_TIMEOUT_MS || "").trim(), 10);
  const effectiveTimeoutMs = Number.isFinite(rawTimeoutMs) && rawTimeoutMs > 0 ? rawTimeoutMs : Number.parseInt(GEMMA_RUNTIME_DEFAULTS.OLLAMA_TIMEOUT_MS, 10);
  return Math.max(effectiveTimeoutMs + GEMMA_RUNNER_TIMEOUT_BUFFER_MS, effectiveTimeoutMs);
}

function getGemmaRuntimeLogSummary(env = getGemmaRuntimeEnv()) {
  const hasTopP = String(process.env.OLLAMA_TOP_P || "").trim() ? "set" : "unset";
  const hasTopK = String(process.env.OLLAMA_TOP_K || "").trim() ? "set" : "unset";
  return [
    `OLLAMA_MODEL=${env.OLLAMA_MODEL}`,
    `OLLAMA_TIMEOUT_MS=${env.OLLAMA_TIMEOUT_MS}`,
    `OLLAMA_TEMPERATURE=${env.OLLAMA_TEMPERATURE}`,
    `OLLAMA_SEED=${env.OLLAMA_SEED}`,
    `OLLAMA_TOP_P=${hasTopP}`,
    `OLLAMA_TOP_K=${hasTopK}`
  ].join(" ");
}
// --- 누락되었던 필수 도우미 함수 9총사 복구 ---
async function pathExists(filePath) { try { await fs.access(filePath); return true; } catch { return false; } }
function compactErrorText(value, maxLength = 1600) { const text = String(value || "").trim(); return text.length <= maxLength ? text : `${text.slice(0, maxLength)}... [truncated]`; }
function isSafePreviewCaseId(caseId) { return /^[A-Za-z0-9_-]+$/.test(String(caseId || "").trim()); }
function isSafeResultCaseId(caseId) { return /^[A-Za-z0-9_-]+$/.test(String(caseId || "").trim()); }
function sanitizeDraftText(value, maxLength = 500) { const text = String(value || "").replace(/[<>]/g, "").trim(); return text.length > maxLength ? `${text.slice(0, maxLength).trim()}...` : text; }
async function readJsonFileIfExists(filePath) { try { return JSON.parse(await fs.readFile(filePath, "utf8")); } catch { return null; } }
async function sha256FileIfExists(filePath) { try { return crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex"); } catch { return null; } }
function isPathInside(parentDir, childPath) { const relative = path.relative(path.resolve(parentDir), path.resolve(childPath)); return relative && !relative.startsWith("..") && !path.isAbsolute(relative); }
function parseScriptJsonOutput(text, label) { const raw = String(text || "").trim(); const start = raw.indexOf("{"), end = raw.lastIndexOf("}"); if (start < 0 || end < start) throw new Error(`Missing JSON in ${label}`); return JSON.parse(raw.slice(start, end + 1)); }
// ---------------------------------------------
// 💡 [2단계 완료] 윈도우 파일 잠금(Locking)을 원천 우회하는 스마트 자동 업데이트 엔진
const https = require('https');
const fsSync = require('fs'); // 스트림 배포용 동기 모듈
const { exec } = require('child_process');

const CURRENT_VERSION = '1.0.0'; // 🛠️ 현재 데모 프로그램의 베이스 버전 낙인
const GITHUB_VERSION_URL = 'https://raw.githubusercontent.com/질문자님ID/저장소명/main/version.json';
const GITHUB_EXE_URL = 'https://github.com/질문자님ID/저장소명/releases/latest/download/app.exe';

function checkUpdate() {
  console.log(`[Update Sync] 원격 저장소 버전 검사를 개시합니다... (현재 버전: v${CURRENT_VERSION})`);
  
  https.get(GITHUB_VERSION_URL, (res) => {
    if (res.statusCode !== 200) {
      console.warn(`[Update] 버전 체크 스킵 (HTTP 상태 코드: ${res.statusCode})`);
      return;
    }
    
    let data = '';
    res.on('data', (chunk) => data += chunk);
    res.on('end', () => {
      try {
        const remote = JSON.parse(data);
        if (remote.version && remote.version !== CURRENT_VERSION) {
          console.log(`\n📢 [업데이트 발견] 새로운 버전(${remote.version})이 출시되었습니다. 고속 다운로드를 개시합니다...`);
          downloadNewVersion();
        } else {
          console.log('[Update Sync] 현재 최신 버전(v' + CURRENT_VERSION + ')을 안전하게 사용 중입니다.');
        }
      } catch (err) {
        console.error('❌ 업데이트 데이터 파싱 실패:', err.message);
      }
    });
  }).on('error', (err) => console.error('⚠️ 업데이트 체크 중 네트워크 끊김:', err.message));
}

function downloadNewVersion() {
  const tmpFile = "app_new.exe";
  const file = fsSync.createWriteStream(tmpFile);
  
  https.get(GITHUB_EXE_URL, (response) => {
    if (response.statusCode === 302 || response.statusCode === 301) {
      // 깃허브 릴리즈 다운로드 리다이렉션 경로 추적 처리
      https.get(response.headers.location, (redirResponse) => {
        redirResponse.pipe(file);
        bindUpdateFinishEvent(file);
      });
    } else {
      response.pipe(file);
      bindUpdateFinishEvent(file);
    }
  }).on('error', (err) => {
    console.error('❌ 업데이트 파일 다운로드 실패:', err.message);
  });
}

function bindUpdateFinishEvent(fileStream) {
  fileStream.on('finish', () => {
    fileStream.close();
    console.log('✅ [다운로드 완료] 임시 버퍼 적재 완료. 윈도우 파일 잠금 해제 및 자가 교체 스크립트를 기동합니다.');
    
    // 💡 핵심 가드레일: 외부 배치 파일(update.bat)을 생성하여 3초간 타임아웃 대기 후 app.exe 완전 갱신
    const batContent = `@echo off\r\n` +
                       `timeout /t 3 /nobreak > nul\r\n` +
                       `del app.exe\r\n` +
                       `ren app_new.exe app.exe\r\n` +
                       `start app.exe\r\n` +
                       `del update.bat\r\n`;
                       
    fsSync.writeFileSync('update.bat', batContent, 'utf8');
    
    // 배치 파일 백그라운드 구동 후 본체 프로그램 즉시 프로세스 사멸(exit)
    exec('start /b update.bat', () => {
      process.exit(0);
    });
    
    // 안전 장치 리드 타임 직후 프로세스 종료 강제 트리거
    setTimeout(() => { process.exit(0); }, 500);
  });
}

// 💡 메인 서버 가동 시 자동 엔진 활성화용 함수 바인딩 추가
module.exports = {
  checkUpdate,
  send, json, slugify, slugifyCaseIdCandidate, formatUploadTimestamp, generateUploadCaseId, readRequestBody,
  hasMeaningfulValue, hasMeaningfulMatcherFieldValue, hasMinimumCompanyInputForMatching, buildMinimumInputGateFollowupQuestions, buildMinimumInputGateUncertainties, buildMinimumInputGateNextActions, buildMinimumInputGateResult, getFieldCandidates, resolveMatcherFieldRecord, resolvePayloadFieldValue, fieldObject, derivedObject, createManifestBase, ensureManifestShape, readManifest, writeManifest, normalizePayload, toRepoPath, fromRepoPath, safeUploadFilename, isPdfFilename, isAllowedPdfMimeType, pathExists, writeExtractionManifest, compactErrorText, isPathInside, isSafePreviewCaseId, isSafeResultCaseId, sanitizeDraftText, parseScriptJsonOutput, readJsonFileIfExists, sha256FileIfExists
};