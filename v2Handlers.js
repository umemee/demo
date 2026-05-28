// v2Handlers.js
const fs = require("fs/promises");
const path = require("path");
const config = require("./config.js");
const utils = require("./utils.js");

// 1. config에서 모든 설정값 다시 넉넉하게 가져오기 (RUNTIME 에러 완벽 해결!)
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
} = config;

// 2. utils.js에서 필요한 도우미 함수들 가져오기
const {
  send, json, slugify, slugifyCaseIdCandidate, formatUploadTimestamp, generateUploadCaseId, readRequestBody,
  hasMeaningfulValue, resolvePayloadFieldValue, normalizePayload, createManifestBase, fieldObject,
  toRepoPath, pathExists, sanitizeDraftText, hasMinimumCompanyInputForMatching, buildMinimumInputGateResult,
  resolveMatcherFieldRecord, writeManifest
} = utils;

// 3. 분리 과정에서 유실된 텍스트 처리 도우미 함수들 안전하게 복구
function normalizeMatcherText(text) { return String(text || "").toLowerCase().replace(/[\s\-_]+/g, " ").trim(); }
function normalizeCleanEstablishmentDateValue(value) { const match = String(value || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/); return match ? `${match[1]}-${match[2]}-${match[3]}` : null; }
function readCleanPayloadEstablishmentDate(payload) { const val = payload?.fields?.establishment_date; return val ? { value: val, source: "manual" } : null; }
async function readCleanAutofillDraftEstablishmentDate(caseId) { return null; }

// 핀셋 교정: 실제 autofill_draft.json 파일을 찾아서 v2용 고도화 필드 객체를 반환하도록 수정
async function readCleanAutofillDraftBridgeCandidates(caseId) {
  try {
    const draftPath = path.join(config.UPLOADS, slugify(caseId), "autofill_draft.json");
    const raw = await fs.readFile(draftPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed?.v2_safe_candidate_fields || {};
  } catch (error) {
    console.warn(`[Bridge Warning] Draft file load failed for case: ${caseId}`);
    return {};
  }
}

function createEmptyV2SafeInput() {
  const empty = {
    schema_version: "v2_safe_input_draft",
    safe_input_only: true,
    synthetic_fixture: false,
    company_name_or_alias: null,
    region: null,
    industry_field: null,
    product_tech_summary: null,
    current_stage: null,
    top_needs_or_pain_points: [],
    applicant_type: null,
    business_registration_status: null,
    establishment_date: null,
    business_age_category: null,
    sme_status: null,
    government_support_restriction_status: null,
    duplicate_support_risk_status: null,
    venture_confirmation_status: null,
    investment_status: null,
    self_funding_or_cost_share_status: null,
    green_bio_or_smart_agri_flag: null,
    technology_transfer_status: null,
    certification_or_test_need: null,
    sales_record_status: null,
    export_intent: null,
    target_country_or_market: [],
    youth_founder_condition_status: null,
    representative_age_condition_status: null,
    additional_matching_notes: null,
    user_confirmed_fields: [],
    fields_needing_confirmation: []
  };
  return empty;
}

function normalizeV2TextField(value, maxLength = 160) {
  const text = sanitizeDraftText(value, maxLength);
  return text || null;
}

function normalizeV2ArrayField(value, maxLength = 120) {
  const items = Array.isArray(value)
    ? value
    : String(value || "")
      .split(/\r?\n|,|;|\/|\|/)
      .map((item) => item.trim())
      .filter(Boolean);
  const normalized = items
    .map((item) => sanitizeDraftText(item, maxLength))
    .filter(Boolean);
  return normalized;
}

function normalizeV2IndustryField(value, contextText = "") {
  const explicit = normalizeV2TextField(value, 40);
  if (explicit && V2_SAFE_INPUT_ALLOWED_INDUSTRIES.has(explicit)) return explicit;

  const combined = normalizeMatcherText([explicit, contextText].filter(Boolean).join(" "));
  if (!combined) return explicit || null;

  if (/(스마트팜|스마트농업|smart farm|smart agri|agri-tech|agritech)/i.test(combined)) return "스마트농업";
  if (/(그린바이오|green bio|bio|바이오)/i.test(combined)) return "그린바이오";
  if (/(시험|분석|검정|검증|test|analysis|lab|실증)/i.test(combined)) return "시험·분석";
  if (/(해외|수출|export|overseas|global)/i.test(combined)) return "해외진출";
  if (/(저탄소|탄소|carbon|net zero|친환경)/i.test(combined)) return "저탄소 농업";
  if (/(농식품|농업|식품|축산|양돈|양봉|농장|farm|agri)/i.test(combined)) return "농식품";
  if (/(unknown|미상|미확인)/i.test(combined)) return "unknown";
  return null;
}

function normalizeV2GreenBioOrSmartAgriFlag(value, contextText = "") {
  const explicit = normalizeV2TextField(value, 24);
  if (explicit) {
    const lowered = normalizeMatcherText(explicit);
    if (V2_SAFE_INPUT_ALLOWED_GREEN_FLAGS.has(lowered)) return lowered;
    if (/(yes|있음|해당|맞음|관련|가능)/i.test(lowered)) return "yes";
    if (/(no|없음|미해당|아님)/i.test(lowered)) return "no";
    if (/(maybe|possible|가능성|일수)/i.test(lowered)) return "maybe";
    if (/(unknown|미상|미확인)/i.test(lowered)) return "unknown";
    if (/(그린바이오|green bio|스마트농업|스마트팜|smart farm|smart agri|농업)/i.test(lowered)) return "yes";
  }

  const combined = normalizeMatcherText(contextText);
  if (/(그린바이오|green bio|스마트농업|스마트팜|smart farm|smart agri)/i.test(combined)) return "yes";
  return null;
}

function normalizeV2ApplicantType(value, contextText = "") {
  const explicit = normalizeV2TextField(value, 80);
  const combined = normalizeMatcherText([explicit, contextText].filter(Boolean).join(" "));
  if (!combined) return null;

  const hasClearCompanySignal = /(\(주\)|주식회사|법인|corporation|corp\.?|company|co\.,?\s*ltd\.?|ltd\.?|inc\.?|중소기업|sme|small and medium|startup|창업기업|예비창업|농업법인|개인사업자|sole proprietor|sole proprietorship|자영업)/i.test(combined);
  if (!hasClearCompanySignal) return null;

  if (/(예비\s*창업|pre[- ]?startup|pre[- ]?founder|창업\s*기업|startup\s*company|startup|창업기업|예비창업자)/i.test(combined)) {
    return "startup";
  }
  if (/(중소기업|sme|small and medium|소기업)/i.test(combined)) {
    return "sme";
  }
  if (/(개인사업자|sole proprietor|sole proprietorship|자영업)/i.test(combined)) {
    return "sole_proprietor";
  }
  if (/(농업법인|주식회사|법인|corporation|corp\.?|company|co\.,?\s*ltd\.?|ltd\.?|inc\.?)/i.test(combined)) {
    return "corporation";
  }
  return null;
}

function normalizeV2CurrentStage(value, contextText = "") {
  const explicit = normalizeV2TextField(value, 40);
  const combined = normalizeMatcherText([explicit, contextText].filter(Boolean).join(" "));
  if (!combined) return null;

  if (/(예비\s*창업|pre[- ]?startup|pre[- ]?founder|pre[- ]?launch)/i.test(combined)) return "pre_startup";
  if (/(실증|검증|파일럿|pilot|poc|demo|trial|trl|현장실증|field validation)/i.test(combined)) return "field_validation";
  if (/(사업화|상용화|commercialization|commercialisation)/i.test(combined)) return "commercialization";
  if (/(스케일\s*업|scale[- ]?up|성장|growth|scaling|확장)/i.test(combined)) return "growth";
  if (/(창업|startup|초기)/i.test(combined)) return "startup";
  if (/(운영|operation|양산|서비스\s*운영)/i.test(combined)) return "operation";
  const loweredExplicit = normalizeMatcherText(explicit);
  return V2_SAFE_INPUT_ALLOWED_CURRENT_STAGE_VALUES.has(loweredExplicit) ? loweredExplicit : null;
}

function normalizeV2CertificationNeed(value, contextText = "") {
  const explicit = normalizeV2TextField(value, 40);
  if (explicit) {
    const lowered = normalizeMatcherText(explicit);
    if (V2_SAFE_INPUT_ALLOWED_CERTIFICATION_NEEDS.has(lowered)) {
      return lowered;
    }
    if (/(none|없음|해당없음|not applicable|na|미해당)/i.test(lowered)) return "none";
    const hasCert = /(성능검정|인증|검인증|시험인증|certification|test certification)/i.test(lowered);
    const hasDemo = /(demo|시연|실증|pilot|파일럿|시험|test|테스트|검사|검증|trial|poc|trl|현장실증|field validation)/i.test(lowered);
    if (hasCert && hasDemo) return "demo_or_certification";
    if (hasCert) return "certification_or_test";
    if (hasDemo) return "demo_or_pilot";
  }

  const combined = normalizeMatcherText([explicit, contextText].filter(Boolean).join(" "));
  if (!combined) return null;
  if (/(none|없음|해당없음|not applicable|na|미해당)/i.test(combined)) return "none";
  const hasCert = /(성능검정|인증|검인증|시험인증|certification|test certification)/i.test(combined);
  const hasDemo = /(demo|시연|실증|pilot|파일럿|시험|test|테스트|검사|검증|trial|poc|trl|현장실증|field validation)/i.test(combined);
  if (hasCert && hasDemo) return "demo_or_certification";
  if (hasCert) return "certification_or_test";
  if (hasDemo) return "demo_or_pilot";
  return null;
}

function normalizeV2BusinessAgeCategory(value) {
  const explicit = normalizeV2TextField(value, 40);
  if (!explicit) return null;
  const lowered = normalizeMatcherText(explicit)
    .replace(/[\s-]+/g, "_")
    .replace(/_{2,}/g, "_");
  if (V2_SAFE_INPUT_ALLOWED_BUSINESS_AGE_CATEGORIES.has(lowered)) return lowered;
  return null;
}

function markMissingV2Fields(safeInput, confirmedFields = []) {
  const confirmed = new Set(normalizeV2ArrayField(confirmedFields));
  return V2_SAFE_INPUT_VALUE_FIELDS.filter((field) => !confirmed.has(field) && !hasMeaningfulValue(safeInput?.[field]));
}

function normalizeToV2SafeInput(candidateValues = {}, options = {}) {
  const safeInput = createEmptyV2SafeInput();
  safeInput.schema_version = String(options.schema_version || "v2_safe_input_draft").trim() || "v2_safe_input_draft";
  safeInput.synthetic_fixture = Boolean(options.synthetic_fixture);

  const rawText = String(options.local_extracted_text || candidateValues.local_extracted_text || candidateValues.extracted_text || "");
  // 🚀 구식 정규표현식 추출(buildV2CandidateValuesFromText)을 완전히 차단하고, Gemma AI의 추출 결과(candidateValues)만 100% 신뢰하도록 변경했습니다.
  const textCandidates = {}; 
  const mergedCandidates = { ...textCandidates, ...(candidateValues || {}) };

  safeInput.company_name_or_alias = normalizeV2TextField(mergedCandidates.company_name_or_alias, 80);
  safeInput.region = normalizeV2TextField(mergedCandidates.region, 120);
  safeInput.industry_field = normalizeV2IndustryField(mergedCandidates.industry_field, rawText);
  safeInput.product_tech_summary = normalizeV2TextField(mergedCandidates.product_tech_summary, 420);
  safeInput.current_stage = normalizeV2CurrentStage(mergedCandidates.current_stage, [rawText, mergedCandidates.product_tech_summary].filter(Boolean).join(" "));
  safeInput.top_needs_or_pain_points = normalizeV2ArrayField(mergedCandidates.top_needs_or_pain_points, 120);
  safeInput.applicant_type = normalizeV2ApplicantType(mergedCandidates.applicant_type, [rawText, mergedCandidates.product_tech_summary, mergedCandidates.industry_field].filter(Boolean).join(" "));
  safeInput.business_registration_status = normalizeV2TextField(mergedCandidates.business_registration_status, 40);
  safeInput.establishment_date = normalizeCleanEstablishmentDateValue(mergedCandidates.establishment_date);
  safeInput.business_age_category = normalizeV2TextField(mergedCandidates.business_age_category, 40);
  safeInput.sme_status = normalizeV2TextField(mergedCandidates.sme_status, 16);
  safeInput.government_support_restriction_status = normalizeV2TextField(mergedCandidates.government_support_restriction_status, 40);
  safeInput.duplicate_support_risk_status = normalizeV2TextField(mergedCandidates.duplicate_support_risk_status, 40);
  safeInput.venture_confirmation_status = normalizeV2TextField(mergedCandidates.venture_confirmation_status, 40);
  safeInput.investment_status = normalizeV2TextField(mergedCandidates.investment_status, 40);
  safeInput.self_funding_or_cost_share_status = normalizeV2TextField(mergedCandidates.self_funding_or_cost_share_status, 40);
  safeInput.green_bio_or_smart_agri_flag = normalizeV2GreenBioOrSmartAgriFlag(mergedCandidates.green_bio_or_smart_agri_flag, [rawText, mergedCandidates.industry_field, mergedCandidates.product_tech_summary].filter(Boolean).join(" "));
  safeInput.technology_transfer_status = normalizeV2TextField(mergedCandidates.technology_transfer_status, 40);
  safeInput.certification_or_test_need = normalizeV2CertificationNeed(mergedCandidates.certification_or_test_need, [rawText, mergedCandidates.product_tech_summary].filter(Boolean).join(" "));
  safeInput.sales_record_status = normalizeV2TextField(mergedCandidates.sales_record_status, 40);
  safeInput.export_intent = normalizeV2TextField(mergedCandidates.export_intent, 40);
  safeInput.target_country_or_market = normalizeV2ArrayField(mergedCandidates.target_country_or_market, 80);
  safeInput.youth_founder_condition_status = normalizeV2TextField(mergedCandidates.youth_founder_condition_status, 40);
  safeInput.representative_age_condition_status = normalizeV2TextField(mergedCandidates.representative_age_condition_status, 40);
  safeInput.additional_matching_notes = normalizeV2TextField(mergedCandidates.additional_matching_notes, 500);
  
  // 핀셋 추가: HF-8 도메인 격리 필터 및 정량 스코어링 엔진이 실제 참조할 최종 safeInput 프로퍼티 강제 바인딩
  safeInput.total_investment_amount = Number(mergedCandidates.total_investment_amount) || 0;
  safeInput.annual_revenue = Number(mergedCandidates.annual_revenue) || 0;
  safeInput.value_chain_tag = normalizeV2TextField(mergedCandidates.value_chain_tag, 40);
  safeInput.agrifood_value_chain = normalizeV2TextField(mergedCandidates.agrifood_value_chain, 40);
  safeInput.green_bio_or_smart_agri = mergedCandidates.green_bio_or_smart_agri || null;
  safeInput.has_overseas_partner_or_loi = normalizeV2TextField(mergedCandidates.has_overseas_partner_or_loi, 20);
  
  // 💡 [신규 스키마] 2-Step 알고리즘 및 AI 프롬프트를 위한 신규 검증 필드 강제 바인딩
  safeInput.has_own_factory = normalizeV2TextField(mergedCandidates.has_own_factory, 20);
  safeInput.government_awards_certificates = normalizeV2TextField(mergedCandidates.government_awards_certificates, 200);
  safeInput.geographic_advantage = normalizeV2TextField(mergedCandidates.geographic_advantage, 200);

  safeInput.user_confirmed_fields = normalizeV2ArrayField(options.user_confirmed_fields || mergedCandidates.user_confirmed_fields, 80);
  safeInput.fields_needing_confirmation = markMissingV2Fields(safeInput, safeInput.user_confirmed_fields);

  return safeInput;
}

function buildStructuredCompanyInputSummary(standardCompanyInput) {
  const summary = {};
  for (const field of [...CORE_FIELDS, ...CONDITIONAL_FIELDS]) {
    const fieldData = resolveMatcherFieldRecord(standardCompanyInput.fields, field);
    summary[field] = {
      value: fieldData?.value ?? null,
      status: fieldData?.status ?? "blank",
      source_type: fieldData?.source?.type ?? null,
      confidence: fieldData?.confidence ?? null
    };
  }
  return summary;
}

function buildPass1CliInputRequest(standardCompanyInput, standardPath, outputPath, now) {
  return {
    schema_version: "v1",
    case_id: standardCompanyInput.case_id,
    requested_state: "PASS1",
    execution_mode: "file_bridge",
    source_standard_company_input_path: toRepoPath(standardPath),
    structured_company_input_summary: buildStructuredCompanyInputSummary(standardCompanyInput),
    baseline_docs_references: [
      "app_v1/baseline_docs/PROTOTYPE_UI_BASELINE_VALUES.md",
      "app_v1/baseline_docs/PASS1_INPUT_UI_HANDOFF.md",
      "app_v1/baseline_docs/pass1_review_output_template.md"
    ],
    output_target_path: toRepoPath(outputPath),
    created_at: now,
    notes: "Request file only. The local app does not execute CLI or generate PASS1 output."
  };
}

async function handleSave(req, res) {
  try {
    const body = await readRequestBody(req);
    const payload = JSON.parse(body || "{}");
    const { standardCompanyInput, caseId, now } = normalizePayload(payload);
    const payloadFields = payload && payload.fields && typeof payload.fields === "object" && !Array.isArray(payload.fields)
      ? payload.fields
      : {};
    const hasPayloadEstablishmentDateField = Object.prototype.hasOwnProperty.call(payloadFields, "establishment_date");
    const savedEstablishmentDate = normalizeCleanEstablishmentDateValue(standardCompanyInput?.fields?.establishment_date?.value);
    const payloadEstablishmentDate = readCleanPayloadEstablishmentDate(payload);
    if (!savedEstablishmentDate && payloadEstablishmentDate?.value) {
      standardCompanyInput.fields.establishment_date = fieldObject(
        payloadEstablishmentDate.value,
        undefined,
        payloadEstablishmentDate.source
      );
      standardCompanyInput.updated_at = now;
    } else if (!savedEstablishmentDate && !hasPayloadEstablishmentDateField) {
      const autofillEstablishmentDate = await readCleanAutofillDraftEstablishmentDate(caseId);
      if (autofillEstablishmentDate) {
        standardCompanyInput.fields.establishment_date = fieldObject(
          autofillEstablishmentDate,
          undefined,
          "autofill draft v2_safe_candidate_fields.establishment_date"
        );
        standardCompanyInput.updated_at = now;
      }
    }

    const autofillBridgeCandidates = await readCleanAutofillDraftBridgeCandidates(caseId);
    for (const [fieldName, candidate] of Object.entries(autofillBridgeCandidates)) {
      if (fieldName === "establishment_date") continue;
      if (hasMeaningfulValue(standardCompanyInput?.fields?.[fieldName]?.value)) continue;
      standardCompanyInput.fields[fieldName] = fieldObject(
        candidate.value,
        undefined,
        candidate.source || `autofill draft ${fieldName}`
      );
      standardCompanyInput.updated_at = now;
    }

    await fs.mkdir(COMPANY_INPUTS, { recursive: true });
    await fs.mkdir(SESSIONS, { recursive: true });

    const standardPath = path.join(COMPANY_INPUTS, `${caseId}_standard_company_input.json`);
    const manifestPath = path.join(SESSIONS, `${caseId}_session_manifest.json`);
    const standardRel = toRepoPath(standardPath);
    const manifestRel = toRepoPath(manifestPath);

    const manifest = createManifestBase(caseId, now, "MANUAL_INPUT_SAVED", {
      standard_company_input_path: standardRel
    });

    await fs.writeFile(standardPath, JSON.stringify(standardCompanyInput, null, 2), "utf8");
    await writeManifest(manifestPath, manifest);

    let v2SafeInputBridge = null;
    try {
      v2SafeInputBridge = await writeV2SafeInputBridgeFromStandardCompanyInput(standardCompanyInput, payload, now);
    } catch (bridgeError) {
      console.warn("V2 safe input bridge after save failed:", bridgeError && bridgeError.stack ? bridgeError.stack : String(bridgeError));
    }

    json(res, 200, {
      ok: true,
      case_id: caseId,
      standard_company_input_path: standardRel,
      session_manifest_path: manifestRel,
      v2_safe_input_bridge_path: v2SafeInputBridge ? toRepoPath(v2SafeInputBridge.safeInputPath) : null,
      saved: standardCompanyInput,
      manifest
    });
  } catch (error) {
    json(res, 500, { ok: false, error: error.message });
  }
}

async function handleGeneratePass1Request(req, res) {
  try {
    const body = await readRequestBody(req);
    const payload = JSON.parse(body || "{}");
    const caseId = slugify(payload.case_id);
    const now = new Date().toISOString();

    const standardPath = path.join(COMPANY_INPUTS, `${caseId}_standard_company_input.json`);
    const cliInputPath = path.join(CLI_INPUTS, `${caseId}_pass1_cli_input.json`);
    const manifestPath = path.join(SESSIONS, `${caseId}_session_manifest.json`);
    const outputPath = path.join(RESULTS, caseId, "pass1_result.md");

    const standardCompanyInput = JSON.parse(await fs.readFile(standardPath, "utf8"));
    await fs.mkdir(CLI_INPUTS, { recursive: true });
    await fs.mkdir(SESSIONS, { recursive: true });
    await fs.mkdir(path.dirname(outputPath), { recursive: true });

    const request = buildPass1CliInputRequest(standardCompanyInput, standardPath, outputPath, now);
    const manifest = createManifestBase(caseId, now, "PASS1_CLI_INPUT_READY", {
      standard_company_input_path: toRepoPath(standardPath),
      pass1_cli_input_path: toRepoPath(cliInputPath)
    });

    await fs.writeFile(cliInputPath, JSON.stringify(request, null, 2), "utf8");
    await writeManifest(manifestPath, manifest);

    json(res, 200, {
      ok: true,
      case_id: caseId,
      pass1_cli_input_path: toRepoPath(cliInputPath),
      session_manifest_path: toRepoPath(manifestPath),
      request,
      manifest
    });
  } catch (error) {
    json(res, 500, { ok: false, error: error.message });
  }
}

async function loadMatcherProgramCatalog() {
  const loadCatalogFromPath = async (catalogPath, catalogSourceType) => {
    try {
      const raw = await fs.readFile(catalogPath, "utf8");
      const catalog = JSON.parse(raw);
      if (!Array.isArray(catalog?.programs)) return null;
      return {
        ...catalog,
        catalog_source_type: catalogSourceType,
        catalog_path: toRepoPath(catalogPath),
        catalog_file_path: catalogPath
      };
    } catch {
      return null;
    }
  };

  const runtimeTop2Catalog = await loadCatalogFromPath(TOP2_RUNTIME_MATCHER_CATALOG_PATH, "runtime_top2_catalog");
  if (runtimeTop2Catalog?.schema_version === "support_program_runtime_matcher_catalog.top2.v1") {
    return runtimeTop2Catalog;
  }

  const fallbackCatalog = await loadCatalogFromPath(MATCHER_CATALOG_PATH, "structured_criteria_sample");
  if (fallbackCatalog) {
    return fallbackCatalog;
  }

  throw new Error("No matcher catalog was available.");
}

function parseDateOnly(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month, day));
  return Number.isNaN(date.getTime()) ? null : date;
}

