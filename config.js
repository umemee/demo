// config.js
const path = require("path");

const PORT = Number(process.env.PORT || 4173);

// 🟢 조치 1: 번 컴파일 및 사내 서버 배포 환경을 위한 절대 고정 기준점 설정
// 프로그램이 실행되는 현재 디렉토리를 무조건 중심축으로 삼습니다.
const RUNTIME_ROOT = process.cwd();

// 모든 루트 경로를 실행 위치로 일치시켜 상위 폴더 이탈을 원천 차단합니다.
const ROOT = RUNTIME_ROOT;
const REPO_ROOT = RUNTIME_ROOT;

const RUNTIME = path.join(ROOT, "runtime");
const COMPANY_INPUTS = path.join(RUNTIME, "company_inputs");
const CLI_INPUTS = path.join(RUNTIME, "cli_inputs");
const RESULTS = path.join(RUNTIME, "results");
const SESSIONS = path.join(RUNTIME, "sessions");
const UPLOADS = path.join(RUNTIME, "uploads");

// 🟢 조치 2: 모든 DB 및 기준 파일들의 위치를 배포 폴더 하위 구조로 정돈
const MATCHER_CATALOG_PATH = path.join(RUNTIME, "structured_criteria", "core_program_criteria_3_programs_sample.json");
const TOP2_RUNTIME_MATCHER_CATALOG_PATH = path.join(ROOT, "runtime_matcher_catalog.top2.json");
const RUNTIME_MATCHER_SOURCE_TYPE = "runtime_matcher_result_view_model";
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const MAX_UPLOAD_REQUEST_BYTES = 25 * 1024 * 1024;
const UPLOAD_TOO_LARGE_MESSAGE = "현재 v1 업로드 방식에서는 큰 PDF가 실패할 수 있습니다. 더 작은 PDF로 테스트하거나 업로드 제한을 확인해 주세요.";
const EXTRACTION_PREVIEW_NOTE = "Extraction preview only. No Privacy Filter, auto-fill, or matching was run in Step 4.";

// 🟢 조치 3: 파이썬 호출 가속 방어선 구축 (시스템 글로벌 환경 차단)
const OPENDATALOADER_COMMAND = {
  tool: "opendataloader_pdf",
  command: "python -m opendataloader_pdf -o <case extraction folder> -f markdown --keep-line-breaks --replace-invalid-chars \" \" --image-output off <uploaded PDF>"
};

const AUTOFILL_ALLOWED_FIELDS = [
  "company_name_or_alias",
  "region",
  "industry_field",
  "product_tech_summary",
  "top_needs_or_pain_points"
];
const AUTOFILL_BLOCKED_FIELDS = [
  "government_support_restriction_status",
  "sme_status",
  "applicant_type",
  "establishment_date",
  "current_stage",
  "founder_representative_age_band",
  "venture_confirmation_status",
  "venture_cert_status",
  "self_funding_or_cost_share",
  "self_funding_capacity",
  "schedule_readiness",
  "poc_or_testbed_experience",
  "investment_status",
  "overseas_expansion_intent",
  "public_procurement_intent",
  "free_form_company_note",
  "application_eligibility",
  "recommendation_grade",
  "pass1_result",
  "followup_needed",
  "refined_result",
  "youth_preference_status"
];

const AUTOFILL_EXPANDED_V2_SAFE_FIELDS = [
  "applicant_type",
  "business_registration_status",
  "establishment_date",
  "business_age_category",
  "sme_status",
  "government_support_restriction_status",
  "duplicate_support_risk_status",
  "venture_confirmation_status",
  "investment_status",
  "self_funding_or_cost_share_status",
  "current_stage",
  "green_bio_or_smart_agri_flag",
  "technology_transfer_status",
  "certification_or_test_need",
  "sales_amount",     
  "employee_count",   
  "export_intent",
  "target_country_or_market"
];