function calculateWholeYearsSince(dateValue, asOf = new Date()) {
  const date = parseDateOnly(dateValue);
  if (!date) return null;
  const reference = new Date(asOf.getTime());
  let years = reference.getUTCFullYear() - date.getUTCFullYear();
  const monthDelta = reference.getUTCMonth() - date.getUTCMonth();
  const dayDelta = reference.getUTCDate() - date.getUTCDate();
  if (monthDelta < 0 || (monthDelta === 0 && dayDelta < 0)) {
    years -= 1;
  }
  return years < 0 ? 0 : years;
}

function evaluateAgeOrVentureRule(establishmentDate, ventureConfirmationStatus, asOf = new Date()) {
  const years = calculateWholeYearsSince(establishmentDate, asOf);
  const ventureConfirmed = String(ventureConfirmationStatus || "").trim().toLowerCase() === "confirmed";
  const ageKnown = years !== null;
  const ageWithinLimit = ageKnown ? years <= 7 : null;

  if (ageWithinLimit === true || ventureConfirmed) {
    return {
      status: "pass",
      years,
      ventureConfirmed,
      needsReview: false
    };
  }

  if (!ageKnown && !ventureConfirmationStatus) {
    return {
      status: "needs_review",
      years: null,
      ventureConfirmed: false,
      needsReview: true
    };
  }

  if (ageKnown && years > 7 && String(ventureConfirmationStatus || "").trim().toLowerCase() === "not_confirmed") {
    return {
      status: "fail",
      years,
      ventureConfirmed: false,
      needsReview: false
    };
  }

  if (!ageKnown || String(ventureConfirmationStatus || "").trim() === "") {
    return {
      status: "needs_review",
      years,
      ventureConfirmed: false,
      needsReview: true
    };
  }

  return {
    status: "fail",
    years,
    ventureConfirmed: false,
    needsReview: false
  };
}

function buildRuntimeTop2MatcherResult(caseId, standardCompanyInput, standardPath, catalog, catalogPath) {
  const now = new Date().toISOString();
  const fields = standardCompanyInput?.fields || {};
  if (!hasMinimumCompanyInputForMatching(fields)) {
    return buildMinimumInputGateResult(caseId, standardCompanyInput, standardPath, catalog, catalogPath);
  }
  const programList = Array.isArray(catalog?.programs) ? catalog.programs : [];
  const programById = new Map(programList.map((program) => [program.program_id, program]));

  const getField = (fieldName) => resolveMatcherFieldRecord(fields, fieldName);
  const fieldStatus = (fieldName) => String(getField(fieldName).status || "blank");
  const fieldValue = (fieldName) => {
    const value = getField(fieldName).value;
    if (Array.isArray(value)) {
      return value.map((item) => String(item || "").trim()).filter(Boolean).join(", ");
    }
    return String(value || "").trim();
  };
  const hasMissingOrUnknown = (fieldName) => {
    const status = fieldStatus(fieldName);
    return status === "blank" || status === "unknown" || !fieldValue(fieldName);
  };
  const sourceStandardCompanyInputPath = toRepoPath(standardPath);
  const sourceCatalogPath = toRepoPath(catalogPath);
  const runtimeCatalogType = String(catalog?.catalog_source_type || "runtime_top2_catalog");

  const buildEvidenceTrace = (program, sourceExcerptFields) => sourceExcerptFields.map((fieldName) => ({
    source_type: "standard_company_input",
    source_path: sourceStandardCompanyInputPath,
    field_or_section: fieldName,
    excerpt: sanitizeDraftText(fieldValue(fieldName), 180)
  })).concat([
    {
      source_type: "runtime_support_program_catalog",
      source_path: sourceCatalogPath,
      field_or_section: "program_catalog",
      excerpt: sanitizeDraftText(`${program?.program_id || ""} ${program?.program_name || ""}`, 180)
    }
  ]);

  const buildResultItem = (program, fitStatus, recommendationPosition, recommendationGrade, shortReason, whyItMatches, confirmationItems, missingDocItems, riskFlags, evidenceFields) => ({
    program_id: program?.program_id || "",
    program_name: program?.program_name || "",
    source_card_path: String(program?.source_paths?.official_card_path || program?.source_paths?.latest_notice_path || ""),
    source_priority: String(program?.source_priority || "latest_notice"),
    program_relationship: program?.program_relationship || null,
    safe_input_requirements: program?.safe_input_requirements || null,
    display_badges: Array.isArray(program?.display_badges) ? program.display_badges : [],
    result_state: "PASS1",
    recommendation_position: recommendationPosition,
    recommendation_grade: recommendationGrade,
    fit_status: fitStatus,
    short_reason: shortReason,
    why_it_matches: whyItMatches,
    confirmation_needed_items: confirmationItems,
    missing_documents: missingDocItems,
    risk_flags: riskFlags,
    evidence_trace: buildEvidenceTrace(program, evidenceFields),
    display_disclaimer: "이 결과는 최소 규칙 기반 매칭 초안이며, 최종 자격판정이 아닙니다. 저장된 입력을 다시 검토한 뒤 사용하세요."
  });

  const sproutProgram = programById.get("sprout_invest_up") || {};
  const scaleProgram = programById.get("private_investment_based_scale_up") || {};

  const sproutText = normalizeMatcherText([
    fieldValue("company_name_or_alias"),
    fieldValue("region"),
    fieldValue("industry_field"),
    fieldValue("product_tech_summary"),
    fieldValue("top_needs_or_pain_points"),
    fieldValue("current_stage")
  ].join(" "));
  const sproutTechHits = ["prototype", "시제품", "IP", "특허", "technology", "기술", "commercialization", "상용화", "development", "개발", "검증", "PoC", "pilot"]
    .reduce((count, keyword) => count + (sproutText.includes(normalizeMatcherText(keyword)) ? 1 : 0), 0);
  const sproutNeedHits = ["commercialization", "상용화", "PoC", "pilot", "validation", "검증", "실증"]
    .reduce((count, keyword) => count + (normalizeMatcherText(fieldValue("top_needs_or_pain_points")).includes(normalizeMatcherText(keyword)) ? 1 : 0), 0);
  const sproutStageHits = ["development", "개발", "prototype", "시제품", "validation", "검증", "commercialization", "상용화"]
    .reduce((count, keyword) => count + (normalizeMatcherText(fieldValue("current_stage")).includes(normalizeMatcherText(keyword)) ? 1 : 0), 0);
  const sproutScore = (sproutTechHits > 0 ? 2 : 0) + (sproutNeedHits > 0 ? 1 : 0) + (sproutStageHits > 0 ? 1 : 0);
  const sproutFitStatus = sproutScore >= 4 ? "적합" : sproutScore >= 2 ? "부분 적합" : "확인 필요";

  const sproutRecommendation = buildResultItem(
    sproutProgram,
    sproutFitStatus,
    "secondary_conditional",
    sproutFitStatus === "적합" ? "conditional_candidate" : sproutFitStatus === "부분 적합" ? "conditional_candidate" : "reference_candidate",
    sproutFitStatus === "적합"
      ? "SPROUT 경로는 현재 입력의 상용화·기술 신호와 잘 맞습니다."
      : sproutFitStatus === "부분 적합"
        ? "SPROUT 경로는 기술 사업화 후보로 보이지만 증빙 보완이 필요합니다."
        : "SPROUT 경로는 현재 입력만으로는 추가 확인이 필요합니다.",
    [
      sproutTechHits > 0 ? "기술 상용화 / 시제품 / PoC / 파일럿 맥락이 보입니다." : "기술 상용화 신호가 약해 우선 확인이 필요합니다.",
      sproutNeedHits > 0 ? "요청 니즈가 기술 사업화와 맞닿아 있습니다." : "요청 니즈가 기술 사업화와 직접 연결되는지 추가 확인이 필요합니다.",
      sproutStageHits > 0 ? "현재 단계가 개발 / 검증 / 상용화 흐름과 연결됩니다." : "현재 단계는 추가 검토가 필요합니다."
    ],
    [
      fieldStatus("sme_status") === "confirmed" ? null : "중소기업 확인서",
      fieldStatus("applicant_type") === "confirmed" ? null : "신청 주체 확인",
      fieldStatus("government_support_restriction_status") === "confirmed" ? null : "정부지원 제한 없음 확인"
    ].filter(Boolean),
    sproutProgram.required_documents || [],
    [
      hasMissingOrUnknown("sme_status") ? "sme_requirement_needs_review" : null,
      "youth_preference_non_blocking"
    ].filter(Boolean),
    ["product_tech_summary", "current_stage", "applicant_type", "sme_status"]
  );

  const scaleInvestmentHits = ["investment", "투자", "term sheet", "투자계약", "matching fund", "매칭펀드", "venture", "벤처", "self-funding", "자부담", "scale up", "스케일업"]
    .reduce((count, keyword) => count + (normalizeMatcherText([
      fieldValue("company_name_or_alias"),
      fieldValue("region"),
      fieldValue("industry_field"),
      fieldValue("product_tech_summary"),
      fieldValue("top_needs_or_pain_points"),
      fieldValue("current_stage"),
      fieldValue("investment_status"),
      fieldValue("self_funding_or_cost_share"),
      fieldValue("venture_confirmation_status")
    ].join(" ")).includes(normalizeMatcherText(keyword)) ? 1 : 0), 0);
  const scaleStageHits = ["growth", "성장", "scale", "스케일", "expansion", "확장"]
    .reduce((count, keyword) => count + (normalizeMatcherText(fieldValue("current_stage")).includes(normalizeMatcherText(keyword)) ? 1 : 0), 0);
  const scaleOrRule = evaluateAgeOrVentureRule(fieldValue("establishment_date"), fieldStatus("venture_confirmation_status"), new Date(now));
  const scaleScore = (scaleInvestmentHits > 0 ? 2 : 0) + (scaleStageHits > 0 ? 1 : 0) + (scaleOrRule.status === "pass" ? 1 : 0) + (!hasMissingOrUnknown("self_funding_or_cost_share") ? 1 : 0);
  const scaleFitStatus = scaleOrRule.status === "fail" ? "확인 필요" : scaleScore >= 4 ? "적합" : scaleScore >= 3 ? "부분 적합" : "확인 필요";

  const scaleRecommendation = buildResultItem(
    scaleProgram,
    scaleFitStatus,
    "future_option",
    scaleFitStatus === "적합" ? "strong_candidate" : scaleFitStatus === "부분 적합" ? "conditional_candidate" : "reference_candidate",
    scaleOrRule.status === "pass"
      ? "민간투자 기반 스케일업 경로는 현재 입력과 OR eligibility rule이 맞습니다."
      : scaleOrRule.status === "needs_review"
        ? "민간투자 기반 스케일업 경로는 설립일과 벤처확인 여부를 추가 확인해야 합니다."
        : "민간투자 기반 스케일업 경로는 현재 입력만으로는 추가 확인이 필요합니다.",
    [
      scaleInvestmentHits > 0 ? "투자 / 매칭펀드 / 벤처 신호가 보여 미래 경로로는 검토 가능합니다." : "투자 기반 증빙은 아직 보이지 않습니다.",
      scaleStageHits > 0 ? "성장 / 확장 단계 설명이 있어 미래 옵션으로는 남겨둘 수 있습니다." : "성장 단계 설명은 추가로 확인이 필요합니다.",
      scaleOrRule.status === "pass" ? "7년 이내 또는 벤처확인기업 조건을 충족합니다." : scaleOrRule.status === "needs_review" ? "설립일과 벤처확인 여부가 모두 불명확합니다." : "7년 초과이면서 벤처확인도 확인되지 않습니다."
    ],
    [
      fieldStatus("investment_status") === "confirmed" ? null : "민간투자 증빙",
      fieldStatus("self_funding_or_cost_share") === "confirmed" ? null : "자부담 / 매칭펀드 계획",
      fieldStatus("venture_confirmation_status") === "confirmed" ? null : "벤처 또는 기술 증빙",
      scaleOrRule.status === "pass" ? null : "설립일 / 벤처확인 요건"
    ].filter(Boolean),
    scaleProgram.required_documents || [],
    [
      hasMissingOrUnknown("investment_status") ? "investment_evidence_missing" : null,
      hasMissingOrUnknown("self_funding_or_cost_share") ? "cost_share_unclear" : null,
      scaleOrRule.status === "needs_review" ? "eligibility_unconfirmed" : null
    ].filter(Boolean),
    ["investment_status", "self_funding_or_cost_share", "venture_confirmation_status", "establishment_date", "current_stage"]
  );

  const recommendations = [sproutRecommendation, scaleRecommendation];
  const followupQuestions = [];
  for (const program of [sproutProgram, scaleProgram]) {
    for (const item of Array.isArray(program?.followup_questions) ? program.followup_questions : []) {
      const relatedFields = Array.isArray(item?.related_fields) ? item.related_fields : [];
      if (relatedFields.some((fieldName) => hasMissingOrUnknown(fieldName))) {
        followupQuestions.push({
          ...item,
          program_id: program?.program_id || null,
          program_name: program?.program_name || null,
          matcher_use_policy: "followup_question_only"
        });
      }
    }
  }

  const missingDocuments = [];
  for (const program of [sproutProgram, scaleProgram]) {
    for (const item of Array.isArray(program?.required_documents) ? program.required_documents : []) {
      missingDocuments.push({
        document_id: item.document_id || null,
        document_name: item.document_name || "",
        required_for_programs: [program?.program_id || ""].filter(Boolean),
        priority: item.requirement === "required" ? "high" : "medium",
        when_needed: "required_for_application",
        display_label: item.document_name || "",
        privacy_note: "Document title only. No raw evidence text.",
        source_section: item.source_section || null,
        source_classification: "runtime_catalog",
        matcher_use_policy: "matcher_rule_allowed"
      });
    }
  }

  const remainingUncertainties = [];
  const uncertaintyMap = [
    {
      field: "sme_status",
      category: "eligibility",
      description: "중소기업 여부가 아직 확정되지 않았습니다.",
      affected_programs: ["sprout_invest_up"],
      needed_evidence: "중소기업 확인서",
      severity: "high"
    },
    {
      field: "establishment_date",
      category: "eligibility",
      description: "설립일 또는 창업 연차가 아직 확정되지 않았습니다.",
      affected_programs: ["private_investment_based_scale_up"],
      needed_evidence: "설립일 확인 자료",
      severity: "high"
    },
    {
      field: "venture_confirmation_status",
      category: "eligibility",
      description: "벤처확인 여부가 아직 확정되지 않았습니다.",
      affected_programs: ["private_investment_based_scale_up"],
      needed_evidence: "벤처확인서",
      severity: "high"
    },
    {
      field: "investment_status",
      category: "investment",
      description: "민간투자 증빙이 아직 없습니다.",
      affected_programs: ["private_investment_based_scale_up"],
      needed_evidence: "투자계약, 텀시트, 투자확인 자료",
      severity: "medium"
    },
    {
      field: "self_funding_or_cost_share",
      category: "funding",
      description: "자부담 또는 매칭펀드 준비가 아직 불명확합니다.",
      affected_programs: ["private_investment_based_scale_up"],
      needed_evidence: "예산 또는 자부담 계획",
      severity: "medium"
    }
  ];
  for (const item of uncertaintyMap) {
    if (!hasMissingOrUnknown(item.field)) continue;
    remainingUncertainties.push({
      uncertainty_id: item.field,
      category: item.category,
      description: item.description,
      affected_programs: item.affected_programs,
      needed_evidence: item.needed_evidence,
      severity: item.severity,
      can_proceed_with_demo: true
    });
  }

  const nextActions = [
    {
      action_id: "review_saved_input",
      action: "확인된 입력값을 다시 검토",
      owner: "user",
      priority: "high",
      related_programs: recommendations.map((item) => item.program_id),
      depends_on: ["standard_company_input.json"],
      expected_output: "화면의 입력값이 계속 확정 원본으로 유지됩니다.",
      demo_safe_wording: "저장된 입력을 다시 확인해 주세요."
    },
    {
      action_id: "attach_missing_evidence",
      action: "부족한 증빙 문서 보완",
      owner: "user",
      priority: "high",
      related_programs: recommendations.map((item) => item.program_id),
      depends_on: followupQuestions.slice(0, 5).map((item) => item.question_id),
      expected_output: "요건 핵심 항목이 더 분명해집니다.",
      demo_safe_wording: "핵심 확인 항목의 증빙을 보완해 주세요."
    },
    {
      action_id: "rerun_matcher",
      action: "입력 저장 후 매칭 재실행",
      owner: "user",
      priority: "medium",
      related_programs: recommendations.map((item) => item.program_id),
      depends_on: ["standard_company_input.json"],
      expected_output: "갱신된 추천 결과가 result_view_model.json에 저장됩니다.",
      demo_safe_wording: "저장 후 매칭을 다시 실행해 주세요."
    }
  ];

  const displayWarnings = [
    "최소 규칙 기반 매칭 초안입니다. 추천을 바로 믿지 말고 저장된 입력을 다시 검토해 주세요.",
    "개인정보 필터는 아직 실행되지 않았습니다.",
    "이 결과는 최종 자격판정이 아닙니다.",
    `Active support-program catalog: ${runtimeCatalogType}`
  ];
  if (followupQuestions.length) {
    displayWarnings.push("일부 요건 핵심 항목이 아직 비어 있거나 미확인 상태입니다.");
  }

  const evidenceTrace = [
    {
      source_type: "standard_company_input",
      source_path: sourceStandardCompanyInputPath,
      field_or_section: "company_summary",
      excerpt: sanitizeDraftText([
        fieldValue("company_name_or_alias"),
        fieldValue("region"),
        fieldValue("industry_field"),
        fieldValue("product_tech_summary")
      ].join(" "), 260)
    },
    {
      source_type: "runtime_support_program_catalog",
      source_path: sourceCatalogPath,
      field_or_section: "program_catalog",
      excerpt: sanitizeDraftText(programList.map((program) => program.program_name).join(" | "), 260)
    }
  ];

  return {
    schema_version: "v1",
    case_id: caseId,
    result_state: "PASS1",
    generated_from: {
      source_standard_company_input_path: sourceStandardCompanyInputPath,
      source_catalog_path: sourceCatalogPath,
      source_catalog_type: runtimeCatalogType,
      matcher_scope: "top2_runtime_catalog",
      candidate_source_set: recommendations.map((program) => program.program_id),
      generation_mode: "runtime_matcher",
      is_runtime_matcher_output: true,
      is_privacy_filter_output: false,
      is_final_eligibility_decision: false,
      privacy_filter_status: "not_run"
    },
    company_summary: {
      company_name_or_alias: {
        value: fieldValue("company_name_or_alias"),
        status: fieldStatus("company_name_or_alias")
      },
      region: {
        value: fieldValue("region"),
        status: fieldStatus("region")
      },
      industry_field: {
        value: fieldValue("industry_field"),
        status: fieldStatus("industry_field")
      },
      product_tech_summary: {
        value: fieldValue("product_tech_summary"),
        status: fieldStatus("product_tech_summary")
      },
      top_needs_or_pain_points: {
        value: fieldValue("top_needs_or_pain_points"),
        status: fieldStatus("top_needs_or_pain_points")
      }
    },
    recommendations,
    followup_questions: followupQuestions,
    remaining_uncertainties: remainingUncertainties,
    missing_documents: missingDocuments,
    next_actions: nextActions,
    evidence_trace: evidenceTrace,
    display_warnings: displayWarnings,
    metadata: {
      generation_mode: "runtime_matcher",
      is_runtime_matcher_output: true,
      is_privacy_filter_output: false,
      is_final_eligibility_decision: false,
      matcher_scope: "top2_runtime_catalog",
      candidate_source_set: recommendations.map((program) => program.program_id),
      privacy_filter_status: "not_run",
      source_standard_company_input_path: sourceStandardCompanyInputPath,
      source_catalog_path: sourceCatalogPath,
      source_catalog_type: runtimeCatalogType
    }
  };
}

function buildRuntimeMatcherResult(caseId, standardCompanyInput, standardPath, criteria, criteriaPath) {
  if (String(criteria?.catalog_source_type || "") === "runtime_top2_catalog") {
    return buildRuntimeTop2MatcherResult(caseId, standardCompanyInput, standardPath, criteria, criteriaPath);
  }

  const now = new Date().toISOString();
  const fields = standardCompanyInput?.fields || {};
  const programList = Array.isArray(criteria?.programs) ? criteria.programs : [];
  const programById = new Map(programList.map((program) => [program.program_id, program]));

  const getField = (fieldName) => resolveMatcherFieldRecord(fields, fieldName);
  const fieldStatus = (fieldName) => String(getField(fieldName).status || "blank");
  const fieldValue = (fieldName) => {
    const value = getField(fieldName).value;
    if (Array.isArray(value)) {
      return value.map((item) => String(item || "").trim()).filter(Boolean).join(", ");
    }
    return String(value || "").trim();
  };
  const fieldArray = (fieldName) => {
    const value = getField(fieldName).value;
    return Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean) : [];
  };
  const fieldText = (fieldName) => normalizeMatcherText(fieldValue(fieldName));
  const combinedText = normalizeMatcherText([
    fieldValue("company_name_or_alias"),
    fieldValue("region"),
    fieldValue("industry_field"),
    fieldValue("product_tech_summary"),
    fieldValue("top_needs_or_pain_points"),
    fieldValue("current_stage"),
    fieldValue("investment_status"),
    fieldValue("self_funding_or_cost_share"),
    fieldValue("venture_confirmation_status"),
    fieldValue("poc_or_testbed_experience"),
    fieldValue("schedule_readiness")
  ].join(" "));
  const countHits = (text, keywords) => keywords.reduce((count, keyword) => count + (normalizeMatcherText(text).includes(normalizeMatcherText(keyword)) ? 1 : 0), 0);
  const hasAny = (text, keywords) => countHits(text, keywords) > 0;
  const hasMissingOrUnknown = (fieldName) => {
    const status = fieldStatus(fieldName);
    return status === "blank" || status === "unknown" || !fieldValue(fieldName);
  };
  const sourceStandardCompanyInputPath = toRepoPath(standardPath);
  const sourceCriteriaPath = toRepoPath(criteriaPath);

  const coreFieldStatuses = [
    "applicant_type",
    "sme_status",
    "government_support_restriction_status",
    "current_stage",
    "investment_status",
    "self_funding_or_cost_share",
    "schedule_readiness",
    "poc_or_testbed_experience",
    "venture_confirmation_status"
  ];
  const blankCount = coreFieldStatuses.filter((fieldName) => hasMissingOrUnknown(fieldName)).length;

  const companySummary = {
    company_name_or_alias: {
      value: fieldArray("company_name_or_alias").length ? fieldValue("company_name_or_alias") : fieldValue("company_name_or_alias"),
      status: fieldStatus("company_name_or_alias"),
      source_standard_company_input_path: sourceStandardCompanyInputPath
    },
    region: {
      value: fieldValue("region"),
      status: fieldStatus("region")
    },
    industry_field: {
      value: fieldValue("industry_field"),
      status: fieldStatus("industry_field")
    },
    product_tech_summary: {
      value: fieldValue("product_tech_summary"),
      status: fieldStatus("product_tech_summary")
    },
    top_needs_or_pain_points: {
      value: fieldArray("top_needs_or_pain_points"),
      status: fieldStatus("top_needs_or_pain_points")
    },
    input_completeness: {
      value: blankCount ? "partial" : "complete",
      status: "inferred"
    },
    source_standard_company_input_path: sourceStandardCompanyInputPath
  };

  const buildMissingDocument = (fieldName, documentName, purpose, priority, requiredForPrograms, notes) => {
    if (!hasMissingOrUnknown(fieldName)) return null;
    return {
      document_id: `${fieldName}_evidence`,
      document_name: documentName,
      required_for_programs: requiredForPrograms,
      purpose,
      priority,
      status: "requested",
      source_classification: "runtime_matcher_template",
      matcher_use_policy: "runtime_matcher_template",
      display_group: "needs_structuring_document",
      notes
    };
  };

  const buildQuestion = (questionId, question, priority, relatedPrograms, relatedFields, whyItMatters, expectedEvidence, blockingLevel) => ({
    question_id: questionId,
    question,
    priority,
    related_programs: relatedPrograms,
    related_fields: relatedFields,
    why_it_matters: whyItMatters,
    expected_evidence_or_document: expectedEvidence,
    blocking_level: blockingLevel
  });

  const followupTemplates = [
    buildQuestion(
      "applicant_type",
      "이 회사의 신청 주체는 무엇인가요?",
      "core_top_5",
      [
        "agrifood_ai_fast_commercialization",
        "sprout_invest_up",
        "private_investment_based_scale_up"
      ],
      ["applicant_type"],
      "신청 주체는 허용되는 법인/개인 유형에 맞는지 확인하는 데 필요합니다.",
      "사업자등록증 또는 법인 근거 자료",
      "high"
    ),
    buildQuestion(
      "sme_status",
      "중소기업 여부를 확인할 수 있나요?",
      "core_top_5",
      [
        "agrifood_ai_fast_commercialization",
        "sprout_invest_up",
        "private_investment_based_scale_up"
      ],
      ["sme_status"],
      "중소기업 확인은 상용화형 지원사업에서 자주 필요한 기본 요건입니다.",
      "중소기업 확인서",
      "high"
    ),
    buildQuestion(
      "government_support_restriction_status",
      "정부지원 제한 또는 제외 사유가 있나요?",
      "core_top_5",
      [
        "agrifood_ai_fast_commercialization",
        "sprout_invest_up",
        "private_investment_based_scale_up"
      ],
      ["government_support_restriction_status"],
      "대부분의 공공지원사업에서 기본적으로 확인하는 참여 제한 항목입니다.",
      "제한 없음 확인 자료 또는 사유 설명",
      "high"
    ),
    buildQuestion(
      "current_stage",
      "현재 제품 / 상용화 단계는 무엇인가요?",
      "core_top_5",
      [
        "agrifood_ai_fast_commercialization",
        "sprout_invest_up"
      ],
      ["current_stage"],
      "앞선 두 후보는 상용화와 성장 단계에 따라 갈립니다.",
      "개발, 검증, 파일럿, 상용화 단계 메모",
      "medium"
    ),
    buildQuestion(
      "schedule_readiness",
      "이번 회차에 신청할 준비가 되었나요?",
      "core_top_5",
      [
        "agrifood_ai_fast_commercialization",
        "sprout_invest_up",
        "private_investment_based_scale_up"
      ],
      ["schedule_readiness"],
      "일정은 현재 경로를 바로 시도할 수 있는지 판단하는 데 중요합니다.",
      "신청 일정 또는 제출 준비 메모",
      "medium"
    ),
    buildQuestion(
      "poc_or_testbed_experience",
      "PoC / 파일럿 / 테스트베드 증빙이 있나요?",
      "program_specific_additional",
      [
        "agrifood_ai_fast_commercialization",
        "sprout_invest_up"
      ],
      ["poc_or_testbed_experience"],
      "PoC와 파일럿 증빙은 상용화 설명을 더 강하게 만들어 줍니다.",
      "PoC, 파일럿, 테스트베드 또는 검증 기록",
      "medium"
    ),
    buildQuestion(
      "venture_confirmation_status",
      "벤처 또는 기술 확인 증빙이 있나요?",
      "program_specific_additional",
      [
        "sprout_invest_up",
        "private_investment_based_scale_up"
      ],
      ["venture_confirmation_status"],
      "기술 또는 벤처 증빙은 더 강한 성장 경로를 구분하는 데 도움이 됩니다.",
      "벤처, IP, 시제품 증빙",
      "medium"
    ),
    buildQuestion(
      "investment_status",
      "스케일업 경로를 위한 민간투자 증빙이 있나요?",
      "scale_up_only",
      ["private_investment_based_scale_up"],
      ["investment_status"],
      "스케일업 경로는 민간투자와 매칭펀드 준비가 중요합니다.",
      "투자계약, 텀시트, 투자확인 자료",
      "low"
    ),
    buildQuestion(
      "self_funding_or_cost_share",
      "자부담 또는 매칭펀드 준비가 되었나요?",
      "scale_up_only",
      ["private_investment_based_scale_up"],
      ["self_funding_or_cost_share"],
      "자부담 준비는 향후 스케일업 경로에서 중요합니다.",
      "예산 또는 자부담 계획",
      "low"
    )
  ];

  const documentTemplates = [
    buildMissingDocument(
      "applicant_type",
      "사업자등록증 또는 법인등기부등본",
      "신청 주체 확인",
      "high",
      [
        "agrifood_ai_fast_commercialization",
        "sprout_invest_up",
        "private_investment_based_scale_up"
      ],
      "신청 주체 증빙이 아직 필요합니다."
    ),
    buildMissingDocument(
      "sme_status",
      "중소기업 확인서",
      "중소기업 요건 확인",
      "high",
      [
        "agrifood_ai_fast_commercialization",
        "sprout_invest_up",
        "private_investment_based_scale_up"
      ],
      "중소기업 확인이 아직 첨부되지 않았습니다."
    ),
    buildMissingDocument(
      "government_support_restriction_status",
      "정부지원 제한 없음 확인 자료",
      "참여 제한 확인",
      "high",
      [
        "agrifood_ai_fast_commercialization",
        "sprout_invest_up",
        "private_investment_based_scale_up"
      ],
      "정부지원 제한 또는 제외 확인이 아직 공식화되지 않았습니다."
    ),
    buildMissingDocument(
      "current_stage",
      "제품 단계 설명 자료",
      "상용화 단계 확인",
      "medium",
      [
        "agrifood_ai_fast_commercialization",
        "sprout_invest_up"
      ],
      "현재 상용화 단계 증빙이 아직 필요합니다."
    ),
    buildMissingDocument(
      "poc_or_testbed_experience",
      "PoC / 파일럿 / 테스트베드 증빙",
      "PoC 및 실증 확인",
      "medium",
      [
        "agrifood_ai_fast_commercialization",
        "sprout_invest_up"
      ],
      "PoC 또는 파일럿 증빙은 현재 후보 경로에 도움이 됩니다."
    ),
    buildMissingDocument(
      "venture_confirmation_status",
      "벤처 확인서 또는 기술증빙",
      "기술 성장성 확인",
      "medium",
      [
        "sprout_invest_up",
        "private_investment_based_scale_up"
      ],
      "벤처 또는 기술 증빙이 아직 부족합니다."
    ),
    buildMissingDocument(
      "investment_status",
      "민간투자 증빙",
      "스케일업 경로 확인",
      "medium",
      ["private_investment_based_scale_up"],
      "스케일업 경로에 필요한 민간투자 증빙이 아직 없습니다."
    ),
    buildMissingDocument(
      "self_funding_or_cost_share",
      "자부담 / 매칭펀드 계획",
      "매칭펀드 준비",
      "medium",
      ["private_investment_based_scale_up"],
      "자부담 또는 매칭펀드 준비가 아직 불명확합니다."
    ),
    buildMissingDocument(
      "schedule_readiness",
      "신청 일정 또는 제출 준비 메모",
      "이번 회차 신청 가능 여부",
      "low",
      [
        "agrifood_ai_fast_commercialization",
        "sprout_invest_up",
        "private_investment_based_scale_up"
      ],
      "신청 일정 또는 제출 준비가 아직 확인되지 않았습니다."
    )
  ].filter(Boolean);

  const agrifoodProgram = programById.get("agrifood_ai_fast_commercialization") || {};
  const sproutProgram = programById.get("sprout_invest_up") || {};
  const scaleProgram = programById.get("private_investment_based_scale_up") || {};

  const agrifoodText = combinedText;
  const agrifoodAiHits = countHits(agrifoodText, ["AI", "인공지능", "농식품", "agri", "agri-tech", "스마트팜", "축산", "양돈", "양봉", "sensor", "vision"]);
  const agrifoodCommercializationHits = countHits(agrifoodText, ["commercialization", "상용화", "PoC", "pilot", "실증", "validation", "검증", "배포"]);
  const agrifoodStageHits = countHits(fieldText("current_stage"), ["development", "개발", "prototype", "시제품", "validation", "검증", "pilot", "파일럿", "commercialization", "상용화"]);
  const agrifoodScore = (agrifoodAiHits > 0 ? 2 : 0) + (agrifoodCommercializationHits > 0 ? 2 : 0) + (agrifoodStageHits > 0 ? 1 : 0);
  const agrifoodFitStatus = agrifoodScore >= 4 ? "적합" : agrifoodScore >= 2 ? "부분 적합" : "확인 필요";

  const sproutTechHits = countHits(combinedText, ["prototype", "시제품", "IP", "특허", "technology", "기술", "commercialization", "상용화", "development", "개발", "검증", "PoC", "pilot"]);
  const sproutNeedHits = countHits(fieldText("top_needs_or_pain_points"), ["commercialization", "상용화", "PoC", "pilot", "validation", "검증", "실증"]);
  const sproutStageHits = countHits(fieldText("current_stage"), ["development", "개발", "prototype", "시제품", "validation", "검증", "commercialization", "상용화"]);
  const sproutScore = (sproutTechHits > 0 ? 2 : 0) + (sproutNeedHits > 0 ? 1 : 0) + (sproutStageHits > 0 ? 1 : 0);
  const sproutFitStatus = sproutScore >= 4 ? "적합" : sproutScore >= 2 ? "부분 적합" : "확인 필요";

  const scaleInvestmentHits = countHits(combinedText, ["investment", "투자", "term sheet", "투자계약", "matching fund", "매칭펀드", "venture", "벤처", "self-funding", "자부담", "scale up", "스케일업"]);
  const scaleStageHits = countHits(fieldText("current_stage"), ["growth", "성장", "scale", "스케일", "expansion", "확장"]);
  const scaleScore = (scaleInvestmentHits > 0 ? 2 : 0) + (scaleStageHits > 0 ? 1 : 0) + (!hasMissingOrUnknown("self_funding_or_cost_share") ? 1 : 0);
  const scaleFitStatus = scaleScore >= 3 ? "부분 적합" : "확인 필요";

  const buildEvidenceTrace = (program, sourceExcerptFields) => sourceExcerptFields.map((fieldName) => ({
    source_type: "standard_company_input",
    source_path: sourceStandardCompanyInputPath,
    field_or_section: fieldName,
    excerpt: sanitizeDraftText(fieldValue(fieldName), 180)
  })).concat([
    {
      source_type: "official_card",
      source_path: String(program?.source_card_path || ""),
      field_or_section: "program_card",
      excerpt: sanitizeDraftText(program?.program_name || "", 180)
    }
  ]);

  const buildResultItem = (program, fitStatus, recommendationPosition, recommendationGrade, shortReason, whyItMatches, confirmationItems, missingDocItems, riskFlags, evidenceFields) => ({
    program_id: program?.program_id || "",
    program_name: program?.program_name || "",
    source_card_path: String(program?.source_card_path || ""),
    result_state: "PASS1",
    recommendation_position: recommendationPosition,
    recommendation_grade: recommendationGrade,
    fit_status: fitStatus,
    short_reason: shortReason,
    why_it_matches: whyItMatches,
    confirmation_needed_items: confirmationItems,
    missing_documents: missingDocItems,
    risk_flags: riskFlags,
    evidence_trace: buildEvidenceTrace(program, evidenceFields),
    display_disclaimer: "이 결과는 최소 규칙 기반 매칭 초안이며, 최종 자격판정이 아닙니다. 저장된 입력을 다시 검토한 뒤 사용하세요."
  });

  const agrifoodRecommendation = buildResultItem(
    agrifoodProgram,
    agrifoodFitStatus,
    "primary",
    agrifoodFitStatus === "적합" ? "strong_candidate" : agrifoodFitStatus === "부분 적합" ? "conditional_candidate" : "reference_candidate",
    agrifoodFitStatus === "적합"
      ? "농식품 AI 상용화형 지원사업과 입력 내용의 방향성이 잘 맞습니다."
      : agrifoodFitStatus === "부분 적합"
        ? "농식품 AI 상용화형 지원사업과 일부 핵심 신호가 맞습니다."
        : "농식품 AI 상용화형 지원사업은 현재 입력만으로는 확실성을 높이기 어렵습니다.",
    [
      agrifoodAiHits > 0 ? "업종·제품 설명에서 AI / 농식품 맥락이 보입니다." : "업종·제품 설명에서 농식품 AI와 직접 연결되는 신호는 제한적입니다.",
      agrifoodCommercializationHits > 0 ? "상용화, PoC, 파일럿, 검증 니즈가 보여 초기 상용화 지원과 맞습니다." : "상용화 신호가 약해도 검토 단계의 후속 확인은 가능합니다.",
      agrifoodStageHits > 0 ? "현재 단계 설명이 검증·상용화 흐름과 맞습니다." : "현재 단계는 추가 확인이 필요합니다."
    ],
    [
      fieldStatus("applicant_type") === "confirmed" ? null : "신청 주체 확인",
      fieldStatus("sme_status") === "confirmed" ? null : "중소기업 확인",
      fieldStatus("government_support_restriction_status") === "confirmed" ? null : "정부지원 제한 없음 확인",
      fieldStatus("current_stage") === "confirmed" ? null : "현재 단계 확인",
      fieldStatus("self_funding_or_cost_share") === "confirmed" ? null : "자부담 / 매칭펀드 준비"
    ].filter(Boolean),
    documentTemplates.filter((item) => item && item.required_for_programs.includes("agrifood_ai_fast_commercialization")),
    [
      "documentation_pending",
      "eligibility_unconfirmed",
      "external_verification_pending"
    ],
    ["industry_field", "product_tech_summary", "top_needs_or_pain_points", "current_stage", "applicant_type", "sme_status"]
  );

  const sproutRecommendation = buildResultItem(
    sproutProgram,
    sproutFitStatus,
    "secondary_conditional",
    sproutFitStatus === "적합" ? "conditional_candidate" : sproutFitStatus === "부분 적합" ? "conditional_candidate" : "reference_candidate",
    sproutFitStatus === "적합"
      ? "기술 상용화·시제품·PoC 맥락에서 SPROUT 경로가 검토 가능합니다."
      : sproutFitStatus === "부분 적합"
        ? "기술 사업화 후보로는 보이지만, 증빙이 더 필요합니다."
        : "SPROUT 경로는 현재 입력만으로는 추가 확인이 필요합니다.",
    [
      sproutTechHits > 0 ? "기술 상용화 / 시제품 / PoC / 파일럿 맥락이 보입니다." : "기술 상용화 신호가 약해 우선 확인이 필요합니다.",
      sproutNeedHits > 0 ? "요청 니즈가 기술 사업화와 맞닿아 있습니다." : "요청 니즈가 기술 사업화와 직접 연결되는지 추가 확인이 필요합니다.",
      sproutStageHits > 0 ? "현재 단계가 개발 / 검증 / 상용화 흐름과 연결됩니다." : "현재 단계는 추가 검토가 필요합니다."
    ],
    [
      fieldStatus("poc_or_testbed_experience") === "confirmed" ? null : "PoC / 파일럿 / 테스트베드 증빙",
      fieldStatus("venture_confirmation_status") === "confirmed" ? null : "벤처 또는 기술 증빙",
      fieldStatus("applicant_type") === "confirmed" ? null : "신청 주체 확인",
      fieldStatus("sme_status") === "confirmed" ? null : "중소기업 확인"
    ].filter(Boolean),
    documentTemplates.filter((item) => item && item.required_for_programs.includes("sprout_invest_up")),
    [
      "documentation_pending",
      "eligibility_unconfirmed",
      "external_verification_pending"
    ],
    ["product_tech_summary", "current_stage", "poc_or_testbed_experience", "venture_confirmation_status", "applicant_type", "sme_status"]
  );

  const scaleRecommendation = buildResultItem(
    scaleProgram,
    scaleFitStatus,
    "future_option",
    "reference_candidate",
    scaleFitStatus === "부분 적합"
      ? "민간투자 기반 스케일업 경로는 향후 후보로 남길 수 있습니다."
      : "민간투자 기반 스케일업 경로는 현재는 참고 선택지입니다.",
    [
      scaleInvestmentHits > 0 ? "투자 / 매칭펀드 / 벤처 신호가 보여 미래 경로로는 검토 가능합니다." : "투자 기반 증빙은 아직 보이지 않습니다.",
      scaleStageHits > 0 ? "성장 / 확장 단계 설명이 있어 미래 옵션으로는 남겨둘 수 있습니다." : "성장 단계 설명은 추가로 확인이 필요합니다."
    ],
    [
      fieldStatus("investment_status") === "confirmed" ? null : "민간투자 증빙",
      fieldStatus("self_funding_or_cost_share") === "confirmed" ? null : "자부담 / 매칭펀드 계획",
      fieldStatus("venture_confirmation_status") === "confirmed" ? null : "벤처 또는 기술 증빙"
    ].filter(Boolean),
    documentTemplates.filter((item) => item && item.required_for_programs.includes("private_investment_based_scale_up")),
    [
      "investment_evidence_missing",
      "cost_share_unclear",
      "eligibility_unconfirmed"
    ],
    ["investment_status", "self_funding_or_cost_share", "venture_confirmation_status", "current_stage"]
  );

  const recommendations = [agrifoodRecommendation, sproutRecommendation, scaleRecommendation];
  const followupQuestions = followupTemplates.filter((item) => item && item.related_fields.some((fieldName) => hasMissingOrUnknown(fieldName))).slice(0, 5);
  const remainingUncertainties = [];
  const uncertaintyMap = [
    {
      field: "applicant_type",
      category: "eligibility",
      description: "신청 주체가 아직 확정되지 않았습니다.",
      affected_programs: ["agrifood_ai_fast_commercialization", "sprout_invest_up", "private_investment_based_scale_up"],
      needed_evidence: "사업자등록증 또는 법인 근거 자료",
      severity: "high"
    },
    {
      field: "sme_status",
      category: "eligibility",
      description: "중소기업 여부가 아직 확정되지 않았습니다.",
      affected_programs: ["agrifood_ai_fast_commercialization", "sprout_invest_up", "private_investment_based_scale_up"],
      needed_evidence: "중소기업 확인서",
      severity: "high"
    },
    {
      field: "government_support_restriction_status",
      category: "compliance",
      description: "정부지원 제한 또는 제외 사유가 아직 확인되지 않았습니다.",
      affected_programs: ["agrifood_ai_fast_commercialization", "sprout_invest_up", "private_investment_based_scale_up"],
      needed_evidence: "제한 없음 확인 자료 또는 사유 설명",
      severity: "high"
    },
    {
      field: "current_stage",
      category: "technical_evidence",
      description: "제품 / 상용화 단계가 아직 명확하지 않습니다.",
      affected_programs: ["agrifood_ai_fast_commercialization", "sprout_invest_up"],
      needed_evidence: "개발, 검증, 파일럿, 상용화 단계 메모",
      severity: "medium"
    },
    {
      field: "poc_or_testbed_experience",
      category: "technical_evidence",
      description: "PoC / 파일럿 / 테스트베드 증빙이 아직 없습니다.",
      affected_programs: ["agrifood_ai_fast_commercialization", "sprout_invest_up"],
      needed_evidence: "PoC, 파일럿, 테스트베드 또는 검증 기록",
      severity: "medium"
    },
    {
      field: "investment_status",
      category: "investment",
      description: "민간투자 증빙이 아직 없습니다.",
      affected_programs: ["private_investment_based_scale_up"],
      needed_evidence: "투자계약, 텀시트, 투자확인 자료",
      severity: "medium"
    },
    {
      field: "self_funding_or_cost_share",
      category: "funding",
      description: "자부담 또는 매칭펀드 준비가 아직 불명확합니다.",
      affected_programs: ["private_investment_based_scale_up"],
      needed_evidence: "예산 또는 자부담 계획",
      severity: "medium"
    },
    {
      field: "schedule_readiness",
      category: "schedule",
      description: "이번 회차 신청 가능 여부가 아직 확인되지 않았습니다.",
      affected_programs: ["agrifood_ai_fast_commercialization", "sprout_invest_up", "private_investment_based_scale_up"],
      needed_evidence: "신청 일정 또는 제출 준비 메모",
      severity: "low"
    }
  ];
  for (const item of uncertaintyMap) {
    if (!hasMissingOrUnknown(item.field)) continue;
    remainingUncertainties.push({
      uncertainty_id: item.field,
      category: item.category,
      description: item.description,
      affected_programs: item.affected_programs,
      needed_evidence: item.needed_evidence,
      severity: item.severity,
      can_proceed_with_demo: true
    });
  }

  const nextActions = [
    {
      action_id: "review_saved_input",
      action: "확인된 입력값을 다시 검토",
      owner: "user",
      priority: "high",
      related_programs: ["agrifood_ai_fast_commercialization", "sprout_invest_up", "private_investment_based_scale_up"],
      depends_on: ["standard_company_input.json"],
      expected_output: "화면의 입력값이 계속 확정 원본으로 유지됩니다.",
      demo_safe_wording: "저장된 입력을 다시 확인해 주세요."
    },
    {
      action_id: "attach_missing_evidence",
      action: "부족한 증빙 문서 보완",
      owner: "user",
      priority: "high",
      related_programs: ["agrifood_ai_fast_commercialization", "sprout_invest_up", "private_investment_based_scale_up"],
      depends_on: followupQuestions.slice(0, 5).map((item) => item.question_id),
      expected_output: "요건 핵심 항목이 더 분명해집니다.",
      demo_safe_wording: "핵심 확인 항목의 증빙을 보완해 주세요."
    },
    {
      action_id: "rerun_matcher",
      action: "입력 저장 후 매칭 재실행",
      owner: "user",
      priority: "medium",
      related_programs: ["agrifood_ai_fast_commercialization", "sprout_invest_up", "private_investment_based_scale_up"],
      depends_on: ["standard_company_input.json"],
      expected_output: "갱신된 추천 결과가 result_view_model.json에 저장됩니다.",
      demo_safe_wording: "저장 후 매칭을 다시 실행해 주세요."
    }
  ];

  const displayWarnings = [
    "최소 규칙 기반 매칭 초안입니다. 추천을 바로 믿지 말고 저장된 입력을 다시 검토해 주세요.",
    "개인정보 필터는 아직 실행되지 않았습니다.",
    "이 결과는 최종 자격판정이 아닙니다."
  ];
  if (blankCount > 0) {
    displayWarnings.push("일부 요건 핵심 항목이 아직 비어 있거나 미확인 상태입니다.");
  }

  const evidenceTrace = [
    {
      source_type: "standard_company_input",
      source_path: sourceStandardCompanyInputPath,
      field_or_section: "company_summary",
      excerpt: sanitizeDraftText([
        fieldValue("company_name_or_alias"),
        fieldValue("region"),
        fieldValue("industry_field"),
        fieldValue("product_tech_summary")
      ].join(" "), 260)
    },
    {
      source_type: "standard_company_input",
      source_path: sourceStandardCompanyInputPath,
      field_or_section: "top_needs_or_pain_points",
      excerpt: sanitizeDraftText(fieldValue("top_needs_or_pain_points"), 220)
    },
    {
      source_type: "official_card_catalog",
      source_path: sourceCriteriaPath,
      field_or_section: "core_program_only",
      excerpt: "runtime matcher uses the core_program_only sample criteria set"
    }
  ];

  return {
    schema_version: "v1",
    case_id: caseId,
    result_state: "PASS1",
    generated_from: {
      source_standard_company_input_path: sourceStandardCompanyInputPath,
      structured_criteria_sample_path: sourceCriteriaPath,
      matcher_scope: "core_program_only",
      candidate_source_set: "core_program_only",
      generation_mode: "runtime_matcher",
      is_runtime_matcher_output: true,
      is_privacy_filter_output: false,
      is_final_eligibility_decision: false,
      privacy_filter_status: "not_run"
    },
    company_summary: companySummary,
    recommendations,
    followup_questions: followupQuestions,
    remaining_uncertainties: remainingUncertainties,
    missing_documents: documentTemplates,
    next_actions: nextActions,
    evidence_trace: evidenceTrace,
    display_warnings: displayWarnings,
    metadata: {
      generation_mode: "runtime_matcher",
      is_runtime_matcher_output: true,
      is_privacy_filter_output: false,
      is_final_eligibility_decision: false,
      matcher_scope: "core_program_only",
      candidate_source_set: programList.map((program) => program.program_id),
      privacy_filter_status: "not_run",
      source_standard_company_input_path: sourceStandardCompanyInputPath,
      structured_criteria_sample_path: sourceCriteriaPath
    }
  };
}