const V2_SAFE_INPUT_VALUE_FIELDS = [
  "company_name_or_alias",
  "region",
  "industry_field",
  "product_tech_summary",
  "current_stage",
  "top_needs_or_pain_points",
  "applicant_type",
  "business_registration_status",
  "establishment_date",
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
  "target_country_or_market",
  "youth_founder_condition_status",
  "representative_age_condition_status",
  "additional_matching_notes"
];
const V2_SAFE_INPUT_ARRAY_FIELDS = new Set([
  "top_needs_or_pain_points",
  "target_country_or_market",
  "user_confirmed_fields",
  "fields_needing_confirmation"
]);
const V2_SAFE_INPUT_ALLOWED_INDUSTRIES = new Set([
  "농식품",
  "스마트농업",
  "그린바이오",
  "시험·분석",
  "해외진출",
  "저탄소 농업",
  "기타",
  "unknown"
]);
const V2_SAFE_INPUT_ALLOWED_GREEN_FLAGS = new Set(["yes", "no", "maybe", "unknown"]);
const V2_SAFE_INPUT_ALLOWED_BUSINESS_AGE_CATEGORIES = new Set([
  "pre_registration",
  "under_1_year",
  "under_3_years",
  "under_5_years",
  "over_5_years",
  "unknown"
]);
const V2_SAFE_INPUT_ALLOWED_CERTIFICATION_NEEDS = new Set([
  "none",
  "demo_or_pilot",
  "demo_or_certification",
  "certification_or_test",
  "unknown"
]);
const V2_SAFE_INPUT_ALLOWED_CURRENT_STAGE_VALUES = new Set([
  "pre_startup",
  "startup",
  "field_validation",
  "commercialization",
  "growth",
  "operation",
  "unknown"
]);

const V2_SAFE_INPUT_DIR = path.join(RUNTIME, "v2_safe_input");
const V2_PROGRAM_INDEX_PATH = path.join(ROOT, "program_index.json");
const V2_PROGRAMS_DIR = path.join(ROOT, "programs");
const V2_CANDIDATE_RETRIEVAL_DIR = path.join(RUNTIME, "v2_candidate_retrieval");
const V2_PIPELINE_RUNS_DIR = path.join(RUNTIME, "v2_pipeline_runs");
const V2_AI_MATCHER_PACKAGE_DIR = path.join(RUNTIME, "v2_ai_matcher_packages");
const V2_AI_MATCHER_PROMPT_DRAFT_PATH = path.join(ROOT, "V2_AI_MATCHER_PROMPT_DRAFT.md");
const V2_AI_MATCHER_OUTPUT_SCHEMA_DRAFT_PATH = path.join(ROOT, "V2_AI_MATCHER_OUTPUT_SCHEMA_DRAFT.json");
const FAST_MATCH_CARD_DB_PATH = path.join(ROOT, "fast_program_cards.refined.json");
const FAST_MATCH_CONTEXT_SCRIPT_PATH = path.join(ROOT, "generate_fast_match_context.js");
const FAST_KOREAN_BRIEFING_SCRIPT_PATH = path.join(ROOT, "generate_fast_korean_briefing.js");

const CORE_FIELDS = [
  "company_name_or_alias",
  "applicant_type",
  "establishment_date",
  "region",
  "industry_field",
  "product_tech_summary",
  "current_stage",
  "top_needs_or_pain_points",
  "government_support_restriction_status",
  "sme_status"
];

const CONDITIONAL_FIELDS = [
  "founder_representative_age_band",
  "venture_confirmation_status",
  "self_funding_or_cost_share",
  "schedule_readiness",
  "poc_or_testbed_experience",
  "investment_status",
  "overseas_expansion_intent",
  "public_procurement_intent",
  "free_form_company_note",
  "youth_preference_status"
];

const MATCHER_FIELD_ALIAS_MAP = {
  venture_confirmation_status: ["venture_confirmation_status", "venture_cert_status"],
  venture_cert_status: ["venture_confirmation_status", "venture_cert_status"],
  self_funding_or_cost_share: ["self_funding_or_cost_share", "self_funding_capacity"],
  self_funding_capacity: ["self_funding_or_cost_share", "self_funding_capacity"],
  self_funding_or_cost_share_status: ["self_funding_or_cost_share_status", "self_funding_or_cost_share", "self_funding_capacity"],
  business_age_category: ["business_age_category", "business_age"]
};

module.exports = {
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
};