async function handleRunMatcher(req, res) {
  try {
    const body = await readRequestBody(req);
    const payload = JSON.parse(body || "{}");
    const rawCaseId = String(payload.case_id || "").trim();

    if (!rawCaseId) {
      return json(res, 400, {
        ok: false,
        case_id: null,
        error: "case_id is required before running the matcher.",
        warnings: ["Save the populated input first, then run the matcher."],
        missing_files: []
      });
    }

    if (!isSafeResultCaseId(rawCaseId)) {
      return json(res, 400, {
        ok: false,
        case_id: rawCaseId,
        error: "Invalid case_id.",
        warnings: ["The current case_id is not safe to use for runtime matching."],
        missing_files: []
      });
    }

    const caseId = rawCaseId;
    const standardPath = path.join(COMPANY_INPUTS, `${caseId}_standard_company_input.json`);
    const resultDir = path.join(RESULTS, caseId);
    const resultPath = path.join(resultDir, "result_view_model.json");
    const manifestPath = path.join(SESSIONS, `${caseId}_session_manifest.json`);

    if (!(await pathExists(standardPath))) {
      return json(res, 404, {
        ok: false,
        case_id: caseId,
        error: `No saved input found for case_id=${caseId}.`,
        warnings: ["Save the populated input before running the matcher."],
        missing_files: [toRepoPath(standardPath)]
      });
    }

    if (!(await pathExists(TOP2_RUNTIME_MATCHER_CATALOG_PATH)) && !(await pathExists(MATCHER_CATALOG_PATH))) {
      return json(res, 500, {
        ok: false,
        case_id: caseId,
        error: "No runtime matcher catalog or fallback criteria sample was found.",
        warnings: ["The top-2 runtime matcher catalog or the fallback structured criteria sample is required for runtime matching."],
        missing_files: [toRepoPath(TOP2_RUNTIME_MATCHER_CATALOG_PATH), toRepoPath(MATCHER_CATALOG_PATH)]
      });
    }

    const standardCompanyInput = JSON.parse(await fs.readFile(standardPath, "utf8"));
    const criteria = await loadMatcherProgramCatalog();
    const criteriaPath = criteria?.catalog_file_path || MATCHER_CATALOG_PATH;
    const resultViewModel = buildRuntimeMatcherResult(caseId, standardCompanyInput, standardPath, criteria, criteriaPath);

    await fs.mkdir(resultDir, { recursive: true });
    await fs.mkdir(SESSIONS, { recursive: true });
    await fs.writeFile(resultPath, JSON.stringify(resultViewModel, null, 2), "utf8");

    const now = new Date().toISOString();
    const manifest = createManifestBase(caseId, now, "MATCHER_RESULT_READY", {
      standard_company_input_path: toRepoPath(standardPath),
      result_view_model_path: toRepoPath(resultPath)
    });
    await writeManifest(manifestPath, manifest);

    json(res, 200, {
      ok: true,
      case_id: caseId,
      source_type: RUNTIME_MATCHER_SOURCE_TYPE,
      result_view_model: resultViewModel,
      result_view_model_path: toRepoPath(resultPath),
      session_manifest_path: toRepoPath(manifestPath),
      manifest,
      warnings: resultViewModel.display_warnings || [],
      missing_files: []
    });
  } catch (error) {
    json(res, 500, {
      ok: false,
      error: error.message,
      case_id: null,
      result_view_model: null,
      result_view_model_path: null,
      warnings: [error.message],
      missing_files: []
    });
  }
}
// [추가된 핵심 기능] 해시 맵(장부)을 관리하는 도우미 함수들
const HASH_MAP_PATH = path.join(RUNTIME, "hash_map.json");

async function getHashMap() {
    try {
        const data = await fs.readFile(HASH_MAP_PATH, "utf8");
        return JSON.parse(data);
    } catch {
        return {}; // 파일이 없으면 빈 장부로 시작
    }
}

async function saveHashMap(map) {
    await fs.writeFile(HASH_MAP_PATH, JSON.stringify(map, null, 2), "utf8");
}

async function handleGenerateV2SafeInput(req, res) {
  const now = new Date().toISOString();
  let caseId = null;
  let safeInputPath = null;

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

    const candidateValues = payload.candidate_values || payload.fields || {};
    const localExtractedText = String(payload.local_extracted_text || payload.extracted_text || "");
    caseId = slugify(payload.case_id || candidateValues.company_name_or_alias || `v2_safe_input_${now}`);

    const safeInput = normalizeToV2SafeInput(candidateValues, {
      local_extracted_text: localExtractedText,
      synthetic_fixture: Boolean(payload.synthetic_fixture),
      schema_version: payload.schema_version || "v2_safe_input_draft",
      user_confirmed_fields: payload.user_confirmed_fields || payload.confirmed_fields || []
    });

    await fs.mkdir(V2_SAFE_INPUT_DIR, { recursive: true });
    safeInputPath = path.join(V2_SAFE_INPUT_DIR, `${caseId}_v2_safe_input.json`);
    await fs.writeFile(safeInputPath, JSON.stringify(safeInput, null, 2), "utf8");

    return json(res, 200, {
      ok: true,
      case_id: caseId,
      source_mode: localExtractedText ? "local_extracted_text" : "candidate_values",
      v2_safe_input_path: toRepoPath(safeInputPath),
      safe_input: safeInput,
      populated_fields: V2_SAFE_INPUT_VALUE_FIELDS.filter((field) => hasMeaningfulValue(safeInput[field])),
      missing_or_unconfirmed_fields: safeInput.fields_needing_confirmation,
      message: "V2 safe input JSON was generated locally. No AI matcher was invoked."
    });
  } catch (error) {
    return json(res, 500, {
      ok: false,
      case_id: caseId,
      v2_safe_input_path: safeInputPath ? toRepoPath(safeInputPath) : null,
      error: error.message
    });
  }
}

function normalizeV2RetrievalText(value, maxLength = 500) {
  return sanitizeDraftText(value, maxLength).toLowerCase();
}

function isV2OperatorOrAgencyApplicantType(applicantType) {
  const text = normalizeV2RetrievalText(applicantType, 120);
  if (!text) return false;
  return [
    "operator",
    "agency",
    "institution",
    "consortium",
    "consortium lead",
    "lead",
    "주관기관",
    "운영기관",
    "운영사",
    "기관",
    "협회",
    "대학",
    "연구기관",
    "지자체",
    "컨소시엄"
  ].some((keyword) => text.includes(normalizeV2RetrievalText(keyword, 40)));
}

function isInsideDirectory(childPath, parentDir) {
  const relative = path.relative(path.resolve(parentDir), path.resolve(childPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function loadV2ProgramIndex() {
  if (cachedV2ProgramIndex && cachedV2ProgramIndexPath === V2_PROGRAM_INDEX_PATH) {
    return cachedV2ProgramIndex;
  }

  const raw = await fs.readFile(V2_PROGRAM_INDEX_PATH, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("program_index.json must contain a top-level array.");
  }

  cachedV2ProgramIndex = parsed;
  cachedV2ProgramIndexPath = V2_PROGRAM_INDEX_PATH;
  return cachedV2ProgramIndex;
}

function buildV2RetrievalProfile(safeInput) {
  const topNeeds = normalizeV2ArrayField(safeInput?.top_needs_or_pain_points).map((item) => normalizeV2RetrievalText(item, 80));
  const targetCountries = normalizeV2ArrayField(safeInput?.target_country_or_market).map((item) => normalizeV2RetrievalText(item, 80));
  const productSummary = normalizeV2RetrievalText(safeInput?.product_tech_summary, 600);
  const industryField = normalizeV2RetrievalText(safeInput?.industry_field, 80);
  const stage = normalizeV2RetrievalText(safeInput?.current_stage, 80);
  const exportIntent = normalizeV2RetrievalText(safeInput?.export_intent, 80);
  const greenFlag = normalizeV2RetrievalText(safeInput?.green_bio_or_smart_agri_flag, 40);

  const hasStartupSignal = [
    stage,
    normalizeV2RetrievalText(safeInput?.applicant_type, 80),
    ...topNeeds
  ].some((text) => /seed|startup|start-up|pre-?startup|예비창업|벤처육성|액셀러레이터|창업박람회/.test(text));

  const hasSmartAgriSignal = [industryField, productSummary, greenFlag].some((text) => /스마트농업|스마트팜|그린바이오|greenhouse|sensor|controller|dashboard|현장검증|실증/.test(text));
  const hasChannelSignal = [productSummary, ...topNeeds].some((text) => /판로|유통|wholesale|distribution|channel|market|sales|브랜드|brand|sorting|storage/.test(text));
  const hasExportSignal = exportIntent === "active" || exportIntent === "planned" || targetCountries.some((country) => country && country !== "domestic" && country !== "국내");

  const preferredFamilies = new Set();
  if (hasStartupSignal) preferredFamilies.add("벤처창업");
  if (hasSmartAgriSignal) {
    preferredFamilies.add("스마트농업");
    preferredFamilies.add("그린바이오");
  }
  if (hasExportSignal) preferredFamilies.add("해외 진출");
  if (hasChannelSignal) preferredFamilies.add("벤처창업");

  return {
    hasStartupSignal,
    hasSmartAgriSignal,
    hasChannelSignal,
    hasExportSignal,
    preferredFamilies: [...preferredFamilies]
  };
}

function buildV2ProgramHaystack(program) {
  const pieces = [
    program?.program_id,
    program?.program_name,
    program?.target_type,
    program?.program_family,
    program?.short_summary,
    Array.isArray(program?.tags) ? program.tags.join(" ") : "",
    Array.isArray(program?.required_company_fields_candidate) ? program.required_company_fields_candidate.join(" ") : ""
  ];
  return normalizeV2RetrievalText(pieces.filter(Boolean).join(" "), 1200);
}

function buildV2SignalSpecs(safeInput) {
  const topNeeds = normalizeV2ArrayField(safeInput?.top_needs_or_pain_points).map((item) => normalizeV2RetrievalText(item, 80));
  const targetCountries = normalizeV2ArrayField(safeInput?.target_country_or_market).map((item) => normalizeV2RetrievalText(item, 80));
  const certificationNeed = normalizeV2RetrievalText(safeInput?.certification_or_test_need, 80);
  const productSummary = normalizeV2RetrievalText(safeInput?.product_tech_summary, 600);
  const industryField = normalizeV2RetrievalText(safeInput?.industry_field, 80);
  const stage = normalizeV2RetrievalText(safeInput?.current_stage, 80);
  const transferStatus = normalizeV2RetrievalText(safeInput?.technology_transfer_status, 80);
  const salesStatus = normalizeV2RetrievalText(safeInput?.sales_record_status, 80);
  const exportIntent = normalizeV2RetrievalText(safeInput?.export_intent, 80);
  const greenFlag = normalizeV2RetrievalText(safeInput?.green_bio_or_smart_agri_flag, 40);
  const applicantType = normalizeV2RetrievalText(safeInput?.applicant_type, 80);
  const region = normalizeV2RetrievalText(safeInput?.region, 80);

  const specs = [];
  const pushSpec = (field, terms, weight, signalKind, reasonLabel) => {
    const filtered = [...new Set((terms || []).map((term) => normalizeV2RetrievalText(term, 120)).filter(Boolean))];
    if (!filtered.length) return;
    specs.push({ field, weight, terms: filtered, signal_kind: signalKind, reasonLabel });
  };

  if (industryField) {
    if (industryField.includes("스마트농업")) {
      pushSpec("industry_field", ["스마트농업", "스마트팜", "실증"], 4, "strong", "industry_field");
    } else if (industryField.includes("그린바이오")) {
      pushSpec("industry_field", ["그린바이오", "바이오"], 4, "strong", "industry_field");
    } else if (industryField.includes("시험") || industryField.includes("분석")) {
      pushSpec("industry_field", ["시험", "분석", "검정", "인증", "실증"], 3, "strong", "industry_field");
    } else if (industryField.includes("해외진출")) {
      pushSpec("industry_field", ["해외진출", "수출", "해외", "글로벌"], 3, "strong", "industry_field");
    } else if (industryField.includes("저탄소")) {
      pushSpec("industry_field", ["저탄소", "탄소", "친환경"], 3, "strong", "industry_field");
    } else if (industryField.includes("농식품")) {
      pushSpec("industry_field", ["농식품", "농산업", "식품"], 1, "weak", "industry_field");
    }
  }

  if (productSummary) {
    if (/(greenhouse|sensor|controller|dashboard|smart\s*farm|smartfarm|environment control)/i.test(productSummary)) {
      pushSpec("product_tech_summary", ["스마트농업", "스마트팜", "실증", "현장검증"], 4, "strong", "product_tech_summary");
    }
    if (/(distribution|wholesale|channel|market|sales|brand|sorting|storage)/i.test(productSummary)) {
      pushSpec("product_tech_summary", ["판로", "판로지원", "유통"], 4, "strong", "product_tech_summary");
    }
    if (/(export|international|overseas|global|japan|vietnam)/i.test(productSummary)) {
      pushSpec("product_tech_summary", ["해외진출", "수출", "글로벌", "해외"], 4, "strong", "product_tech_summary");
    }
    if (/(pilot|demo|testbed|trial|validation)/i.test(productSummary)) {
      pushSpec("product_tech_summary", ["실증", "검정", "시험", "인증", "실증단지"], 4, "strong", "product_tech_summary");
    }
    if (/(transfer|licen|technology transfer)/i.test(productSummary)) {
      pushSpec("product_tech_summary", ["기술이전", "협업", "수요기업"], 3, "strong", "product_tech_summary");
    }
    if (/(food|agrifood|processed food)/i.test(productSummary)) {
      pushSpec("product_tech_summary", ["농식품", "식품"], 1, "weak", "product_tech_summary");
    }
  }

  if (stage) {
    if (/(seed|startup|start-up|pre-?startup|pre창업|예비창업)/i.test(stage)) {
      pushSpec("current_stage", ["예비창업자", "벤처육성", "액셀러레이터", "창업박람회"], 4, "strong", "current_stage");
    } else if (/(growth|scale|scaleup|scaling|성장)/i.test(stage)) {
      pushSpec("current_stage", ["스케일업"], 1, "weak", "current_stage");
    }
  }

  if (topNeeds.length) {
    const needs = {
      channel: false,
      export: false,
      validation: false,
      transfer: false,
      startup: false,
      mentoring: false,
      investment: false,
      business: false,
      founding: false
    };
    for (const need of topNeeds) {
      if (!need) continue;
      if (need.includes("판로") || need.includes("유통")) needs.channel = true;
      if (need.includes("해외진출") || need.includes("수출") || need.includes("글로벌")) needs.export = true;
      if (need.includes("실증")) needs.validation = true;
      if (need.includes("검정") || need.includes("성능검정") || need.includes("시험") || need.includes("인증")) needs.validation = true;
      if (need.includes("기술이전")) needs.transfer = true;
      if (need.includes("예비창업자") || need.includes("벤처육성") || need.includes("액셀러레이터")) needs.startup = true;
      if (need.includes("교육") || need.includes("멘토링")) needs.mentoring = true;
      if (need.includes("투자")) needs.investment = true;
      if (need.includes("사업화")) needs.business = true;
      if (need.includes("창업")) needs.founding = true;
    }
    if (needs.channel) pushSpec("top_needs_or_pain_points", ["판로", "판로지원", "유통"], 4, "strong", "top_needs_or_pain_points");
    if (needs.export) pushSpec("top_needs_or_pain_points", ["해외진출", "수출", "글로벌"], 4, "strong", "top_needs_or_pain_points");
    if (needs.validation) pushSpec("top_needs_or_pain_points", ["실증", "실증단지", "현장검증", "테스트베드", "검정", "성능검정", "시험", "인증"], 4, "strong", "top_needs_or_pain_points");
    if (needs.transfer) pushSpec("top_needs_or_pain_points", ["기술이전", "협업", "수요기업", "기술평가"], 3, "strong", "top_needs_or_pain_points");
    if (needs.startup) pushSpec("top_needs_or_pain_points", ["예비창업자", "벤처육성", "액셀러레이터", "창업박람회"], 4, "strong", "top_needs_or_pain_points");
    if (needs.mentoring) pushSpec("top_needs_or_pain_points", ["교육", "멘토링"], 1, "weak", "top_needs_or_pain_points");
    if (needs.investment) pushSpec("top_needs_or_pain_points", ["투자", "IR"], 1, "weak", "top_needs_or_pain_points");
    if (needs.business) pushSpec("top_needs_or_pain_points", ["사업화"], 1, "weak", "top_needs_or_pain_points");
    if (needs.founding) pushSpec("top_needs_or_pain_points", ["창업기업", "창업"], 1, "weak", "top_needs_or_pain_points");
  }

  if (greenFlag && (greenFlag === "yes" || greenFlag === "maybe")) {
    pushSpec("green_bio_or_smart_agri_flag", ["스마트농업", "스마트팜", "그린바이오"], 4, "strong", "green_bio_or_smart_agri_flag");
  }

  if (transferStatus && !["none", "not_applicable", "unknown"].includes(transferStatus)) {
    pushSpec("technology_transfer_status", ["기술이전", "협업", "수요기업", "기술평가"], 3, "strong", "technology_transfer_status");
  }

  if (certificationNeed && !["none", "unknown"].includes(certificationNeed)) {
    pushSpec("certification_or_test_need", ["인증", "검정", "성능검정", "시험", "실증"], 4, "strong", "certification_or_test_need");
  }

  if (salesStatus && !["none", "unknown"].includes(salesStatus)) {
    pushSpec("sales_record_status", ["판로", "유통"], 1, "weak", "sales_record_status");
  }

  if (exportIntent === "active" || exportIntent === "planned") {
    pushSpec("export_intent", ["해외진출", "수출", "글로벌"], 4, "strong", "export_intent");
  } else if (exportIntent === "exploring") {
    pushSpec("export_intent", ["해외진출"], 1, "weak", "export_intent");
  }

  if (targetCountries.length) {
    const nonDomestic = targetCountries.filter((country) => country && country !== "domestic" && country !== "국내");
    if (nonDomestic.length) {
      pushSpec("target_country_or_market", [...nonDomestic, "해외진출", "수출", "글로벌"], 3, "strong", "target_country_or_market");
    }
  }

  if (applicantType && ["창업기업", "중소기업", "법인", "기업"].includes(applicantType)) {
    pushSpec("applicant_type", [applicantType], 1, "weak", "applicant_type");
  }

  if (region) {
    pushSpec("region", [region], 0, "weak", "region");
  }

  return { specs };
}

function scoreV2ProgramCandidate(safeInput, programIndexItem) {
  const programText = buildV2ProgramHaystack(programIndexItem);
  const programTarget = String(programIndexItem?.target_type || "").trim();
  const applicantType = String(safeInput?.applicant_type || "");
  const region = String(safeInput?.region || "");
  const estDate = safeInput?.establishment_date;
  const techTransfer = String(safeInput?.technology_transfer_status || "");
  const investment = String(safeInput?.investment_status || "");
  const youthFounder = String(safeInput?.youth_founder_condition_status || "");

  let scoreReasons = [];
  let cautionFlags = [];

  // --- [1단계] 하드 필터 (HF-1 ~ HF-9) ---
  let hfPass = true;
  let failedHF = null;
  let hf7Failed = false;

  // 💡 신규 HF-8: 농식품 가치사슬 도메인 엄격 격리 규칙
  const companyValueChain = String(safeInput?.agrifood_value_chain || "").trim();
  if (/(스마트팜 수출 활성화|해외 온실 구축|기자재 실증|작물 재배 지원)/.test(programIndexItem?.program_name || programText)) {
    if (companyValueChain === "2차 가공") {
      hfPass = false; failedHF = "HF-8(도메인 불일치: 1차 생산 공고에 2차 가공 기업 지원 불가)";
    }
  }

  // 💡 신규 HF-9: 공고문 "자격 제한" 기반 체급 하드 필터 (예: 민간투자 기반 스케일업)
  const invAmount = Number(safeInput?.total_investment_amount) || 0;
  if (programIndexItem?.program_id === "private_investment_based_scale_up" && invAmount < 500000000) {
      hfPass = false; failedHF = "HF-9(체급 미달: 스케일업 사업의 누적 투자 5억 원 최소 조건 미충족)";
  }

  // HF-1. 신청자 유형 (비기업 대상 공고 필터링)
  if (/(농업인|농가|농업경영체|종자업자|묘목업체|학교)/.test(programText) && !/(기업|startup|sme)/i.test(programText)) {
    if (!/(농업인|농가|농업경영체)/.test(applicantType)) {
      hfPass = false; failedHF = "HF-1(신청자 유형 불일치: 비기업 대상 공고)";
    }
  }

  // HF-2. 업력 요건
  if (estDate && programText.includes("년 이내")) {
    const yearsMatch = programText.match(/(\d+)년\s*이내/);
    if (yearsMatch) {
      const limitYears = parseInt(yearsMatch[1], 10);
      const estYear = parseInt(estDate.split("-")[0], 10);
      const currentYear = new Date().getFullYear();
      if (currentYear - estYear > limitYears) {
        hfPass = false; failedHF = `HF-2(업력 ${limitYears}년 초과)`;
      }
    }
  }

  // HF-3. 연령 제한
  if (/(청년|39세 이하|40세 미만)/.test(programText) && youthFounder !== "yes") {
     hfPass = false; failedHF = "HF-3(연령 조건 미충족)";
  }

  // HF-4. 지역 제한 및 💡 [최종 처방] 지리적 락인(Lock-in) 하드 필터 알고리즘 구현
  const regions = ["서울", "부산", "대구", "인천", "광주", "대전", "울산", "세종", "경기", "강원", "충북", "충남", "전북", "전남", "경북", "경남", "제주"];
  const targetAudienceText = String(programIndexItem?.target_audience || "");
  const progNameText = String(programIndexItem?.program_name || "");
  const companyRegion = String(region || safeInput?.region || "");

  // 특정 한정 지역(전북/익산 등) 공고문 조건 스캔
  if (targetAudienceText.includes("전북") || targetAudienceText.includes("익산") || progNameText.includes("전북") || progNameText.includes("익산")) {
    if (companyRegion.includes("전북") || companyRegion.includes("익산")) {
      // 🎯 해당 한정 지역 사업에 부합하는 관내 기업인 경우 메가 보너스 점수 부여 (체급 점수 섀도잉 방어)
      ss4 += 40; // 처방전 규격 완벽 반영: SS_Region 우대 점수 상향 조정
      cautionFlags.push("지역 락인 우대 — 전북/익산 관내 기업 특화 보너스 점수(+40점)가 적용되었습니다.");
    } else {
      // 🎯 전북/익산 한정 사업인데 타지역 기업인 경우 하드 필터(HF) 즉시 탈락 처리
      hfPass = false; 
      failedHF = "HF-4(지리적 락인 탈락: 전북/익산 관내 제한 공고에 타지역 기업 지원 불가)";
    }
  }

  // 범용 지역 제한 키워드 보수적 스캔 규칙 유지
  for (const reg of regions) {
    if (programText.includes(`${reg} 소재`) && !companyRegion.includes(reg)) {
      hfPass = false; 
      failedHF = `HF-4(지역 제한: ${reg} 미포함)`;
    }
  }

  // --- [2단계] 소프트 스코어 (SS-1 ~ SS-5 아키텍처 확장) ---
  let ss1 = 0, ss2 = 0, ss3 = 0, ss4_base = 0, ss5 = 0;
  const combinedCompanyText = [
    safeInput?.industry_field, safeInput?.product_tech_summary, 
    safeInput?.top_needs_or_pain_points?.join(" "), safeInput?.current_stage,
    safeInput?.target_country_or_market?.join(" ")
  ].join(" ").toLowerCase();

  // SS-1. 핵심 기술 및 산업 분야 적합도 (40점 만점)
  const isTechMatch = /(ai|인공지능|로봇|데이터|플랫폼|스마트|바이오|iot|비전|탐지)/i.test(combinedCompanyText) && /(ai|로봇|스마트|데이터|혁신|첨단|테크)/i.test(programText);
  const isDomainMatch = /(농업|농식품|식품|축산|푸드테크)/i.test(combinedCompanyText) && /(농업|농식품|식품|축산|푸드테크)/i.test(programText);
  if (isTechMatch && isDomainMatch) ss1 = 40;
  else if (isTechMatch || isDomainMatch) ss1 = 20; 

  // SS-2. 단기 사업화 목표 직결성 (40점 만점)
  const needsValidation = /(실증|검증|poc|테스트)/i.test(combinedCompanyText) && /(실증|검증|poc|테스트)/i.test(programText);
  const needsExport = /(해외|수출|글로벌)/i.test(combinedCompanyText) && /(해외|수출|글로벌)/i.test(programText);
  const needsSales = /(판로|유통|전시|박람회|마케팅|부스)/i.test(combinedCompanyText) && /(판로|유통|전시|박람회|마케팅)/i.test(programText);
  const needsCommercial = /(상용화|사업화|도입|보급)/i.test(combinedCompanyText) && /(상용화|사업화|도입|보급)/i.test(programText);
  
  let matchCount = (needsValidation ? 1 : 0) + (needsExport ? 1 : 0) + (needsSales ? 1 : 0) + (needsCommercial ? 1 : 0);
  if (matchCount >= 2) ss2 = 40;
  else if (matchCount === 1) ss2 = 20; 

  // SS-3. 기존 스케일업 단계 적합성 (20점 만점)
  const isScaleUp = /(시리즈|series|투자 유치|성장|스케일업)/i.test(combinedCompanyText) || /(series_a_plus)/i.test(investment);
  const programSupportsScaleUp = /(스케일업|도약|성장|대규모)/i.test(programText);
  if (isScaleUp && programSupportsScaleUp) ss3 = 20;
  else if (!isScaleUp && !programSupportsScaleUp) ss3 = 20; 
  else ss3 = 10;

  // 💡 SS-4. 투자 체급(Stage) 및 BM(공장 유무) 기반 가중치 스코어 보너스 맵
  if (invAmount < 500000000) {
    if (/(액셀러레이팅|창업콘테스트|초기)/.test(programText)) ss4_base += 10;
    if (/(스케일업|공정고도화)/.test(programText)) ss4_base -= 15;
  } else if (invAmount >= 500000000 && invAmount < 1000000000) {
    if (/(공정고도화|글로벌 진출|스케일업)/.test(programText)) ss4_base += 10;
    if (/(초기 창업|예비창업|기초 교육)/.test(programText)) ss4_base -= 10;
  } else if (invAmount >= 1000000000) {
    if (/(민간투자기반 스케일업|대규모 자금지원)/.test(programText)) ss4_base += 20;
    if (/(초기|콘테스트|교육)/.test(programText)) ss4_base -= 30;
  }

  // 💡 마스터 DB의 공장 필수 선언(requires_manufacturing_facility) 및 예외 차단
  if (programIndexItem?.requires_manufacturing_facility === true && hasFactory === "no") {
    ss4_base -= 30; // SS_FactoryPenalty = -30 points
    cautionFlags.push("외주 위탁 생산 기업이 설비 구축 필수 사업에 지원하여 서류 심사 감점 및 탈락 리스크가 높습니다.");
  } else if (hasFactory === "no" && /(설비구축|공정고도화)/.test(programText)) {
    ss4_base -= 20;
    cautionFlags.push("외주 위탁 생산 기업이 설비구축 사업에 지원할 경우 정성 평가 감점 요인이 될 수 있습니다.");
  }

  // 지역 메가 보너스 합산
  ss4 += ss4_base;

  // 💡 SS-5. Two-Step Token Matching 기반 정부 수상 이력 가점 엔진
  const AWARD_TOKEN_MAP = {
    "CONTEST_AGRI": /농식품\s*창업\s*콘테스트|창업\s*콘테스트/i,
    "MINISTER_AWARD": /장관상|최우수상|우수상/i,
    "HACCP_CERT": /HACCP|해썹/i
  };

  const companyAwardsText = String(safeInput?.government_awards_certificates || "").trim();
  const preferredAwards = programIndexItem?.preferred_awards || [];

  if (preferredAwards.length > 0 && companyAwardsText) {
    let hasAwardMatch = false;
    for (let preferredToken of preferredAwards) {
      if (AWARD_TOKEN_MAP[preferredToken] && AWARD_TOKEN_MAP[preferredToken].test(companyAwardsText)) {
        hasAwardMatch = true;
        break;
      }
    }
    if (hasAwardMatch) {
      ss5 += 25; // SS_AwardBonus = +25 points
      cautionFlags.push("우대 요건 부합 — 정부 주관 포상 및 인증 이력 가점(25점) 적용 대상입니다.");
    }
  }

  // --- [3단계] 예외 처리 및 증빙 확인 규칙 ---
  if (hf7Failed && ss2 === 40) {
    hf7Failed = false; 
    cautionFlags.push("조건부 매칭 — 컨소시엄 구성 전략 변경 제안 필요");
  } else if (hf7Failed) {
    hfPass = false; failedHF = "HF-7(컨소시엄 구성 요건 불일치)";
  }

  if (ss1 === 20 && ss2 === 40) {
    cautionFlags.push("산업 분야 경계 애매 — 담당자 최종 확인 권장");
  }

  let isActionRequired = false;
  const hasOverseasDoc = String(safeInput?.has_overseas_partner_or_loi || "").trim();
  
  if (/(수출계약서|업무협약서|LoI|실증의향서|수출논의 진행)/.test(programText)) {
    if (hasOverseasDoc === "no") {
      ss2 = Math.max(0, ss2 - 20); 
      isActionRequired = true;
      cautionFlags.push("필수 제출 서류(수출계약서/MOU/LoI 등)의 객체적 증빙 보완 필요");
    }
  }

  // --- [4단계] 최종 매칭 판단 및 임계값 (Threshold) 적용 ---
  let totalScore = ss1 + ss2 + ss3 + ss4 + ss5;
  if (!hfPass) totalScore = 0;

  let recommendationLane = "excluded";
  let finalFitStatus = "적합";

  if (programTarget === "reference_only") {
    recommendationLane = "reference";
  } else if (hfPass && totalScore >= 70) {
    recommendationLane = "candidate";
    if (isActionRequired) {
      finalFitStatus = "조건부 매칭"; // 3단계 실무 분류 패스 이식
    } else {
      finalFitStatus = "완전 매칭";
    }
  } else if (hfPass && totalScore >= 40) {
    recommendationLane = "reference";
    finalFitStatus = "참고용 매칭";
  }

  if (!hfPass) {
    scoreReasons.push(`[탈락] 하드 필터 미충족: ${failedHF}`);
  } else {
    scoreReasons.push(`[통과] ${finalFitStatus} 상태 (합계 ${totalScore}점 - SS1:${ss1}, SS2:${ss2}, SS3:${ss3})`);
  }

  return {
    score: totalScore,
    score_reasons: scoreReasons,
    caution_flags: cautionFlags,
    matched_signals: [{ field: "total_score", bonus: totalScore, signal_kind: "calculated" }],
    recommendation_lane: recommendationLane,
    fit_status: finalFitStatus // AI 및 프론트엔드 전송용 프로퍼티 안착
  };
}

function buildV2MissingOrWeakInputSignals(safeInput) {
  const specs = [
    { field: "company_name_or_alias", severity: "high", message: "회사명 또는 별칭이 비어 있습니다." },
    { field: "region", severity: "medium", message: "지역 정보가 비어 있습니다." },
    { field: "industry_field", severity: "high", message: "업종/분야가 비어 있습니다." },
    { field: "product_tech_summary", severity: "high", message: "제품/기술 요약이 비어 있습니다." },
    { field: "current_stage", severity: "medium", message: "현재 단계가 비어 있습니다." },
    { field: "top_needs_or_pain_points", severity: "high", message: "지원 필요 사항이 비어 있습니다." },
    { field: "applicant_type", severity: "medium", message: "신청자 유형이 비어 있습니다." },
    { field: "green_bio_or_smart_agri_flag", severity: "medium", message: "그린바이오/스마트농업 여부가 비어 있습니다." },
    { field: "technology_transfer_status", severity: "medium", message: "기술이전 상태가 비어 있습니다." },
    { field: "certification_or_test_need", severity: "medium", message: "인증/검정/실증 필요 여부가 비어 있습니다." },
    { field: "sales_record_status", severity: "medium", message: "판로/매출 관련 상태가 비어 있습니다." },
    { field: "export_intent", severity: "medium", message: "해외진출 의도가 비어 있습니다." },
    { field: "target_country_or_market", severity: "medium", message: "대상 국가/시장 정보가 비어 있습니다." },
    { field: "business_registration_status", severity: "low", message: "사업자 등록 상태가 비어 있습니다." },
    { field: "venture_confirmation_status", severity: "low", message: "벤처 확인 상태가 비어 있습니다." },
    { field: "investment_status", severity: "low", message: "투자 상태가 비어 있습니다." },
    { field: "self_funding_or_cost_share_status", severity: "low", message: "자부담/매칭 상태가 비어 있습니다." }
  ];

  return specs
    .filter(({ field }) => !hasMeaningfulValue(safeInput?.[field]))
    .map(({ field, severity, message }) => ({
      field,
      severity,
      message
    }));
}

function retrieveV2CandidatePrograms(safeInput, programIndexOrOptions) {
  const indexItems = Array.isArray(programIndexOrOptions)
    ? programIndexOrOptions
    : Array.isArray(programIndexOrOptions?.program_index)
      ? programIndexOrOptions.program_index
      : [];
  const allScored = indexItems.map((program) => {
    const scored = scoreV2ProgramCandidate(safeInput, program);
    return {
      program_id: program?.program_id || "",
      program_name: program?.program_name || "",
      markdown_path: program?.markdown_path || null,
      source_page_hint: program?.source_page_hint ?? null,
      target_type: program?.target_type || null,
      program_family: program?.program_family || null,
      tags: Array.isArray(program?.tags) ? program.tags : [],
      split_needed: Boolean(program?.split_needed),
      manual_review_needed: Boolean(program?.manual_review_needed),
      score: scored.score,
      score_reasons: scored.score_reasons,
      caution_flags: scored.caution_flags,
      recommendation_lane: scored.recommendation_lane
    };
  });

  const candidatePool = allScored
    .filter((item) => item.recommendation_lane === "candidate" && item.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.target_type !== b.target_type) {
        if (a.target_type === "company_facing") return -1;
        if (b.target_type === "company_facing") return 1;
      }
      return String(a.program_id).localeCompare(String(b.program_id), "en", { numeric: true });
    });

  const candidateCount = candidatePool.length;
  const shortlistCount = candidateCount < 8 ? candidateCount : Math.min(candidateCount, 10);
  const candidates = candidatePool.slice(0, shortlistCount);
  const selectedProgramIds = new Set(candidates.map((item) => item.program_id));

  const excluded_or_reference = allScored
    .filter((item) => !selectedProgramIds.has(item.program_id))
    .map((item) => {
      const recommendationLane = item.recommendation_lane === "candidate" ? "excluded" : item.recommendation_lane;
      const cautionFlags = [...item.caution_flags];
      if (item.recommendation_lane === "candidate") {
        cautionFlags.push("not_selected_due_to_shortlist_cap");
      }
      return {
        program_id: item.program_id,
        program_name: item.program_name,
        markdown_path: item.markdown_path,
        source_page_hint: item.source_page_hint,
        target_type: item.target_type,
        program_family: item.program_family,
        tags: item.tags,
        split_needed: item.split_needed,
        manual_review_needed: item.manual_review_needed,
        score: item.score,
        score_reasons: item.score_reasons,
        caution_flags: [...new Set(cautionFlags)],
        recommendation_lane: recommendationLane
      };
    });

  return {
    candidate_count: candidates.length,
    candidates,
    excluded_or_reference,
    missing_or_weak_input_signals: buildV2MissingOrWeakInputSignals(safeInput),
    warnings: candidateCount >= 8 && candidates.length < 8 ? ["Shortlist was truncated below the 8-item target because the topic set was narrow."] : []
  };
}

function resolveV2SafeInputPath(rawPath) {
  const resolvedPath = path.resolve(REPO_ROOT, String(rawPath || ""));
  if (!isInsideDirectory(resolvedPath, V2_SAFE_INPUT_DIR)) {
    throw new Error("safe_input_path must stay inside app_v1/runtime/v2_safe_input/.");
  }
  return resolvedPath;
}

async function loadV2SafeInputFromPath(rawPath) {
  const safeInputPath = resolveV2SafeInputPath(rawPath);
  const raw = await fs.readFile(safeInputPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("V2 safe input JSON must be an object.");
  }
  return { safeInputPath, safeInput: parsed };
}

function resolveStandardCompanyInputPath(rawPath) {
  const resolvedPath = path.resolve(REPO_ROOT, String(rawPath || ""));
  if (!isInsideDirectory(resolvedPath, COMPANY_INPUTS)) {
    throw new Error("standard_company_input_path must stay inside app_v1/runtime/company_inputs/.");
  }
  if (!resolvedPath.endsWith("_standard_company_input.json")) {
    throw new Error("standard_company_input_path must point to a *_standard_company_input.json file.");
  }
  return resolvedPath;
}

async function loadStandardCompanyInputFromPath(rawPath) {
  const standardCompanyInputPath = resolveStandardCompanyInputPath(rawPath);
  const raw = await fs.readFile(standardCompanyInputPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("standard_company_input JSON must be an object.");
  }
  return { standardCompanyInputPath, standardCompanyInput: parsed };
}

function getConfirmedSavedCompanyInputValue(standardCompanyInput, sourceFieldName) {
  const record = resolveMatcherFieldRecord(standardCompanyInput?.fields, sourceFieldName);
  const status = String(record?.status || "").trim().toLowerCase();
  if (status !== "confirmed" || !hasMeaningfulValue(record?.value)) {
    return null;
  }
  return record.value;
}

function buildV2CandidateValuesFromSavedCompanyInput(standardCompanyInput) {
  const candidateValues = {};
  const userConfirmedFields = [];
  const companyContextText = [
    getConfirmedSavedCompanyInputValue(standardCompanyInput, "product_tech_summary"),
    getConfirmedSavedCompanyInputValue(standardCompanyInput, "top_needs_or_pain_points"),
    getConfirmedSavedCompanyInputValue(standardCompanyInput, "current_stage")
  ].filter(Boolean).join(" ");

  const assignValue = (targetField, sourceFields, transform = (value) => value) => {
    if (Object.prototype.hasOwnProperty.call(candidateValues, targetField)) {
      return;
    }
    const sourceList = Array.isArray(sourceFields) ? sourceFields : [sourceFields];
    for (const sourceField of sourceList) {
      const value = getConfirmedSavedCompanyInputValue(standardCompanyInput, sourceField);
      if (!hasMeaningfulValue(value)) continue;
      const normalizedValue = transform(value);
      if (!hasMeaningfulValue(normalizedValue)) continue;
      candidateValues[targetField] = normalizedValue;
      userConfirmedFields.push(targetField);
      return;
    }
  };

  assignValue("company_name_or_alias", ["company_name_or_alias", "company_name", "company_alias"]);
  assignValue("region", "region");
  assignValue("industry_field", "industry_field", (value) => normalizeV2IndustryField(value, companyContextText) || "기타");
  assignValue("product_tech_summary", "product_tech_summary", (value) => sanitizeDraftText(value, 420));
  assignValue("applicant_type", "applicant_type", (value) => normalizeV2ApplicantType(value, companyContextText));
  assignValue("business_registration_status", "business_registration_status");
  assignValue("current_stage", "current_stage", (value) => normalizeV2CurrentStage(value, companyContextText));
  assignValue("establishment_date", "establishment_date", (value) => normalizeCleanEstablishmentDateValue(value));
  assignValue("business_age_category", ["business_age_category", "business_age"], normalizeV2BusinessAgeCategory);
  assignValue("top_needs_or_pain_points", "top_needs_or_pain_points", (value) => normalizeV2ArrayField(value, 120));
  assignValue("sme_status", "sme_status");
  assignValue("government_support_restriction_status", "government_support_restriction_status");
  assignValue("duplicate_support_risk_status", "duplicate_support_risk_status");
  assignValue("venture_confirmation_status", ["venture_confirmation_status", "venture_cert_status"]);
  assignValue("investment_status", "investment_status");
  assignValue("self_funding_or_cost_share_status", ["self_funding_or_cost_share_status", "self_funding_capacity", "self_funding_or_cost_share"]);
  assignValue("green_bio_or_smart_agri_flag", ["green_bio_or_smart_agri_flag", "green_bio_flag", "smart_agri_flag"]);
  assignValue("technology_transfer_status", "technology_transfer_status");
  assignValue("certification_or_test_need", "certification_or_test_need", (value) => normalizeV2CertificationNeed(value, companyContextText));
  assignValue("sales_record_status", "sales_record_status");
  assignValue("export_intent", ["export_intent", "overseas_expansion_intent"]);
  assignValue("target_country_or_market", "target_country_or_market", (value) => normalizeV2ArrayField(value, 80));
  assignValue("youth_founder_condition_status", "youth_founder_condition_status");
  assignValue("representative_age_condition_status", "representative_age_condition_status");
  assignValue("additional_matching_notes", ["additional_matching_notes", "free_form_company_note"], (value) => sanitizeDraftText(value, 500));
  
  // 핀셋 추가: 고도화 정량 변수 및 가치사슬 기계어 식별자 전달 누락 방지
  assignValue("total_investment_amount", "total_investment_amount", (value) => Number(value) || 0);
  assignValue("annual_revenue", "annual_revenue", (value) => Number(value) || 0);
  assignValue("value_chain_tag", "value_chain_tag");
  assignValue("agrifood_value_chain", "agrifood_value_chain");
  assignValue("green_bio_or_smart_agri", "green_bio_or_smart_agri");
  assignValue("has_overseas_partner_or_loi", "has_overseas_partner_or_loi");
  
  return { candidateValues, userConfirmedFields };
}

function buildV2BridgeCandidateValuesFromSavePayload(payload = {}) {
  const fieldsInput = payload.fields || {};
  const statuses = payload.statuses || {};
  const expandedCandidateFields = payload.v2_safe_candidate_fields && typeof payload.v2_safe_candidate_fields === "object" && !Array.isArray(payload.v2_safe_candidate_fields)
    ? payload.v2_safe_candidate_fields
    : {};
  const candidateValues = {};
  const userConfirmedFields = [];

  const resolveExpandedCandidateFieldValue = (fieldName) => {
    const record = expandedCandidateFields?.[fieldName];
    if (!record) return null;
    if (typeof record === "object" && !Array.isArray(record) && Object.prototype.hasOwnProperty.call(record, "value")) {
      return hasMeaningfulValue(record.value) ? record.value : null;
    }
    return hasMeaningfulValue(record) ? record : null;
  };

  const assignValue = (targetField, sourceFields, transform = (value) => value) => {
    if (Object.prototype.hasOwnProperty.call(candidateValues, targetField)) {
      return;
    }
    const sourceList = Array.isArray(sourceFields) ? sourceFields : [sourceFields];
    for (const sourceField of sourceList) {
      const expandedValue = resolveExpandedCandidateFieldValue(sourceField);
      const value = hasMeaningfulValue(expandedValue) ? expandedValue : resolvePayloadFieldValue(fieldsInput, sourceField);
      const statusValue = resolvePayloadFieldValue(statuses, sourceField);
      const chosenValue = hasMeaningfulValue(value) ? value : statusValue;
      if (!hasMeaningfulValue(chosenValue)) continue;
      const normalizedValue = transform(chosenValue);
      if (!hasMeaningfulValue(normalizedValue)) continue;
      candidateValues[targetField] = normalizedValue;
      userConfirmedFields.push(targetField);
      return;
    }
  };

  assignValue("applicant_type", "applicant_type", (value) => normalizeV2ApplicantType(value));
  assignValue("business_registration_status", "business_registration_status");
  assignValue("business_age_category", ["business_age_category", "business_age"], normalizeV2BusinessAgeCategory);
  assignValue("sme_status", "sme_status");
  assignValue("government_support_restriction_status", "government_support_restriction_status");
  assignValue("duplicate_support_risk_status", "duplicate_support_risk_status");
  assignValue("venture_confirmation_status", ["venture_confirmation_status", "venture_cert_status"]);
  assignValue("investment_status", "investment_status");
  assignValue("self_funding_or_cost_share_status", ["self_funding_or_cost_share_status", "self_funding_or_cost_share", "self_funding_capacity"]);
  assignValue("current_stage", "current_stage", (value) => normalizeV2CurrentStage(value));
  assignValue("establishment_date", "establishment_date", (value) => normalizeCleanEstablishmentDateValue(value));
  assignValue("green_bio_or_smart_agri_flag", ["green_bio_or_smart_agri_flag", "green_bio_flag", "smart_agri_flag"], (value) => normalizeV2GreenBioOrSmartAgriFlag(value) || null);
  assignValue("technology_transfer_status", "technology_transfer_status");
  assignValue("certification_or_test_need", "certification_or_test_need", (value) => normalizeV2CertificationNeed(value));
  assignValue("sales_record_status", "sales_record_status");
  assignValue("export_intent", ["export_intent", "overseas_expansion_intent"]);
  assignValue("target_country_or_market", "target_country_or_market", (value) => normalizeV2ArrayField(value, 80));
  assignValue("youth_founder_condition_status", "youth_founder_condition_status");
  assignValue("representative_age_condition_status", "representative_age_condition_status");
  assignValue("additional_matching_notes", ["additional_matching_notes", "free_form_company_note"], (value) => sanitizeDraftText(value, 500));

  return { candidateValues, userConfirmedFields };
}

async function writeV2SafeInputBridgeFromStandardCompanyInput(standardCompanyInput, payload = {}, now = new Date()) {
  const standardBridge = buildV2CandidateValuesFromSavedCompanyInput(standardCompanyInput);
  const payloadBridge = buildV2BridgeCandidateValuesFromSavePayload(payload);
  const candidateValues = { ...standardBridge.candidateValues, ...payloadBridge.candidateValues };
  const userConfirmedFields = [];
  const seenConfirmedFields = new Set();
  for (const field of [...(standardBridge.userConfirmedFields || []), ...(payloadBridge.userConfirmedFields || [])]) {
    const name = String(field || "").trim();
    if (!name || seenConfirmedFields.has(name)) continue;
    seenConfirmedFields.add(name);
    userConfirmedFields.push(name);
  }
  const safeInput = normalizeToV2SafeInput(candidateValues, {
    synthetic_fixture: false,
    schema_version: "v2_safe_input_bridge",
    user_confirmed_fields: userConfirmedFields
  });

  const caseId = slugifyCaseIdCandidate(
    String(standardCompanyInput?.case_id || "").trim()
    || String(standardCompanyInput?.fields?.company_name_or_alias?.value || "").trim()
    || `v2_bridge_${formatUploadTimestamp(now)}`
  ) || `v2_bridge_${formatUploadTimestamp(now)}`;

  const pipelineRunDir = path.join(V2_PIPELINE_RUNS_DIR, caseId);
  await fs.mkdir(pipelineRunDir, { recursive: true });
  const safeInputPath = path.join(pipelineRunDir, "v2_safe_input.json");
  await fs.writeFile(safeInputPath, JSON.stringify(safeInput, null, 2), "utf8");

  return {
    caseId,
    safeInput,
    safeInputPath
  };
}

async function prepareV2PipelineArtifactsFromSafeInput(payload, safeInput, options = {}) {
  const now = options.now || new Date();
  let caseId = null;
  let safeInputPath = options.safeInputPath || null;
  let candidateRetrievalPath = null;
  let candidateRetrievalSourcePath = null;
  let packageId = null;
  let packagePath = null;
  const sourceSafeInputPath = options.sourceSafeInputPath || null;

  try {
    const safeInputSensitivePaths = findV2SensitivePackageFieldPaths(safeInput);
    if (safeInputSensitivePaths.length) {
      return {
        statusCode: 400,
        body: {
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
        }
      };
    }

    caseId = sanitizeV2PipelineRunCaseId(payload.case_id || safeInput.case_id || payload.retrieval_id || safeInput.company_name_or_alias || `v2_run_${now.toISOString()}`, now);
    const normalizedSafeInput = normalizeToV2SafeInput(safeInput, {
      synthetic_fixture: Boolean(safeInput.synthetic_fixture || payload.synthetic_fixture),
      schema_version: safeInput.schema_version || payload.schema_version || "v2_safe_input_draft",
      user_confirmed_fields: safeInput.user_confirmed_fields || payload.user_confirmed_fields || payload.confirmed_fields || []
    });

    await fs.mkdir(V2_PIPELINE_RUNS_DIR, { recursive: true });
    const pipelineRunDir = path.join(V2_PIPELINE_RUNS_DIR, caseId);
    await fs.mkdir(pipelineRunDir, { recursive: true });

    safeInputPath = path.join(pipelineRunDir, "v2_safe_input.json");
    await fs.writeFile(safeInputPath, JSON.stringify(normalizedSafeInput, null, 2), "utf8");

    const programIndex = await loadV2ProgramIndex();
    const retrievalId = slugifyCaseIdCandidate(payload.retrieval_id || normalizedSafeInput.retrieval_id || `${caseId}_retrieval`) || `${caseId}_retrieval`;
    const retrieval = retrieveV2CandidatePrograms(normalizedSafeInput, {
      retrieval_id: retrievalId,
      case_id: caseId,
      program_index: programIndex
    });
    const retrievalResult = buildV2CandidateRetrievalResult({
      retrievalId,
      caseId,
      sourceSafeInputPath,
      safeInput: normalizedSafeInput,
      programIndex,
      retrieval
    });

    candidateRetrievalSourcePath = path.join(V2_CANDIDATE_RETRIEVAL_DIR, `${retrievalId}_candidates.json`);
    await fs.mkdir(V2_CANDIDATE_RETRIEVAL_DIR, { recursive: true });
    await fs.writeFile(candidateRetrievalSourcePath, JSON.stringify(retrievalResult, null, 2), "utf8");
    candidateRetrievalPath = path.join(pipelineRunDir, "candidate_retrieval.json");
    await fs.writeFile(candidateRetrievalPath, JSON.stringify(retrievalResult, null, 2), "utf8");

    if (retrievalResult.candidate_count <= 0) {
      const packageManifestPath = path.join(pipelineRunDir, "package_manifest.json");
      const packageManifest = {
        ok: false,
        v2_pipeline_step: "candidate_retrieval_only",
        case_id: caseId,
        safe_input_path: toRepoPath(safeInputPath),
        candidate_retrieval_path: toRepoPath(candidateRetrievalPath),
        package_path: null,
        package_id: null,
        candidate_count: 0,
        ai_matcher_run: false,
        result_view_model_created: false,
        live_top2_replaced: false,
        privacy_boundary_status: "confirmed_safe_input_only",
        warnings: [...(Array.isArray(retrievalResult.warnings) ? retrievalResult.warnings : []), "No candidate-lane programs were found for the confirmed safe input."],
        next_manual_step: "Broaden the confirmed safe input and run the pipeline again."
      };
      await fs.writeFile(packageManifestPath, JSON.stringify(packageManifest, null, 2), "utf8");
      return {
        statusCode: 200,
        body: {
          ...packageManifest,
          package_manifest_path: toRepoPath(packageManifestPath),
          v2_case_id: caseId
        }
      };
    }

    packageId = sanitizeV2PackageId(payload.package_id || payload.package_name || `${caseId}_package`, now);
    const packageInfo = await buildV2AiMatcherPackage({
      safeInput: normalizedSafeInput,
      safeInputPath,
      candidateRetrievalPath: candidateRetrievalSourcePath,
      packageId,
      now
    });
    packagePath = packageInfo.package_root;

    const packageManifestPath = path.join(pipelineRunDir, "package_manifest.json");
    const packageManifest = {
      ok: true,
      v2_pipeline_step: "safe_input_candidate_retrieval_package_built",
      case_id: caseId,
      safe_input_path: toRepoPath(safeInputPath),
      safe_input_source_path: sourceSafeInputPath ? toRepoPath(sourceSafeInputPath) : null,
      candidate_retrieval_path: toRepoPath(candidateRetrievalPath),
      package_path: packageInfo.package_root,
      package_id: packageInfo.package_id,
      candidate_count: packageInfo.candidate_count,
      ai_matcher_run: false,
      result_view_model_created: false,
      live_top2_replaced: false,
      privacy_boundary_status: "confirmed_safe_input_only",
      warnings: Array.isArray(retrievalResult.warnings) ? retrievalResult.warnings : [],
      next_manual_step: "Run the isolated AI matcher only after approval."
    };
    await fs.writeFile(packageManifestPath, JSON.stringify(packageManifest, null, 2), "utf8");

    return {
      statusCode: 200,
      body: {
        ...packageManifest,
        package_manifest_path: toRepoPath(packageManifestPath),
        v2_case_id: caseId
      }
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: {
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
      }
    };
  }
}

function sanitizeV2PackageId(value, now = new Date()) {
  const raw = String(value || "").trim();
  const base = slugifyCaseIdCandidate(raw);
  if (base) return base;
  return `v2_ai_pkg_${formatUploadTimestamp(now)}`;
}

function sanitizeV2PipelineRunCaseId(value, now = new Date()) {
  const raw = String(value || "").trim();
  const base = slugifyCaseIdCandidate(raw);
  if (base) return base;
  return `v2_run_${formatUploadTimestamp(now)}`;
}

function findV2SensitivePackageFieldPaths(value, currentPath = "") {
  const sensitiveKeys = new Set([
    "raw_pdf_text",
    "ocr_text",
    "scanned_evidence",
    "raw_company_document_text",
    "upload_text",
    "full_pdf_text",
    "local_extracted_text",
    "extracted_text"
  ]);
  const hits = [];
  if (!value || typeof value !== "object") {
    return hits;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      hits.push(...findV2SensitivePackageFieldPaths(item, `${currentPath}[${index}]`));
    });
    return hits;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    const nextPath = currentPath ? `${currentPath}.${key}` : key;
    if (sensitiveKeys.has(key)) {
      hits.push(nextPath);
    }
    if (nestedValue && typeof nestedValue === "object") {
      hits.push(...findV2SensitivePackageFieldPaths(nestedValue, nextPath));
    }
  }
  return hits;
}

function resolveV2CandidateRetrievalPath(rawPath) {
  const resolvedPath = path.resolve(REPO_ROOT, String(rawPath || ""));
  if (!isInsideDirectory(resolvedPath, V2_CANDIDATE_RETRIEVAL_DIR)) {
    throw new Error("candidate_retrieval_path must stay inside app_v1/runtime/v2_candidate_retrieval/.");
  }
  return resolvedPath;
}

function resolveV2ProgramMarkdownPath(markdownPath) {
  const resolvedPath = path.resolve(REPO_ROOT, "support_program_db", "ai_ready_markdown_db", String(markdownPath || ""));
  if (!isInsideDirectory(resolvedPath, V2_PROGRAMS_DIR)) {
    throw new Error(`Invalid candidate markdown path: ${markdownPath}`);
  }
  return resolvedPath;
}

async function loadV2CandidateMarkdown(candidate) {
  const sourceMarkdownPath = resolveV2ProgramMarkdownPath(candidate?.markdown_path);
  const markdownText = await fs.readFile(sourceMarkdownPath, "utf8");
  const packageMarkdownFilename = path.basename(sourceMarkdownPath);
  return {
    source_markdown_path: toRepoPath(sourceMarkdownPath),
    markdown_text: markdownText,
    package_markdown_filename: packageMarkdownFilename,
    package_markdown_path: `candidate_program_markdowns/${packageMarkdownFilename}`
  };
}

async function writeV2AiMatcherPackage(packageRoot, packageData) {
  await fs.mkdir(packageRoot, { recursive: true });
  const markdownDir = path.join(packageRoot, "candidate_program_markdowns");
  await fs.mkdir(markdownDir, { recursive: true });

  const safeInputPath = path.join(packageRoot, "safe_input.json");
  const candidateProgramsPath = path.join(packageRoot, "candidate_programs.json");
  const promptPath = path.join(packageRoot, "matcher_prompt.md");
  const schemaPath = path.join(packageRoot, "output_schema.json");
  const manifestPath = path.join(packageRoot, "source_manifest.json");

  await fs.writeFile(safeInputPath, JSON.stringify(packageData.safe_input, null, 2), "utf8");
  await fs.writeFile(candidateProgramsPath, JSON.stringify(packageData.candidate_programs, null, 2), "utf8");
  await fs.writeFile(promptPath, packageData.matcher_prompt, "utf8");
  await fs.writeFile(schemaPath, JSON.stringify(packageData.output_schema, null, 2), "utf8");

  for (const markdown of packageData.candidate_markdowns) {
    const markdownPath = path.join(markdownDir, markdown.package_markdown_filename);
    await fs.writeFile(markdownPath, markdown.markdown_text, "utf8");
  }

  await fs.writeFile(manifestPath, JSON.stringify(packageData.source_manifest, null, 2), "utf8");

  return {
    package_root: toRepoPath(packageRoot),
    safe_input_path: toRepoPath(safeInputPath),
    candidate_programs_path: toRepoPath(candidateProgramsPath),
    matcher_prompt_path: toRepoPath(promptPath),
    output_schema_path: toRepoPath(schemaPath),
    source_manifest_path: toRepoPath(manifestPath),
    candidate_markdown_paths: packageData.candidate_markdowns.map((item) => `app_v1/runtime/v2_ai_matcher_packages/${path.basename(packageRoot)}/${item.package_markdown_path}`),
    candidate_markdown_count: packageData.candidate_markdowns.length
  };
}

async function buildV2AiMatcherPackage({
  safeInput,
  safeInputPath = null,
  candidateRetrievalPath,
  packageId = null,
  now = new Date()
}) {
  const sensitivePaths = findV2SensitivePackageFieldPaths(safeInput);
  if (sensitivePaths.length) {
    throw new Error(`Rejected unsafe safe input fields: ${sensitivePaths.join(", ")}`);
  }

  const retrievalPath = resolveV2CandidateRetrievalPath(candidateRetrievalPath);
  const retrieval = JSON.parse(await fs.readFile(retrievalPath, "utf8"));
  if (!retrieval || typeof retrieval !== "object" || Array.isArray(retrieval)) {
    throw new Error("candidate retrieval JSON must be an object.");
  }

  const selectedCandidates = Array.isArray(retrieval.candidates)
    ? retrieval.candidates.filter((candidate) => String(candidate?.recommendation_lane || "").trim() === "candidate")
    : [];
  if (!selectedCandidates.length) {
    throw new Error("No candidate-lane programs were found in the retrieval JSON.");
  }

  const packageIdSanitized = sanitizeV2PackageId(packageId || retrieval.retrieval_id || retrieval.case_id || safeInput?.company_name_or_alias || "v2_ai_package", now);
  const packageRoot = path.join(V2_AI_MATCHER_PACKAGE_DIR, packageIdSanitized);

  const candidate_markdowns = [];
  const candidate_programs = selectedCandidates.map((candidate) => ({
    program_id: String(candidate?.program_id || ""),
    program_name: String(candidate?.program_name || ""),
    markdown_path: String(candidate?.markdown_path || ""),
    source_page_hint: candidate?.source_page_hint ?? null,
    target_type: candidate?.target_type || null,
    program_family: candidate?.program_family || null,
    tags: Array.isArray(candidate?.tags) ? candidate.tags : [],
    split_needed: Boolean(candidate?.split_needed),
    manual_review_needed: Boolean(candidate?.manual_review_needed),
    score: candidate?.score ?? null,
    score_reasons: Array.isArray(candidate?.score_reasons) ? candidate.score_reasons : [],
    caution_flags: Array.isArray(candidate?.caution_flags) ? candidate.caution_flags : [],
    recommendation_lane: "candidate",
    package_markdown_filename: `${String(candidate?.program_id || "program")}_${path.basename(String(candidate?.markdown_path || "program.md"))}`,
    package_markdown_path: `candidate_program_markdowns/${path.basename(String(candidate?.markdown_path || "program.md"))}`
  }));

  for (const candidate of selectedCandidates) {
    const markdown = await loadV2CandidateMarkdown(candidate);
    candidate_markdowns.push(markdown);
  }

  const promptTemplate = await fs.readFile(V2_AI_MATCHER_PROMPT_DRAFT_PATH, "utf8");
  const outputSchema = JSON.parse(await fs.readFile(V2_AI_MATCHER_OUTPUT_SCHEMA_DRAFT_PATH, "utf8"));
  const createdAt = now.toISOString();

  const candidate_programs_with_paths = candidate_programs.map((candidate, index) => ({
    ...candidate,
    package_markdown_filename: candidate_markdowns[index]?.package_markdown_filename || candidate.package_markdown_filename,
    package_markdown_path: candidate_markdowns[index]?.package_markdown_path || candidate.package_markdown_path,
    source_markdown_path: candidate_markdowns[index]?.source_markdown_path || candidate.markdown_path
  }));

  const sourceManifest = {
    package_id: packageIdSanitized,
    created_at: createdAt,
    safe_input_source_mode: safeInputPath ? "saved_safe_input_path" : "direct_object",
    safe_input_source_path: safeInputPath ? toRepoPath(safeInputPath) : null,
    candidate_retrieval_path: toRepoPath(retrievalPath),
    candidate_retrieval_id: String(retrieval.retrieval_id || retrieval.case_id || packageIdSanitized),
    candidate_count: candidate_programs_with_paths.length,
    candidate_program_ids: candidate_programs_with_paths.map((candidate) => candidate.program_id),
    candidate_program_markdown_paths: candidate_programs_with_paths.map((candidate) => candidate.source_markdown_path),
    package_files: [
      "safe_input.json",
      "candidate_programs.json",
      "matcher_prompt.md",
      "output_schema.json",
      "source_manifest.json"
    ],
    package_candidate_markdown_files: candidate_programs_with_paths.map((candidate) => candidate.package_markdown_path),
    privacy_validation: {
      raw_pdf_text: false,
      ocr_text: false,
      scanned_evidence: false,
      raw_company_document_text: false
    },
    source_notes: "Package contains only safe input, candidate metadata, public program Markdown, matcher prompt, output schema, and manifest."
  };

  const packageData = {
    safe_input: safeInput,
    candidate_programs: {
      package_id: packageIdSanitized,
      created_at: createdAt,
      candidate_retrieval_path: toRepoPath(retrievalPath),
      source_safe_input_path: safeInputPath ? toRepoPath(safeInputPath) : null,
      candidate_count: candidate_programs_with_paths.length,
      candidate_programs: candidate_programs_with_paths
    },
    candidate_markdowns,
    matcher_prompt: [
      `# V2 AI Matcher Package - ${packageIdSanitized}`,
      "",
      `- package_id: ${packageIdSanitized}`,
      `- created_at: ${createdAt}`,
      `- safe_input_source: ${safeInputPath ? toRepoPath(safeInputPath) : "direct_object"}`,
      `- candidate_retrieval_source: ${toRepoPath(retrievalPath)}`,
      `- candidate_count: ${candidate_programs_with_paths.length}`,
      "",
      promptTemplate
    ].join("\n"),
    output_schema: outputSchema,
    source_manifest: sourceManifest
  };

  const writeResult = await writeV2AiMatcherPackage(packageRoot, packageData);
  return {
    package_id: packageIdSanitized,
    package_root: writeResult.package_root,
    created_at: createdAt,
    source_safe_input_path: writeResult.safe_input_path,
    source_candidate_retrieval_path: toRepoPath(retrievalPath),
    candidate_count: candidate_programs_with_paths.length,
    candidate_markdown_count: candidate_markdowns.length,
    files: {
      safe_input_json: writeResult.safe_input_path,
      candidate_programs_json: writeResult.candidate_programs_path,
      matcher_prompt_md: writeResult.matcher_prompt_path,
      output_schema_json: writeResult.output_schema_path,
      source_manifest_json: writeResult.source_manifest_path
    }
  };
}

function buildV2CandidateRetrievalResult({
  retrievalId,
  caseId,
  sourceSafeInputPath,
  safeInput,
  programIndex,
  retrieval
}) {
  return {
    ok: true,
    case_id: caseId || null,
    retrieval_id: retrievalId,
    source_safe_input_path: sourceSafeInputPath || null,
    source_program_index_path: toRepoPath(V2_PROGRAM_INDEX_PATH),
    safe_input_schema_version: safeInput?.schema_version || null,
    candidate_count: retrieval.candidate_count,
    candidates: retrieval.candidates,
    excluded_or_reference: retrieval.excluded_or_reference,
    missing_or_weak_input_signals: retrieval.missing_or_weak_input_signals,
    warnings: retrieval.warnings,
    source_program_index_entry_count: Array.isArray(programIndex) ? programIndex.length : null
  };
}

async function handlePrepareV2PackageFromCompanyInput(req, res) {
  const now = new Date();
  let sourceStandardCompanyInputPath = null;
  let sourceCaseId = null;
  let v2CaseId = null;
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

    const payloadSensitivePaths = findV2SensitivePackageFieldPaths(payload);
    if (payloadSensitivePaths.length) {
      return json(res, 400, {
        ok: false,
        case_id: null,
        v2_case_id: null,
        safe_input_path: null,
        candidate_retrieval_path: null,
        package_path: null,
        candidate_count: 0,
        ai_matcher_run: false,
        result_view_model_created: false,
        live_top2_replaced: false,
        privacy_boundary_status: "blocked_raw_text_input",
        warnings: [`Unsafe request fields were rejected: ${payloadSensitivePaths.join(", ")}`],
        next_manual_step: "Remove raw PDF/OCR/upload text from the request and resend confirmed saved company input only."
      });
    }

    const requestedCaseId = String(payload.case_id || "").trim();
    const requestedPath = String(payload.standard_company_input_path || payload.company_input_path || "").trim();
    const savedInputSelection = requestedPath
      ? await loadStandardCompanyInputFromPath(requestedPath)
      : requestedCaseId
        ? await loadStandardCompanyInputFromPath(path.join(COMPANY_INPUTS, `${slugifyCaseIdCandidate(requestedCaseId) || "case" }_standard_company_input.json`))
        : null;

    if (!savedInputSelection) {
      return json(res, 400, {
        ok: false,
        case_id: null,
        v2_case_id: null,
        safe_input_path: null,
        candidate_retrieval_path: null,
        package_path: null,
        candidate_count: 0,
        ai_matcher_run: false,
        result_view_model_created: false,
        live_top2_replaced: false,
        privacy_boundary_status: "missing_saved_company_input",
        warnings: ["case_id or standard_company_input_path is required."],
        next_manual_step: "Provide a saved confirmed company input and run again."
      });
    }

    sourceStandardCompanyInputPath = savedInputSelection.standardCompanyInputPath;
    const standardCompanyInput = savedInputSelection.standardCompanyInput;
    const savedInputSensitivePaths = findV2SensitivePackageFieldPaths(standardCompanyInput);
    if (savedInputSensitivePaths.length) {
      return json(res, 400, {
        ok: false,
        case_id: null,
        v2_case_id: null,
        safe_input_path: null,
        candidate_retrieval_path: null,
        package_path: null,
        candidate_count: 0,
        ai_matcher_run: false,
        result_view_model_created: false,
        live_top2_replaced: false,
        privacy_boundary_status: "blocked_raw_text_input",
        warnings: [`Unsafe saved company input fields were rejected: ${savedInputSensitivePaths.join(", ")}`],
        next_manual_step: "Remove raw PDF/OCR/upload text from the saved company input and try again."
      });
    }

    const { candidateValues, userConfirmedFields } = buildV2CandidateValuesFromSavedCompanyInput(standardCompanyInput);
    sourceCaseId = slugifyCaseIdCandidate(
      requestedCaseId
      || String(standardCompanyInput.case_id || "").trim()
      || path.basename(sourceStandardCompanyInputPath, "_standard_company_input.json")
    ) || null;
    v2CaseId = requestedCaseId
      ? (sourceCaseId && sourceCaseId.startsWith("v2_case_") ? sourceCaseId : `v2_case_${sourceCaseId || slugifyCaseIdCandidate(requestedCaseId) || formatUploadTimestamp(now)}`)
      : `v2_real_${formatUploadTimestamp(now)}`;

    const safeInput = normalizeToV2SafeInput(candidateValues, {
      synthetic_fixture: false,
      schema_version: payload.schema_version || "v2_safe_input_draft",
      user_confirmed_fields: userConfirmedFields
    });

    packageId = sanitizeV2PackageId(payload.package_id || payload.package_name || `${v2CaseId}_package`, now);
    const prepared = await prepareV2PipelineArtifactsFromSafeInput({
      ...payload,
      case_id: v2CaseId,
      package_id: packageId,
      candidate_values: candidateValues,
      user_confirmed_fields: userConfirmedFields,
      synthetic_fixture: false
    }, safeInput, {
      sourceSafeInputPath: sourceStandardCompanyInputPath,
      now
    });

    const responseBody = {
      ok: prepared.body.ok,
      case_id: sourceCaseId,
      v2_case_id: prepared.body.v2_case_id || v2CaseId,
      safe_input_path: prepared.body.safe_input_path,
      candidate_retrieval_path: prepared.body.candidate_retrieval_path,
      package_path: prepared.body.package_path,
      candidate_count: prepared.body.candidate_count,
      ai_matcher_run: false,
      result_view_model_created: false,
      live_top2_replaced: false,
      privacy_boundary_status: prepared.body.privacy_boundary_status,
      warnings: prepared.body.warnings,
      next_manual_step: prepared.body.next_manual_step,
      package_manifest_path: prepared.body.package_manifest_path,
      source_standard_company_input_path: toRepoPath(sourceStandardCompanyInputPath)
    };

    return json(res, prepared.statusCode, responseBody);
  } catch (error) {
    return json(res, 500, {
      ok: false,
      case_id: sourceCaseId,
      v2_case_id: v2CaseId,
      safe_input_path: null,
      candidate_retrieval_path: null,
      package_path: null,
      candidate_count: 0,
      ai_matcher_run: false,
      result_view_model_created: false,
      live_top2_replaced: false,
      privacy_boundary_status: "error",
      warnings: [error.message],
      next_manual_step: "Inspect the error, then rerun with confirmed saved company input only."
    });
  }
}
function getFastMatchSavedInputCaseIdCandidates(caseId) {
  const candidates = [caseId];
  if (caseId.startsWith("v2_case_")) {
    candidates.push(caseId.slice("v2_case_".length));
  }
  return [...new Set(candidates.map((item) => slugifyCaseIdCandidate(item)).filter(Boolean))];
}

async function ensureFastMatchSafeInput(caseId, caseDir, expectedSafeInputPath) {
  if (await pathExists(expectedSafeInputPath)) {
    const raw = await fs.readFile(expectedSafeInputPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw Object.assign(new Error("v2_safe_input.json must contain a JSON object."), { stage: "invalid_safe_input" });
    }

    for (const savedInputCaseId of getFastMatchSavedInputCaseIdCandidates(caseId)) {
      const standardPath = path.join(COMPANY_INPUTS, `${savedInputCaseId}_standard_company_input.json`);
      if (!(await pathExists(standardPath))) continue;
      const { standardCompanyInput } = await loadStandardCompanyInputFromPath(standardPath);
      const savedInputSensitivePaths = findV2SensitivePackageFieldPaths(standardCompanyInput);
      if (savedInputSensitivePaths.length) {
        throw Object.assign(
          new Error(`Unsafe saved company input fields were rejected: ${savedInputSensitivePaths.join(", ")}`),
          { stage: "unsafe_saved_company_input" }
        );
      }
      const { candidateValues, userConfirmedFields } = buildV2CandidateValuesFromSavedCompanyInput(standardCompanyInput);
      const generatedSafeInput = normalizeToV2SafeInput(candidateValues, {
        synthetic_fixture: false,
        schema_version: parsed.schema_version || "v2_safe_input_draft",
        user_confirmed_fields: userConfirmedFields
      });
      const safeInputSensitivePaths = findV2SensitivePackageFieldPaths(generatedSafeInput);
      if (safeInputSensitivePaths.length) {
        throw Object.assign(
          new Error(`Unsafe generated safe input fields were rejected: ${safeInputSensitivePaths.join(", ")}`),
          { stage: "unsafe_generated_safe_input" }
        );
      }
      let changed = false;
      for (const field of V2_SAFE_INPUT_VALUE_FIELDS) {
        if (!hasMeaningfulValue(generatedSafeInput[field])) continue;
        const nextValue = generatedSafeInput[field];
        if (JSON.stringify(parsed[field]) !== JSON.stringify(nextValue)) {
          parsed[field] = nextValue;
          changed = true;
        }
      }
      const confirmed = [...new Set([...(parsed.user_confirmed_fields || []), ...userConfirmedFields])];
      if (JSON.stringify(parsed.user_confirmed_fields || []) !== JSON.stringify(confirmed)) {
        parsed.user_confirmed_fields = confirmed;
        changed = true;
      }
      const missing = markMissingV2Fields(parsed, parsed.user_confirmed_fields);
      if (JSON.stringify(parsed.fields_needing_confirmation || []) !== JSON.stringify(missing)) {
        parsed.fields_needing_confirmation = missing;
        changed = true;
      }
      if (changed) {
        await fs.writeFile(expectedSafeInputPath, JSON.stringify(parsed, null, 2), "utf8");
        return {
          ok: true,
          safeInputPath: expectedSafeInputPath,
          source: "existing_v2_safe_input_updated_from_saved_company_input",
          sourceStandardCompanyInputPath: standardPath,
          created: false
        };
      }
      break;
    }

    return {
      ok: true,
      safeInputPath: expectedSafeInputPath,
      source: "existing_v2_safe_input",
      created: false
    };
  }

  const checkedStandardInputPaths = [];
  for (const savedInputCaseId of getFastMatchSavedInputCaseIdCandidates(caseId)) {
    const standardPath = path.join(COMPANY_INPUTS, `${savedInputCaseId}_standard_company_input.json`);
    checkedStandardInputPaths.push(toRepoPath(standardPath));
    if (!(await pathExists(standardPath))) continue;

    const { standardCompanyInput } = await loadStandardCompanyInputFromPath(standardPath);
    const savedInputSensitivePaths = findV2SensitivePackageFieldPaths(standardCompanyInput);
    if (savedInputSensitivePaths.length) {
      throw Object.assign(
        new Error(`Unsafe saved company input fields were rejected: ${savedInputSensitivePaths.join(", ")}`),
        { stage: "unsafe_saved_company_input" }
      );
    }

    const { candidateValues, userConfirmedFields } = buildV2CandidateValuesFromSavedCompanyInput(standardCompanyInput);
    const safeInput = normalizeToV2SafeInput(candidateValues, {
      synthetic_fixture: false,
      schema_version: "v2_safe_input_draft",
      user_confirmed_fields: userConfirmedFields
    });
    const safeInputSensitivePaths = findV2SensitivePackageFieldPaths(safeInput);
    if (safeInputSensitivePaths.length) {
      throw Object.assign(
        new Error(`Unsafe generated safe input fields were rejected: ${safeInputSensitivePaths.join(", ")}`),
        { stage: "unsafe_generated_safe_input" }
      );
    }

    await fs.mkdir(caseDir, { recursive: true });
    await fs.writeFile(expectedSafeInputPath, JSON.stringify(safeInput, null, 2), "utf8");
    return {
      ok: true,
      safeInputPath: expectedSafeInputPath,
      source: "generated_from_saved_company_input",
      sourceStandardCompanyInputPath: standardPath,
      created: true
    };
  }

  return {
    ok: false,
    stage: "missing_safe_input",
    message: "먼저 문서 추출과 입력값 저장을 완료한 뒤 Fast AI 상담 브리핑을 생성할 수 있습니다.",
    expected_path: toRepoPath(expectedSafeInputPath),
    checked_standard_input_paths: checkedStandardInputPaths
  };
}

// 메인 서버에서 쓸 수 있게 내보냅니다.
module.exports = {
  handleSave, 
  handleGeneratePass1Request, 
  handleRunMatcher, 
  handleGenerateV2SafeInput, 
  handlePrepareV2PackageFromCompanyInput,
  // 다른 파일에서 빌려 쓸 수 있도록 도우미 함수들 문 활짝 열기!
  loadV2SafeInputFromPath, 
  retrieveV2CandidatePrograms, 
  buildV2CandidateRetrievalResult, 
  prepareV2PipelineArtifactsFromSafeInput, 
  loadV2ProgramIndex,
  ensureFastMatchSafeInput
};