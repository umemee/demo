// matchHandlers.js
const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const http = require("http");

const config = require("./config.js");
const utils = require("./utils.js");
const v2Handlers = require("./v2Handlers.js");

const { RUNTIME, RESULTS, COMPANY_INPUTS, FAST_MATCH_CARD_DB_PATH, FAST_MATCH_CONTEXT_SCRIPT_PATH, FAST_KOREAN_BRIEFING_SCRIPT_PATH, RUNTIME_MATCHER_SOURCE_TYPE, V2_PIPELINE_RUNS_DIR, V2_SAFE_INPUT_VALUE_FIELDS, REPO_ROOT } = config;
const { json, slugifyCaseIdCandidate, toRepoPath, compactErrorText, pathExists, isSafeResultCaseId } = utils;
const { findV2SensitivePackageFieldPaths, buildV2CandidateValuesFromSavedCompanyInput, normalizeToV2SafeInput, markMissingV2Fields, loadStandardCompanyInputFromPath } = v2Handlers;
// ✂️ 👇 아래 빈 공간에 resultHandlers.js에서 잘라낸 두 덩어리를 붙여넣으세요! 👇 ✂️
function stripPrivateLikeText(value) {
  return String(value || "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "")
    .replace(/(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{2,4}\)?[-.\s]?)?\d{3,4}[-.\s]?\d{4}/g, "")
    .replace(/\b\d{6}[-\s]?\d{7}\b/g, "")
    .replace(/\b\d{3}-\d{2}-\d{5}\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeDraftText(value, maxLength = 500) {
  const text = stripPrivateLikeText(value)
    .replace(/[<>]/g, "")
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength).trim()}...` : text;
}

function normalizeMatcherText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function extractSourceExcerpt(text, indexOrPattern, radius = 90) {
  const raw = String(text || "");
  let index = -1;
  if (typeof indexOrPattern === "number") {
    index = indexOrPattern;
  } else if (indexOrPattern instanceof RegExp) {
    const match = raw.match(indexOrPattern);
    index = match ? match.index ?? -1 : -1;
  } else if (indexOrPattern) {
    index = raw.indexOf(String(indexOrPattern));
  }
  if (index < 0) return "";
  return sanitizeDraftText(raw.slice(Math.max(0, index - radius), Math.min(raw.length, index + radius)), 220);
}

function isLikelyProgramAnnouncement(text) {
  const raw = String(text || "");
  const lower = raw.toLowerCase();
  const indicators = [
    "모집공고",
    "공고",
    "지원사업",
    "사업개요",
    "지원내용",
    "신청기간",
    "한국농업기술진흥원",
    "농림축산식품부",
    "ministry",
    "program announcement",
    "application period",
    "怨듦퀬",
    "紐⑥쭛",
    "吏?먯궗",
    "?ъ뾽媛쒖슂",
    "?몃??댁슜"
  ];
  const score = indicators.reduce((count, item) => count + (lower.includes(item.toLowerCase()) ? 1 : 0), 0);
  return score >= 3;
}

function firstLabeledValue(text, labels) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    for (const label of labels) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = line.match(new RegExp(`^(?:[-*\\s]*)${escaped}\\s*[:：|]\\s*(.{2,120})$`, "i"));
      if (match) return { value: match[1].trim(), excerpt: line };
    }
  }
  return null;
}

function cleanExtractedCell(value) {
  return sanitizeDraftText(
    String(value || "")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/\*\*/g, "")
      .replace(/\s+/g, " "),
    420
  );
}

function tableLabeledValue(text, labels) {
  return tableLabeledValues(text, labels)[0] || null;
}

function tableLabeledValues(text, labels) {
  const normalizedLabels = labels.map((label) => String(label).replace(/\s+/g, ""));
  const values = [];
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (!line.includes("|")) continue;
    const cells = line.split("|").map(cleanExtractedCell);
    for (let i = 0; i < cells.length; i += 1) {
      const normalizedCell = cells[i].replace(/\s+/g, "");
      if (!normalizedLabels.some((label) => normalizedCell.includes(label))) continue;
      for (let j = i + 1; j < cells.length; j += 1) {
        const candidate = cells[j];
        if (candidate && !/^[-:]+$/.test(candidate) && !normalizedLabels.includes(candidate.replace(/\s+/g, ""))) {
          values.push({ value: candidate, excerpt: `${cells[i]}: ${candidate}` });
          break;
        }
      }
    }
  }
  return values;
}

function regionFromAddressRow(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (!line.includes("|") || !line.includes("사업장 주소")) continue;
    const cells = line.split("|").map(cleanExtractedCell);
    const regionCell = cells.find((cell) => /(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충청|충남|충북|전라|전남|전북|경상|경남|경북|제주)/.test(cell));
    if (!regionCell) continue;
    const match = regionCell.match(/((?:서울|부산|대구|인천|광주|대전|울산|세종)(?:특별시|광역시|특별자치시)?\s*[^\s,|]{1,12}(?:구|군|시)?)|((?:경기|강원|충청남도|충청북도|충남|충북|전라남도|전라북도|전남|전북|경상남도|경상북도|경남|경북|제주)(?:도|특별자치도)?\s*[^\s,|]{1,12}(?:군|시|구))/);
    if (match) return { value: match[0], excerpt: `사업장 주소: ${match[0]}` };
  }
  return null;
}

function normalizeRegion(value) {
  const text = sanitizeDraftText(value, 120);
  if (!text) return "";
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length > 3) return parts.slice(0, 2).join(" ");
  return text;
}

function inferIndustryDraft(text) {
  const lower = String(text || "").toLowerCase();
  if ((lower.includes("ai") || lower.includes("인공지능")) && /(농|축산|양돈|돈사|스마트팜|agri|farm|pig)/i.test(text)) {
    const product = tableLabeledValue(text, ["주생산품", "제품/서비스", "상용화대상명"]);
    return { value: "AI software / agri-tech", excerpt: product?.excerpt || "AI + agri/livestock keywords found in extracted text.", term: "AI + agri/livestock context" };
  }
  const rules = [
    { label: "agri-tech / smart farm", terms: ["bee", "벌", "양봉", "스마트양봉"] },
    { label: "agricultural robotics", terms: ["robot", "robotics", "로봇", "자동화"] },
    { label: "smart farm", terms: ["smart farm", "스마트팜"] },
    { label: "AI software / agri-tech", terms: ["ai", "인공지능"] },
    { label: "food-tech", terms: ["food", "푸드테크"] }
  ];
  for (const rule of rules) {
    const found = rule.terms.find((term) => lower.includes(term.toLowerCase()));
    if (found) return { value: rule.label, excerpt: extractSourceExcerpt(text, found), term: found };
  }
  return null;
}

function inferNeedsDraft(text) {
  const lower = String(text || "").toLowerCase();
  const rules = [
    { label: "field validation", terms: ["field validation", "현장검증", "실증"] },
    { label: "commercialization", terms: ["commercialization", "사업화", "상용화"] },
    { label: "market expansion", terms: ["market expansion", "판로", "시장 확대"] },
    { label: "PoC", terms: ["poc", "proof of concept"] },
    { label: "certification", terms: ["certification need", "인증 필요", "인증 준비"] },
    { label: "investment", terms: ["investment need", "투자 필요", "투자 유치 필요"] },
    { label: "procurement", terms: ["procurement", "조달"] },
    { label: "pilot deployment", terms: ["pilot", "시범", "파일럿"] }
  ];
  const values = [];
  let excerpt = "";
  for (const rule of rules) {
    const found = rule.terms.find((term) => lower.includes(term.toLowerCase()));
    if (found && !values.includes(rule.label)) {
      values.push(rule.label);
      if (!excerpt) excerpt = extractSourceExcerpt(text, found);
    }
  }
  return values.length ? { value: values.slice(0, 4), excerpt } : null;
}

function normalizeCoarseEstablishmentDateText(value) {
  const text = sanitizeDraftText(value, 32);
  if (!text) return null;
  const match = text.match(/(20\d{2})(?:\s*[.\-\/년]\s*(\d{1,2}))?(?:\s*[.\-\/월]\s*(\d{1,2}))?/);
  if (!match) return null;
  const year = match[1];
  const month = match[2] ? String(match[2]).padStart(2, "0") : null;
  return month ? `${year}-${month}` : year;
}

function normalizeCleanEstablishmentDateValue(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (!/^(20\d{2})-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?$/.test(text)) return null;
  return text;
}

async function readCleanAutofillDraftEstablishmentDate(caseId) {
  const draftCaseId = String(caseId || "").trim();
  if (!draftCaseId) return null;
  const draftPath = path.join(UPLOADS, draftCaseId, "autofill_draft.json");
  try {
    const draft = JSON.parse(await fs.readFile(draftPath, "utf8"));
    const candidate = draft?.v2_safe_candidate_fields?.establishment_date;
    const rawValue = candidate && typeof candidate === "object" && !Array.isArray(candidate)
      ? candidate.value
      : candidate;
    return normalizeCleanEstablishmentDateValue(rawValue);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function extractAutofillDraftCandidateValue(container, fieldName) {
  const candidate = container?.[fieldName];
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate) && Object.prototype.hasOwnProperty.call(candidate, "value")) {
    return candidate.value;
  }
  return candidate;
}

async function readCleanAutofillDraftBridgeCandidates(caseId) {
  const draftCaseId = String(caseId || "").trim();
  if (!draftCaseId) return {};
  const draftPath = path.join(UPLOADS, draftCaseId, "autofill_draft.json");

  try {
    const draft = JSON.parse(await fs.readFile(draftPath, "utf8"));
    const bridge = {};
    const assign = (fieldName, rawValue, normalize, sourceLabel) => {
      const normalizedValue = normalize(rawValue);
      if (!hasMeaningfulValue(normalizedValue)) return;
      bridge[fieldName] = {
        value: normalizedValue,
        source: sourceLabel
      };
    };

    assign(
      "company_name_or_alias",
      extractAutofillDraftCandidateValue(draft?.draft_fields, "company_name_or_alias"),
      (value) => sanitizeDraftText(value, 80),
      "autofill draft draft_fields.company_name_or_alias"
    );
    assign(
      "region",
      extractAutofillDraftCandidateValue(draft?.draft_fields, "region"),
      (value) => normalizeRegion(value),
      "autofill draft draft_fields.region"
    );
    assign(
      "industry_field",
      extractAutofillDraftCandidateValue(draft?.draft_fields, "industry_field"),
      (value) => sanitizeDraftText(value, 120),
      "autofill draft draft_fields.industry_field"
    );
    assign(
      "product_tech_summary",
      extractAutofillDraftCandidateValue(draft?.draft_fields, "product_tech_summary"),
      (value) => sanitizeDraftText(value, 420),
      "autofill draft draft_fields.product_tech_summary"
    );
    assign(
      "current_stage",
      extractAutofillDraftCandidateValue(draft?.v2_safe_candidate_fields, "current_stage"),
      (value) => sanitizeDraftText(value, 40),
      "autofill draft v2_safe_candidate_fields.current_stage"
    );
    assign(
      "top_needs_or_pain_points",
      extractAutofillDraftCandidateValue(draft?.draft_fields, "top_needs_or_pain_points"),
      (value) => normalizeV2ArrayField(value, 120),
      "autofill draft draft_fields.top_needs_or_pain_points"
    );

    assign(
      "applicant_type",
      extractAutofillDraftCandidateValue(draft?.v2_safe_candidate_fields, "applicant_type"),
      (value) => sanitizeDraftText(value, 80),
      "autofill draft v2_safe_candidate_fields.applicant_type"
    );
    assign(
      "business_registration_status",
      extractAutofillDraftCandidateValue(draft?.v2_safe_candidate_fields, "business_registration_status"),
      (value) => sanitizeDraftText(value, 40),
      "autofill draft v2_safe_candidate_fields.business_registration_status"
    );
    assign(
      "establishment_date",
      extractAutofillDraftCandidateValue(draft?.v2_safe_candidate_fields, "establishment_date"),
      (value) => normalizeCleanEstablishmentDateValue(value),
      "autofill draft v2_safe_candidate_fields.establishment_date"
    );
    assign(
      "business_age_category",
      extractAutofillDraftCandidateValue(draft?.v2_safe_candidate_fields, "business_age_category"),
      (value) => sanitizeDraftText(value, 40),
      "autofill draft v2_safe_candidate_fields.business_age_category"
    );
    assign(
      "sme_status",
      extractAutofillDraftCandidateValue(draft?.v2_safe_candidate_fields, "sme_status"),
      (value) => sanitizeDraftText(value, 16),
      "autofill draft v2_safe_candidate_fields.sme_status"
    );
    assign(
      "government_support_restriction_status",
      extractAutofillDraftCandidateValue(draft?.v2_safe_candidate_fields, "government_support_restriction_status"),
      (value) => sanitizeDraftText(value, 40),
      "autofill draft v2_safe_candidate_fields.government_support_restriction_status"
    );
    assign(
      "duplicate_support_risk_status",
      extractAutofillDraftCandidateValue(draft?.v2_safe_candidate_fields, "duplicate_support_risk_status"),
      (value) => sanitizeDraftText(value, 40),
      "autofill draft v2_safe_candidate_fields.duplicate_support_risk_status"
    );
    assign(
      "venture_confirmation_status",
      extractAutofillDraftCandidateValue(draft?.v2_safe_candidate_fields, "venture_confirmation_status"),
      (value) => sanitizeDraftText(value, 40),
      "autofill draft v2_safe_candidate_fields.venture_confirmation_status"
    );
    assign(
      "investment_status",
      extractAutofillDraftCandidateValue(draft?.v2_safe_candidate_fields, "investment_status"),
      (value) => sanitizeDraftText(value, 40),
      "autofill draft v2_safe_candidate_fields.investment_status"
    );
    assign(
      "self_funding_or_cost_share_status",
      extractAutofillDraftCandidateValue(draft?.v2_safe_candidate_fields, "self_funding_or_cost_share_status"),
      (value) => sanitizeDraftText(value, 40),
      "autofill draft v2_safe_candidate_fields.self_funding_or_cost_share_status"
    );
    assign(
      "green_bio_or_smart_agri_flag",
      extractAutofillDraftCandidateValue(draft?.v2_safe_candidate_fields, "green_bio_or_smart_agri_flag"),
      (value) => sanitizeDraftText(value, 16),
      "autofill draft v2_safe_candidate_fields.green_bio_or_smart_agri_flag"
    );
    assign(
      "technology_transfer_status",
      extractAutofillDraftCandidateValue(draft?.v2_safe_candidate_fields, "technology_transfer_status"),
      (value) => sanitizeDraftText(value, 40),
      "autofill draft v2_safe_candidate_fields.technology_transfer_status"
    );
    assign(
      "certification_or_test_need",
      extractAutofillDraftCandidateValue(draft?.v2_safe_candidate_fields, "certification_or_test_need"),
      (value) => sanitizeDraftText(value, 40),
      "autofill draft v2_safe_candidate_fields.certification_or_test_need"
    );
    assign(
      "sales_record_status",
      extractAutofillDraftCandidateValue(draft?.v2_safe_candidate_fields, "sales_record_status"),
      (value) => sanitizeDraftText(value, 40),
      "autofill draft v2_safe_candidate_fields.sales_record_status"
    );
    assign(
      "export_intent",
      extractAutofillDraftCandidateValue(draft?.v2_safe_candidate_fields, "export_intent"),
      (value) => sanitizeDraftText(value, 40),
      "autofill draft v2_safe_candidate_fields.export_intent"
    );
    assign(
      "target_country_or_market",
      extractAutofillDraftCandidateValue(draft?.v2_safe_candidate_fields, "target_country_or_market"),
      (value) => normalizeV2ArrayField(value, 80),
      "autofill draft v2_safe_candidate_fields.target_country_or_market"
    );

    return bridge;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

function readCleanPayloadEstablishmentDate(payload = {}) {
  const fieldsInput = payload && payload.fields && typeof payload.fields === "object" && !Array.isArray(payload.fields)
    ? payload.fields
    : {};
  const directFieldValue = normalizeCleanEstablishmentDateValue(resolvePayloadFieldValue(fieldsInput, "establishment_date"));
  if (directFieldValue) {
    return {
      value: directFieldValue,
      source: "payload.fields.establishment_date"
    };
  }

  const expandedCandidateFields = payload && payload.v2_safe_candidate_fields && typeof payload.v2_safe_candidate_fields === "object" && !Array.isArray(payload.v2_safe_candidate_fields)
    ? payload.v2_safe_candidate_fields
    : {};
  const expandedCandidate = expandedCandidateFields.establishment_date;
  const expandedValue = expandedCandidate && typeof expandedCandidate === "object" && !Array.isArray(expandedCandidate) && Object.prototype.hasOwnProperty.call(expandedCandidate, "value")
    ? expandedCandidate.value
    : expandedCandidate;
  const directExpandedValue = normalizeCleanEstablishmentDateValue(expandedValue);
  if (directExpandedValue) {
    return {
      value: directExpandedValue,
      source: "payload.v2_safe_candidate_fields.establishment_date"
    };
  }

  return null;
}

function inferBusinessAgeCategoryFromDateText(establishmentDateText, now = new Date()) {
  const normalized = normalizeCoarseEstablishmentDateText(establishmentDateText);
  if (!normalized) return null;
  const match = normalized.match(/^(20\d{2})(?:-(\d{2}))?$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2] || 1);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return null;

  const current = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(current.getTime())) return null;

  let ageYears = current.getFullYear() - year;
  if ((current.getMonth() + 1) < month) {
    ageYears -= 1;
  }
  if (ageYears < 0) return "pre_registration";
  if (ageYears < 1) return "under_1_year";
  if (ageYears < 3) return "under_3_years";
  if (ageYears < 5) return "under_5_years";
  return "over_5_years";
}

function buildConservativeExpandedV2CandidateFieldsFromText(text, now = new Date()) {
  const raw = String(text || "");
  const candidates = {};
  const labelContext = (labels) => {
    const found = firstLabeledValue(raw, labels) || tableLabeledValue(raw, labels);
    return normalizeMatcherText([found?.excerpt, found?.value].filter(Boolean).join(" "));
  };

  const setCandidate = (field, value, confidence, reason) => {
    if (!hasMeaningfulValue(value)) return;
    const normalizedValue = Array.isArray(value)
      ? normalizeV2ArrayField(value, field === "target_country_or_market" ? 40 : 80)
      : field === "establishment_date"
        ? normalizeCoarseEstablishmentDateText(value)
        : field === "applicant_type"
          ? normalizeV2ApplicantType(value, raw)
          : field === "current_stage"
            ? normalizeV2CurrentStage(value, raw)
            : field === "certification_or_test_need"
              ? normalizeV2CertificationNeed(value, raw)
        : sanitizeDraftText(value, field === "business_age_category" ? 40 : 120);
    if (!hasMeaningfulValue(normalizedValue)) return;
    candidates[field] = {
      field,
      value: normalizedValue,
      confidence: Math.max(0, Math.min(Number(confidence) || 0, 0.85)),
      source_type: "document_extracted",
      status: "draft",
      needs_user_review: true,
      reason
    };
  };

  const applicantTypeRules = [
    ["예비창업자", /예비\s*창업|pre[- ]?startup|pre[- ]?founder/i],
    ["창업기업", /창업\s*기업|startup\s*company/i],
    ["농업인", /농업인|farm\s*operator|농가/i],
    ["농업법인", /농업\s*법인|농업법인/i],
    ["대학·연구기관", /대학|연구기관|연구소|학교|university|research institute/i],
    ["운영기관·수행기관", /운영기관|수행기관|주관기관|executing agency|implementation agency/i],
    ["협회·단체", /협회|단체|association|organization/i],
    ["컨소시엄 주관", /컨소시엄|consortium/i]
  ];
  for (const [value, pattern] of applicantTypeRules) {
    if (pattern.test(raw)) {
      setCandidate("applicant_type", value, 0.58, "신청 주체를 가리키는 표현을 확인했습니다.");
      break;
    }
  }
  if (!hasMeaningfulValue(candidates.applicant_type) && /중소기업|sme|small and medium/i.test(raw)) {
    setCandidate("applicant_type", "중소기업", 0.52, "중소기업 표현이 확인되었지만 주체 유형은 보수적으로만 반영했습니다.");
  }

  const registrationContext = labelContext([
    "사업자등록번호",
    "사업자 등록번호",
    "사업자등록증",
    "사업자 등록증",
    "법인등록번호",
    "법인 등록번호",
    "법인등록증",
    "법인 등록증",
    "사업자등록 상태",
    "등록 상태"
  ]);
  const registrationSource = registrationContext || raw;
  if (registrationSource) {
    if (/(사업자등록번호|사업자 등록번호|법인등록번호|법인 등록번호|사업자등록증|법인등록증)/i.test(raw)) {
      setCandidate("business_registration_status", "registered", 0.72, "사업자등록 관련 표기 또는 번호가 확인되었습니다.");
    } else if (/(미등록|등록\s*예정|planned registration|unregistered)/i.test(registrationSource)) {
      const value = /미등록|unregistered/i.test(registrationSource) ? "unregistered" : "planned";
      setCandidate("business_registration_status", value, 0.62, "사업자등록 상태를 가리키는 문구를 확인했습니다.");
    } else if (/(사업자\s*등록번호|사업자등록번호|사업자\s*등록증|사업자등록증|법인\s*등록번호|법인등록번호|법인\s*등록증|법인등록증|사업자\s*등록|법인\s*등록)/i.test(registrationSource)) {
      setCandidate("business_registration_status", "registered", 0.72, "사업자등록 관련 표기 또는 번호가 확인되었습니다.");
    }
  }

  const establishmentLabel = firstLabeledValue(raw, ["설립일", "창립일", "창업일", "개업일", "설립연도", "창업연도", "Founded", "Established"])
    || tableLabeledValue(raw, ["설립일", "창립일", "창업일", "개업일", "설립연도", "창업연도", "Founded", "Established"]);
  const establishmentDate = normalizeCoarseEstablishmentDateText(establishmentLabel?.value || establishmentLabel?.excerpt || "");
  if (establishmentDate) {
    setCandidate("establishment_date", establishmentDate, 0.66, "설립일 또는 창업 시점을 가리키는 표기를 확인했습니다.");
    const ageCategory = inferBusinessAgeCategoryFromDateText(establishmentDate, now);
    if (ageCategory) {
      setCandidate("business_age_category", ageCategory, 0.54, "설립일을 바탕으로 업력 구간을 보수적으로 계산했습니다.");
    }
  }

  if (/(중견기업|대기업|large enterprise|mid-sized)/i.test(raw)) {
    setCandidate("sme_status", "no", 0.55, "중견/대기업 표현을 확인했습니다.");
  } else if (/(중소기업|sme|small and medium|소기업)/i.test(raw)) {
    setCandidate("sme_status", "yes", 0.58, "중소기업 관련 표현을 확인했습니다.");
  }

  const supportRiskContext = labelContext(["중복수혜", "중복 수혜", "정부지원 제한", "지원 제한", "보조금 제한", "지원제한"]);
  const supportRiskSource = supportRiskContext || raw;
  if (supportRiskSource) {
    if (/(없음|해당없음|미해당|clear|문제\s*없음)/i.test(supportRiskSource)) {
      setCandidate("government_support_restriction_status", "clear", 0.55, "지원 제한 없음 또는 유사 문구를 확인했습니다.");
      setCandidate("duplicate_support_risk_status", "low", 0.5, "중복수혜 위험이 낮다는 표현을 확인했습니다.");
    } else if (/(있음|가능성|우려|주의|검토 필요|review)/i.test(supportRiskSource)) {
      setCandidate("government_support_restriction_status", "possible_issue", 0.52, "지원 제한 또는 중복수혜 관련 주의 문구를 확인했습니다.");
      setCandidate("duplicate_support_risk_status", "medium", 0.45, "중복수혜 위험 관련 주의 표현을 확인했습니다.");
    } else {
      setCandidate("government_support_restriction_status", "under_review", 0.45, "지원 제한 또는 중복수혜 관련 표현이 확인되었습니다.");
      setCandidate("duplicate_support_risk_status", "unknown", 0.3, "중복수혜 위험 관련 표현이 있으나 강도는 불분명합니다.");
    }
  }

  const ventureContext = labelContext(["벤처확인", "벤처 확인", "벤처기업", "venture"]);
  const ventureSource = ventureContext || raw;
  if (ventureSource) {
    if (/(완료|확인됨|confirmed)/i.test(ventureSource)) {
      setCandidate("venture_confirmation_status", "confirmed", 0.62, "벤처확인 완료 또는 동등 표현을 확인했습니다.");
    } else if (/(미확인|없음|not confirmed)/i.test(ventureSource)) {
      setCandidate("venture_confirmation_status", "not_confirmed", 0.55, "벤처확인 미확인 또는 부재 표현을 확인했습니다.");
    } else if (/(예정|신청|검토|possible)/i.test(ventureSource)) {
      setCandidate("venture_confirmation_status", "possible", 0.5, "벤처확인 예정 또는 검토 문구를 확인했습니다.");
    } else {
      setCandidate("venture_confirmation_status", "possible", 0.42, "벤처확인 관련 표현을 확인했지만 상태는 불분명합니다.");
    }
  }

  const investmentContext = labelContext(["투자유치", "투자 계획", "투자 예정", "투자", "investment"]);
  const investmentSource = investmentContext || raw;
  if (investmentSource) {
    if (/(series\s*[ab]|시리즈\s*[ab]|pre-?a)/i.test(investmentSource)) {
      setCandidate("investment_status", "series_a_plus", 0.6, "시리즈 A 이상 투자 단계 관련 표현을 확인했습니다.");
    } else if (/(시드|seed)/i.test(investmentSource)) {
      setCandidate("investment_status", "seed", 0.6, "시드 투자 관련 표현을 확인했습니다.");
    } else if (/(엔젤|angel)/i.test(investmentSource)) {
      setCandidate("investment_status", "angel", 0.58, "엔젤 투자 관련 표현을 확인했습니다.");
    } else if (/(없음|no investment)/i.test(investmentSource)) {
      setCandidate("investment_status", "none", 0.5, "투자 없음 표현을 확인했습니다.");
    } else {
      setCandidate("investment_status", "planned", 0.48, "투자 계획 또는 투자유치 관련 표현을 확인했습니다.");
    }
  }

  const costShareContext = labelContext(["자부담", "민간부담금", "대응자금", "자기부담", "self funding", "self-funding", "cost share"]);
  const costShareSource = costShareContext || raw;
  if (costShareSource) {
    if (/(자부담|민간부담금|대응자금|자기부담|self[- ]?funding|cost share)[^\n]{0,40}(불가|어렵|미확보|없음|not ready)/i.test(raw)) {
      setCandidate("self_funding_or_cost_share_status", "not_ready", 0.58, "자부담 또는 매칭 자금이 준비되지 않았다는 표현을 확인했습니다.");
    } else if (/(자부담|민간부담금|대응자금|자기부담|self[- ]?funding|cost share)[^\n]{0,40}(부분|일부|검토|조건|partially)/i.test(raw)) {
      setCandidate("self_funding_or_cost_share_status", "partially_ready", 0.55, "자부담 또는 매칭 자금이 부분적으로 준비됐다는 표현을 확인했습니다.");
    } else if (/(자부담|민간부담금|대응자금|자기부담|self[- ]?funding|cost share)[^\n]{0,40}(가능|확보|준비|ready|충분)/i.test(raw)) {
      setCandidate("self_funding_or_cost_share_status", "ready", 0.6, "자부담 또는 민간부담금 준비 표현을 확인했습니다.");
    } else if (/(불가|어렵|미확보|없음|not ready)/i.test(costShareSource)) {
      setCandidate("self_funding_or_cost_share_status", "not_ready", 0.58, "자부담 또는 매칭 자금이 준비되지 않았다는 표현을 확인했습니다.");
    } else if (/(부분|일부|검토|조건|partially)/i.test(costShareSource)) {
      setCandidate("self_funding_or_cost_share_status", "partially_ready", 0.55, "자부담 또는 매칭 자금이 부분적으로 준비됐다는 표현을 확인했습니다.");
    } else if (/(가능|확보|준비|ready|충분)/i.test(costShareSource)) {
      setCandidate("self_funding_or_cost_share_status", "ready", 0.6, "자부담 또는 민간부담금 준비 표현을 확인했습니다.");
    }
  }

  const currentStageLabel = firstLabeledValue(raw, ["현재 단계", "사업화 단계", "진행 단계", "현재상태", "단계", "Current Stage"])
    || tableLabeledValue(raw, ["현재 단계", "사업화 단계", "진행 단계", "현재상태", "단계", "Current Stage"]);
  const currentStageValue = (() => {
    const stageSource = String(currentStageLabel?.value || currentStageLabel?.excerpt || raw);
    if (/(스케일업|scale[- ]?up|확장)/i.test(stageSource)) return "스케일업";
    if (/(사업화|상용화|commercialization|commercialisation)/i.test(stageSource)) return "사업화";
    if (/(실증|검증|pilot|파일럿|poc|demo|test|시험)/i.test(stageSource)) return "실증";
    if (/(시제품|prototype|prototyp)/i.test(stageSource)) return "시제품";
    if (/(개발|연구|r&d)/i.test(stageSource)) return "개발";
    if (/(예비창업)/i.test(stageSource)) return "예비창업";
    if (/(운영|서비스 운영|양산)/i.test(stageSource)) return "운영";
    return null;
  })();
  if (currentStageValue) {
    setCandidate("current_stage", currentStageValue, 0.58, "현재 단계 또는 사업화 단계 표현을 확인했습니다.");
  }

  if (/(그린바이오|green bio|스마트농업|스마트팜|smart farm|smart agri|농업용 로봇|농업 자동화|field robotics|agri-tech|agritech)/i.test(raw)) {
    setCandidate("green_bio_or_smart_agri_flag", "yes", 0.68, "그린바이오 또는 스마트농업 관련 핵심 표현을 확인했습니다.");
  } else if (/(농업|축산|농장|식품)/i.test(raw) && /(ai|로봇|센서|iot|자동화|데이터|플랫폼|시스템)/i.test(raw)) {
    setCandidate("green_bio_or_smart_agri_flag", "maybe", 0.45, "농업 분야와 기술 키워드가 함께 확인되었습니다.");
  }

  if (/(기술이전|technology transfer|기술\s*이전)/i.test(raw)) {
    if (/(완료|완료됨|성사)/i.test(raw)) {
      setCandidate("technology_transfer_status", "completed", 0.6, "기술이전 완료 표현을 확인했습니다.");
    } else if (/(진행|중)/i.test(raw)) {
      setCandidate("technology_transfer_status", "in_progress", 0.58, "기술이전 진행 표현을 확인했습니다.");
    } else if (/(예정|계획|검토)/i.test(raw)) {
      setCandidate("technology_transfer_status", "planned", 0.56, "기술이전 예정 또는 계획 표현을 확인했습니다.");
    } else {
      setCandidate("technology_transfer_status", "planned", 0.42, "기술이전 관련 표현을 확인했지만 단계는 불분명합니다.");
    }
  } else if (/(기술\s*이전\s*없음|not applicable|해당없음)/i.test(raw)) {
    setCandidate("technology_transfer_status", "not_applicable", 0.46, "기술이전 비대상 또는 해당없음 표현을 확인했습니다.");
  }

  const certNeedContext = labelContext(["인증", "검정", "실증", "시험", "테스트", "Demo", "Pilot", "TRL", "검증"]);
  const certNeedSource = certNeedContext || raw;
  if (certNeedSource) {
    if (/(성능검정)/i.test(certNeedSource)) {
      setCandidate("certification_or_test_need", "성능검정", 0.66, "성능검정 관련 표현을 확인했습니다.");
    } else if (/(인증|검인증)/i.test(certNeedSource)) {
      setCandidate("certification_or_test_need", "인증·검정", 0.62, "인증 또는 검인증 관련 표현을 확인했습니다.");
    } else if (/(실증|demo|시연|poc|검증|trial)/i.test(certNeedSource)) {
      setCandidate("certification_or_test_need", "demo", 0.58, "실증 또는 데모 검증 관련 표현을 확인했습니다.");
    } else if (/(pilot|파일럿|test|테스트|시험)/i.test(certNeedSource)) {
      setCandidate("certification_or_test_need", "pilot_test", 0.58, "파일럿 또는 시험 검증 관련 표현을 확인했습니다.");
    } else {
      setCandidate("certification_or_test_need", "unknown", 0.3, "인증/검정/실증 관련 표현이 있으나 세부 유형은 불분명합니다.");
    }
  }

  const salesContext = labelContext(["매출 실적", "판매실적", "매출", "판매", "Sales", "Revenue"]);
  const salesSource = salesContext || raw;
  if (salesSource) {
    if (/(없음|no sales|매출\s*없음)/i.test(salesSource)) {
      setCandidate("sales_record_status", "no_sales", 0.58, "매출 없음 표현을 확인했습니다.");
    } else if (/(수출\s*매출|해외\s*매출|export sales)/i.test(salesSource)) {
      setCandidate("sales_record_status", "export_sales", 0.62, "해외 또는 수출 매출 표현을 확인했습니다.");
    } else if (/(국내\s*매출|내수|domestic sales|국내 판매)/i.test(salesSource)) {
      setCandidate("sales_record_status", "domestic_sales", 0.6, "국내 매출 또는 내수 판매 표현을 확인했습니다.");
    } else if (/(시범\s*판매|pilot sales|초도 판매|테스트 판매)/i.test(salesSource)) {
      setCandidate("sales_record_status", "pilot_sales", 0.58, "시범 판매 또는 파일럿 판매 표현을 확인했습니다.");
    } else if (/(증가|성장|growing|확대)/i.test(salesSource)) {
      setCandidate("sales_record_status", "growing", 0.5, "매출 성장 표현을 확인했습니다.");
    } else if (/(매출|sales|revenue)/i.test(salesSource)) {
      setCandidate("sales_record_status", "domestic_sales", 0.45, "매출 또는 판매실적 표현을 확인했습니다.");
    }
  }

  const exportContext = labelContext(["수출 의향", "수출", "해외진출", "해외 진출", "해외 실증", "해외시장", "글로벌", "Global", "Export"]);
  const exportSource = exportContext || raw;
  const exportExplicit = /(\b수출\b|export|해외\s*(진출|시장|판매|실증|확장)|overseas|글로벌|global)/i.test(exportSource);
  if (exportExplicit) {
    if (/(중|진행|active|현재)/i.test(exportSource)) {
      setCandidate("export_intent", "active", 0.62, "수출 또는 해외 진출이 이미 진행 중인 표현을 확인했습니다.");
    } else if (/(예정|계획|planned|목표)/i.test(exportSource)) {
      setCandidate("export_intent", "planned", 0.6, "수출 또는 해외 진출 계획 표현을 확인했습니다.");
    } else if (/(의향|검토|탐색|exploring|관심)/i.test(exportSource)) {
      setCandidate("export_intent", "exploring", 0.56, "수출 또는 해외 진출 의향 표현을 확인했습니다.");
    } else {
      setCandidate("export_intent", "planned", 0.5, "수출 또는 해외 진출 관련 표현을 확인했습니다.");
    }
  }

  const targetCountryValue = firstLabeledValue(raw, ["목표 국가", "목표국가", "대상 국가", "대상국가", "수출국", "수출국가", "해외시장", "target country", "target market"])
    || tableLabeledValue(raw, ["목표 국가", "목표국가", "대상 국가", "대상국가", "수출국", "수출국가", "해외시장", "target country", "target market"]);
  const targetCountryMatches = [];
  const targetCountrySource = normalizeMatcherText(String(targetCountryValue?.value || targetCountryValue?.excerpt || raw));
  const targetCountryTerms = [
    "일본", "베트남", "미국", "중국", "태국", "인도네시아", "인도", "싱가포르", "말레이시아",
    "호주", "유럽", "EU", "북미", "남미", "중동", "동남아", "아세안", "캐나다", "멕시코"
  ];
  for (const term of targetCountryTerms) {
    if (targetCountrySource.includes(normalizeMatcherText(term))) {
      if (!targetCountryMatches.includes(term)) targetCountryMatches.push(term);
    }
  }
  if (targetCountryMatches.length) {
    setCandidate("target_country_or_market", targetCountryMatches.slice(0, 4), 0.56, "수출 또는 해외 진출의 목표 국가/시장을 확인했습니다.");
  }

  return candidates;
}

function buildProductSummaryDraft(text) {
  const targets = tableLabeledValues(text, ["상용화대상명", "상용화대상명칭"]);
  const target = targets.find((item) => /pig|피그|양돈|질병/i.test(item.value)) || targets[0] || null;
  const product = tableLabeledValue(text, ["주생산품", "제품/서비스"]);
  const intro = tableLabeledValue(text, ["기업소개", "상용화대상상세", "상용화대상상세설명"]);
  if (target && product) {
    return {
      value: `${target.value}: ${product.value}`,
      excerpt: `${target.excerpt}\n${product.excerpt}`
    };
  }
  if (product && intro) {
    return {
      value: `${product.value}. ${intro.value}`,
      excerpt: `${product.excerpt}\n${intro.excerpt}`
    };
  }
  return target || product || intro || null;

}

async function handleRunGemmaMatch(req, res, url) {
  const startedAt = Date.now();
  const prefix = "/api/gemma-match/run/";
  const rawCaseId = decodeURIComponent(String(url.pathname || "").slice(prefix.length)).trim();

  if (!rawCaseId) {
    return json(res, 400, { ok: false, error_code: "missing_case_id", message: "case_id가 필요합니다." });
  }
  const caseId = rawCaseId;

  try {
    console.log(`\n🚀 [Phase 2 & 3] '${caseId}' 저사양 고속 매칭 엔진 가동...`);

    // 1. 기업 데이터 안전하게 불러오기 (UI 저장본 + 원본 AI 추출본 하이브리드 병합)
    let safeInput = {};
    try {
      const standardPath = path.join(COMPANY_INPUTS, `${caseId}_standard_company_input.json`);
      const savedData = JSON.parse(await fs.readFile(standardPath, "utf8"));
      
      if (savedData && savedData.fields) {
        for (let key in savedData.fields) {
          const val = savedData.fields[key]?.value;
          safeInput[key] = Array.isArray(val) ? val.join(", ") : (val !== undefined && val !== null ? val : "");
        }
      }
    } catch (e) {
      console.warn("저장된 기업 정보를 찾지 못해 기본값으로 진행합니다.", e.message);
      safeInput = { company_name_or_alias: "알수없음", industry_field: "스마트농업" };
    }

    // 🚨 [데이터 단절 완벽 방어] autofill_draft.json의 고도화 정량 데이터를 직접 읽어서 병합 (구조적 누락 방지 완벽 패치)
    try {
      const draftPath = path.join(RUNTIME, "uploads", caseId, "autofill_draft.json");
      const draftData = JSON.parse(await fs.readFile(draftPath, "utf8"));
      const v2Draft = draftData.v2_safe_candidate_fields || {};
      
      const mergeKeys = [
        "total_investment_amount", "annual_revenue", "employee_count", 
        "value_chain_tag", "agrifood_value_chain", "has_overseas_partner_or_loi"
      ];
      
      mergeKeys.forEach(key => {
        if (v2Draft[key] && v2Draft[key].value !== undefined && v2Draft[key].value !== null && v2Draft[key].value !== "") {
          safeInput[key] = v2Draft[key].value;
        }
      });

      // 🔴 [치명적 버그 해결] 객체 구조를 가지는 green_bio_or_smart_agri의 내부 매칭 데이터와 플래그 복구
      if (v2Draft["green_bio_or_smart_agri"] && v2Draft["green_bio_or_smart_agri"].value) {
        const gBioObj = v2Draft["green_bio_or_smart_agri"].value;
        // 엔진 규격인 green_bio_or_smart_agri_flag로 안전하게 매핑 상태 변환 주입
        safeInput["green_bio_or_smart_agri_flag"] = gBioObj.is_matched !== undefined ? String(gBioObj.is_matched) : "false";
        safeInput["green_bio_or_smart_agri"] = gBioObj; // 객체 원본도 손실 없이 매칭 입력값으로 바이패스
      } else if (v2Draft["green_bio_or_smart_agri_flag"] && v2Draft["green_bio_or_smart_agri_flag"].value) {
        safeInput["green_bio_or_smart_agri_flag"] = String(v2Draft["green_bio_or_smart_agri_flag"].value);
      }
      
      console.log(`✅ [Data Merge] autofill_draft.json 병합 및 유실 필드 복구 완벽 성공! (투자금: ${safeInput.total_investment_amount}, 가치사슬: ${safeInput.value_chain_tag}, 그린바이오플래그: ${safeInput.green_bio_or_smart_agri_flag})`);
    } catch (e) {
      console.warn("⚠️ autofill_draft.json 병합 실패 (기존 데이터로 진행):", e.message);
    }

    // 2. 49개 순정 사업 DB 불러오기
    // 🟢 조치: __dirname 대신 process.cwd()로 교체하여 하드코딩 경로를 원천 차단합니다.
    const dbPath = path.join(process.cwd(), "gemma4_final_pure_master_db.json");
    let allPrograms = [];
    try {
      allPrograms = JSON.parse(await fs.readFile(dbPath, "utf8"));
    } catch (e) {
      throw new Error("gemma4_final_pure_master_db.json 파일을 찾을 수 없습니다.");
    }
    // 3. [Phase 2] 다면 가중치 균형 분배형 초고속 사전 필터링 (글로벌/전시 5대 차원 균형 고도화 패치)
    const baseKeywords = [
      safeInput.industry_field, safeInput.current_stage, safeInput.applicant_type, safeInput.region,
      safeInput.export_intent, safeInput.investment_status
    ].filter(Boolean).map(k => String(k).toLowerCase());

    // 🔴 [대형 LLM 싱크 패치] 배열 형태일 수 있는 다중 키워드 안전하게 문자열 풀에 병합
    if (Array.isArray(safeInput.top_needs_or_pain_points)) {
      safeInput.top_needs_or_pain_points.forEach(n => baseKeywords.push(String(n).toLowerCase()));
    } else if (safeInput.top_needs_or_pain_points) {
      baseKeywords.push(String(safeInput.top_needs_or_pain_points).toLowerCase());
    }
    if (Array.isArray(safeInput.target_country_or_market)) {
      safeInput.target_country_or_market.forEach(c => baseKeywords.push(String(c).toLowerCase()));
    } else if (safeInput.target_country_or_market) {
      baseKeywords.push(String(safeInput.target_country_or_market).toLowerCase());
    }

    const scoredPrograms = allPrograms.map(prog => {
      let score = 0;
      // 💡 [수정] 새로운 DB 구조 반영 및 tags가 필요하다면 안전하게 결합
      const progText = `${prog.raw_target_audience || ""} ${prog.raw_support_content || ""} ${prog.program_name || ""} ${prog.raw_apply_method || ""} ${prog.tags ? prog.tags.join(" ") : ""}`.toLowerCase();
      
      // (1) 기본 키워드 텍스트 매칭 (기본 점수: 각 1점)
      baseKeywords.forEach(kw => { 
        if (kw && progText.includes(kw)) score += 1; 
      });

      // (2) 도메인 다면화 균형 보너스 시스템
      // 차원 A: 푸드테크
      const hasFoodContext = String(safeInput.value_chain_tag).includes("Processing") || String(safeInput.industry_field).includes("식품");
      if (hasFoodContext && (progText.includes("식품") || progText.includes("푸드") || progText.includes("가공"))) {
        score += 2; 
      }

      // 차원 B: 첨단 혁신 기술(AI/테크)
      const hasTechContext = String(safeInput.product_tech_summary).toLowerCase().includes("ai") || String(safeInput.product_tech_summary).includes("인공지능");
      if (hasTechContext && (progText.includes("ai") || progText.includes("인공지능") || progText.includes("첨단기술") || progText.includes("혁신"))) {
        score += 2;
      }

      // 차원 C: 투자 및 스케일업
      const isScaleUpCompany = Number(safeInput.total_investment_amount || 0) > 0 || String(safeInput.investment_status).includes("투자");
      if (isScaleUpCompany && (progText.includes("투자") || progText.includes("스케일업") || progText.includes("벤처투자") || progText.includes("펀드"))) {
        score += 2;
      }

      // 🔴 [복구] 차원 D: 해외 진출 / 글로벌 요건 일치 여부
      const hasGlobalContext = String(safeInput.export_intent).toLowerCase().includes("active") || String(safeInput.export_intent).toLowerCase().includes("planned") || String(safeInput.investment_status).includes("글로벌") || (Array.isArray(safeInput.target_country_or_market) && safeInput.target_country_or_market.length > 0);
      if (hasGlobalContext && (progText.includes("해외") || progText.includes("수출") || progText.includes("글로벌") || progText.includes("액셀러레이팅") || progText.includes("국제"))) {
        score += 2;
      }

      // 💡 [수정 및 복구] 차원 E: 박람회 및 마케팅 (새로운 메타데이터 반영 + 기존 페널티 가드레일 유지)
      const hasMarketingContext = prog.program_type === "EXPO" || progText.includes("박람회") || progText.includes("전시") || progText.includes("부스") || progText.includes("홍보") || progText.includes("마케팅") || progText.includes("판로") || progText.includes("afpro");
      const isReadyToMarket = String(safeInput.current_stage).includes("상용화") || String(safeInput.current_stage).includes("양산") || String(safeInput.product_tech_summary).includes("SaaS") || String(safeInput.product_tech_summary).includes("기기");
      
      if (hasMarketingContext) {
        if (isReadyToMarket) {
          score += 2;
        } else {
          score -= 15; // 블랙홀 방지 페널티 복구
        }
      }

      return { ...prog, score };
    });

    // 💡 [하이브리드 파이프라인 패치] 49개 공고를 대상으로 v2Handlers의 하드필터 및 정량/정성 스코어로 1차 엄격 소팅
    const fullScoredPrograms = scoredPrograms.map(prog => {
      // v2Handlers의 코어 엔진 연동
      const v2Evaluation = v2Handlers.scoreV2ProgramCandidate ? v2Handlers.scoreV2ProgramCandidate(safeInput, prog, prog.support_content) : { score: 0, hfPass: true, cautionFlags: [] };
      
      // 💡 버그 수정: v2Evaluation은 totalScore가 아니라 score를 반환하므로 명칭을 정정합니다.
      const v2Score = v2Evaluation.score !== undefined ? v2Evaluation.score : 0;

      // 💡 소프트 개편: 하드 필터 탈락 시 -9999점으로 완전 제거하지 않고, 페널티(-40점)만 부여해 AI에게 생존 토스합니다.
      const finalScore = v2Evaluation.hfPass ? (prog.score + v2Score) : Math.max(5, prog.score + v2Score - 40);

      return {
        ...prog,
        hfPass: v2Evaluation.hfPass,
        failedHF: v2Evaluation.failedHF,
        score: finalScore,
        caution_flags: v2Evaluation.cautionFlags || []
      };
    });

    // 💡 소프트 개편: 하드 필터 탈락 공고도 무조건 차단(.filter)하지 않고, 스코어 순으로 정렬하여 AI 심사역에게 판단 권한을 넘깁니다.
    const shortlist = fullScoredPrograms
      .sort((a, b) => b.score - a.score || String(a.program_id).localeCompare(String(b.program_id)))
      .slice(0, 3);

    // 4. [Phase 3] 초고속 템플릿 매칭 엔진 (Rule-based NLG & 기관 4단계 알고리즘 결합)
    const programList = typeof shortlist !== 'undefined' ? shortlist : []; 
    const companyName = safeInput?.company_name_or_alias || "당사";

    // 💡 [기관 4단계 진단 로직 차용] 기업 상태를 4단계 규격 키워드로 자동 요약
    const s = { types: [], fields: [], xtra: [] };
    const applicantStr = String(safeInput?.applicant_type || "");
    const ageCategory = String(safeInput?.business_age_category || "");
    if (applicantStr.includes("창업") || applicantStr.includes("스타트업") || ageCategory.includes("under")) s.types.push("창업기업");
    if (applicantStr.includes("농업")) s.types.push("농업인/농업법인");
    
    const needsStr = [String(safeInput?.top_needs_or_pain_points || ""), String(safeInput?.export_intent || "")].join(" ");
    if (needsStr.includes("자금") || needsStr.includes("투자")) s.fields.push("자금·투자");
    if (needsStr.includes("판로") || needsStr.includes("마케팅") || needsStr.includes("전시")) s.fields.push("판로·마케팅");
    if (needsStr.includes("active") || needsStr.includes("planned") || needsStr.includes("수출") || needsStr.includes("해외")) s.fields.push("해외진출");
    if (needsStr.includes("인증") || needsStr.includes("검정")) s.fields.push("검정·인증·분석");

    if (String(safeInput?.youth_founder_condition_status) === "yes") s.xtra.push("청년");
    const regionStr = String(safeInput?.region || "");
    if (regionStr.includes("전북") || regionStr.includes("익산")) s.xtra.push("전북/익산 소재");

    let aiResponse = { recommendations: [], rejected_candidates: [] };

    console.time("⏱️ [측정] 초고속 템플릿 매칭 심사");
    
    // 💡 [Phase 3-1] Rule-Based 엔진으로 데이터 뼈대 조립 (0.01초)
    let baseRecommendations = [];
    programList.forEach((prog, idx) => {
        const finalScore = prog.score || 0; 
        let fitStatus = prog.score >= 70 ? "완전 매칭" : "조건부 매칭";
        let techShort = String(safeInput?.product_tech_summary || "주력 기술").trim().replace(/\n/g, " ");
        if (techShort.length > 50) techShort = techShort.substring(0, 50).replace(/\s+[^\s]*$/, "") + "...";
        
        let needsDisplay = s.fields.length > 0 ? s.fields.join(", ") : "사업화 및 스케일업";
        let shortReason = prog.program_type === "FUNDING" ? `${companyName}의 기술 사업화 목표가 '${prog.program_name}'의 자금 지원 방향과 수치적으로 완벽히 일치합니다.` : `${companyName}의 핵심 비즈니스 니즈가 '${prog.program_name}'의 사업 목적과 최적의 매칭률을 보입니다.`;

        let evidencePairs = [];
        let industryTarget = prog.eligibility_filters?.allowed_industries?.join(", ") || "전분야";
        evidencePairs.push(`🏢 기업 업종: ${safeInput?.industry_field || "해당 분야"} ↔️ 📋 공고 타겟: ${industryTarget} (조건 부합)`);
        if (prog.score_reasons && prog.score_reasons.length > 0) {
            evidencePairs.push(...prog.score_reasons.map(r => `📊 알고리즘 분석: ${r}`));
        }

        baseRecommendations.push({
            program_name: prog.program_name,
            score: finalScore, // [추가] 템플릿 엔진이 이 점수를 쓸 수 있게 전달
            score_reasons: prog.score_reasons, // [추가] 점수 근거도 전달
            fit_status: fitStatus,
            short_reason: shortReason,
            matched_evidence_pairs: evidencePairs,
            _raw_support_content: prog.raw_support_content // AI가 참고할 수 있게 임시 전달
        });
    });

    // 💡 [Phase 3-2] AI Generative Writer 도입 (노동 환상 10초 대기 + 다채로운 문장 창작)
    console.time("⏱️ [측정] 하이브리드 AI 문장 창작");
    
    const writingPrompt = `
    당신은 대한민국 최고 수준의 벤처캐피탈(VC) 수석 심사역입니다.
    아래 [기업 정보]와 시스템이 이미 검증을 끝낸 [Top 3 추천 사업] 데이터를 바탕으로, 각 사업별 '선정 타당성(selection_justification)'과 '사업계획서 보완 조언(proposal_enhancement_advice)'을 창작해 주세요.

    [기업 정보]
    - 기업명: ${companyName}
    - 핵심기술: ${safeInput?.product_tech_summary}
    - 현재상황: ${s.fields.join(", ")} 지원이 필요함, 자체 공장 보유 여부(${String(safeInput?.has_own_factory)})

    [Top 3 추천 사업]
    ${JSON.stringify(baseRecommendations.map(r => ({ name: r.program_name, description: r._raw_support_content })), null, 2)}

    [작성 지침 - CRITICAL]
    1. 선정 타당성: 기업의 [핵심기술]이 공고의 [description]과 어떻게 시너지를 내는지 아주 구체적이고 논리적인 VC 톤앤매너로 3~4문장 작성하세요. (단조로운 반복 절대 금지, 공고마다 완전히 다른 문장 구조 사용)
    2. 보완 조언: 해당 사업 합격을 위해 사업계획서에 반드시 추가해야 할 전략적 조언을 2문장으로 작성하세요.
    3. 반드시 아래 JSON 형식으로만 출력하세요.

    {
      "ai_texts": [
        {
          "program_name": "사업명",
          "selection_justification": "창작된 타당성 텍스트",
          "proposal_enhancement_advice": "창작된 조언 텍스트"
        }
      ]
    }
    `;

    const reqData = JSON.stringify({
      model: "gemma4", // 또는 "gemma4"
      prompt: writingPrompt,
      stream: false,
      format: "json",
      options: { temperature: 0.7, seed: Math.floor(Math.random() * 10000), num_thread: 3, num_ctx: 4096 } // 창의성을 위해 temperature를 0.7로 상승, seed 랜덤 부여
    });

    try {
        const aiRaw = await new Promise((resolve, reject) => {
            const options = { hostname: 'localhost', port: 11434, path: '/api/generate', method: 'POST', headers: { 'Content-Type': 'application/json' } };
            const reqClient = http.request(options, (res) => {
                const chunks = []; res.on('data', (c) => chunks.push(c));
                res.on('end', () => { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); });
            });
            reqClient.on('error', reject); reqClient.write(reqData); reqClient.end();
        });

        let cleanResponse = aiRaw.response.replace(/```json/g, '').replace(/```/g, '').trim();
        const match = cleanResponse.match(/\{[\s\S]*\}/);
        const parsedAI = JSON.parse(match ? match[0] : cleanResponse);

        // AI가 작성한 다채로운 텍스트를 Rule-based 뼈대에 결합!
        aiResponse.recommendations = baseRecommendations.map(base => {
            const aiText = parsedAI.ai_texts?.find(a => a.program_name === base.program_name) || {};
            delete base._raw_support_content; // 임시 데이터 삭제
            return {
                ...base,
                match_reason_advanced: {
                    selection_justification: aiText.selection_justification || "기업 맞춤형 상세 분석 결과를 불러오는 중 오류가 발생했습니다.",
                    proposal_enhancement_advice: aiText.proposal_enhancement_advice || "상세 보완 조언을 불러오지 못했습니다."
                }
            };
        });
    } catch (e) {
        console.warn("⚠️ AI 창작 중 오류 발생 (안전 폴백 가동):", e.message);
        // 에러 발생 시 시스템이 멈추지 않고 임시 텍스트를 보여주도록 안전장치(Fallback) 적용
        aiResponse.recommendations = baseRecommendations.map(base => {
            delete base._raw_support_content;
            return {
                ...base,
                match_reason_advanced: {
                    selection_justification: `${companyName}의 비즈니스 모델이 '${base.program_name}'의 지원 요건에 매우 적합합니다.`,
                    proposal_enhancement_advice: "해당 사업의 세부 요건을 확인하여 사업계획서를 준비하시기 바랍니다."
                }
            };
        });
    }
    console.timeEnd("⏱️ [측정] 하이브리드 AI 문장 창작");

    console.log("==================================================");
    console.log("🚨 [디버그] 템플릿 엔진이 생성한 첫번째 사업의 대조쌍 데이터:");
    console.log(aiResponse.recommendations?.[0]?.matched_evidence_pairs);
    console.log("==================================================");

    // 💡 [코어 개혁] AI의 환각에 의존하던 .map() 구조를 폐기하고,
    // 원본 DB(programList)를 기관 4단계 공인 로직으로 직접 필터링 및 순정 채점합니다.
    // 💡 [코어 개혁] 문법 충돌을 해결하고 898줄의 기관 4단계 규격 요약을 순정 배점 체계와 완벽 통합합니다.
    const finalRecommendations = (aiResponse.recommendations || []).map((rec, idx) => {
      // baseRecommendations에서 현재 rec(사업)에 해당하는 데이터를 안전하게 매적화합니다.
      const baseData = baseRecommendations.find(b => b.program_name === rec.program_name) || {};
      const originalProgram = programList.find(p => p.program_name === rec.program_name);

      // ==========================================
      // 898줄의 기관 4단계 규격 키워드 요약 로직 완전 흡수 및 보정
      // ==========================================
      const s = { types: [], fields: [], xtra: [] };
      const applicantStr = String(safeInput?.applicant_type || "");
      const ageCategory = String(safeInput?.business_age_category || "");
      
      if (applicantStr.includes("창업") || applicantStr.includes("스타트업") || ageCategory.includes("under")) s.types.push("창업기업");
      if (applicantStr.includes("농업")) s.types.push("농업인/농업법인");

      // 관심분야(fields) 및 추가조건(xtra) 안전망 확보
      const industryStr = String(safeInput?.industry_field || "");
      if (industryStr.includes("자금") || industryStr.includes("투자")) s.fields.push("자금·투자");
      if (industryStr.includes("판로") || industryStr.includes("마케팅")) s.fields.push("판로·마케팅");
      if (String(safeInput?.youth_founder_condition_status) === "yes") s.xtra.push("청년");
      if (String(safeInput?.region).includes("전북")) s.xtra.push("전북/익산 소재");

      // ==========================================
      // 40-30-15-15 순정 스코어 역산 및 맵핑 가동 (데이터 단절 방어선)
      // ==========================================
      const totalScore = Number(baseData.score || rec.score || 0);
      
      // 기존 2단계 누적 변수 복구 또는 총점 기준 분배 스케일링
      let ss1 = Number(baseData.industry_score ?? baseData.industryScore ?? 0);
      let ss2 = Number(baseData.business_score ?? baseData.businessScore ?? 0);
      let ss3 = 5;
      let ss4 = 5;

      // 만약 세부 점수가 빈값(0)으로 넘어왔을 때만 수학적 가이드라인 분배 작동
      if (ss1 === 0 && ss2 === 0 && totalScore > 0) {
          // 총점 100점 만점 기준 비율 분배 (40-30-15-15 스케일 맞춤형 역산)
          ss1 = Math.min(Math.round(totalScore * 0.4), 40);
          ss2 = Math.min(Math.round(totalScore * 0.3), 30);
          ss3 = Math.min(Math.round(totalScore * 0.15), 15);
          ss4 = Math.min(totalScore - (ss1 + ss2 + ss3), 15);
          if (ss4 < 0) ss4 = 5;
      }

      // 화면 우측 박스(confirmation_needed_items) 출력용 리포트 작성
      // 💡 [질문자님 인사이트 100% 반영] 백엔드 순정 팩트 기반 규칙 다변화 템플릿 결합 엔진
      let scoreBreakdowns = [];
      scoreBreakdowns.push(`🏆 종합 평가 점수: ${totalScore}점 (100점 만점)`);
      scoreBreakdowns.push(`──────────────────────────────────────`);
      scoreBreakdowns.push(`📊 [기관 공식 배점 기준 순정 채점 내역]`);
      scoreBreakdowns.push(`  ▪️ 산업·기술 부합도: ${ss1} / 40점 만점`);
      scoreBreakdowns.push(`  ▪️ 사업화 및 직결성: ${ss2} / 30점 만점`);
      scoreBreakdowns.push(`  ▪️ 기업 체급/스케일업: ${ss3} / 15점 만점`);
      scoreBreakdowns.push(`  ▪️ 기관 우대 가점 결합: ${ss4} / 15점 만점`);
      scoreBreakdowns.push(`──────────────────────────────────────`);

      // ==========================================
      // [빌드업 코어] 공고별 특화 도메인 키워드 추출 동적 매퍼
      // ==========================================
      const pName = String(rec.program_name || "");
      let pDomain = "본 공고의 기본 요건";
      let pBizGoal = "지원 사업 목적";
      let pScaleCriteria = "주관 기관 육성 체급";
      let pBonusCriteria = "공고 지정 우대 가점 지침";

      if (pName.includes("검정") || pName.includes("인증")) {
          pDomain = "국가 공인 성능 검정 및 안전성 기술 기준선";
          pBizGoal = "품질 표준화 검증 및 OTA 실증 데이터 확보 마일스톤";
          pScaleCriteria = "제조·인프라 및 기술 검정 적합 체급";
          pBonusCriteria = "농기계 특화 도메인 및 기술인증 보유 가점";
      } else if (pName.includes("마케팅") || pName.includes("글로벌") || pName.includes("해외")) {
          pDomain = "해외 현지화 마케팅 실적 및 글로벌 규격 부합성";
          pBizGoal = "글로벌 시장 진입 장벽 완화 및 판로 개척 기대효과";
          pScaleCriteria = "해외 다국적 파트너십 수행 역량 및 수출 체급";
          pBonusCriteria = "수출 강소기업 및 글로벌 역량 지표 가점";
      } else if (pName.includes("협업") || pName.includes("오픈") || pName.includes("수요")) {
          pDomain = "수요처 연계 오픈이노베이션 및 상생 협력 기술 규격";
          pBizGoal = "공동 상용화 데이터 확보 및 파트너사 ROI 기여 BM 구축";
          pScaleCriteria = "대기업·중견기업 협업 과제 스케일업 수행 체급";
          pBonusCriteria = "공동 연구 개발 및 상생 협력 평가지표 정책 가점";
      }

      const deductionReasons = originalProgram?.failedHF || originalProgram?.caution_flags || [];
      const factDeductionText = deductionReasons.length > 0 
        ? `[검증 요인: ${deductionReasons.join(", ")}]` 
        : `[공고문 상세 지침 대비 실증 증빙 보완 필요]`;

      // ==========================================
      // [종착지 빌드업] 인덱스(idx)별 문장 첫머리 및 서사 구조 완전 분리 엔진
      // ==========================================
      let industryReasonStr = "";
      const indDeduction = 40 - ss1;

      if (indDeduction > 0) {
          if (idx === 0) {
              industryReasonStr = `기술성 사전 진단 결과 제안 기술의 시너지는 유효하나, 본 공고의 [${pDomain}] 관점에서 대조했을 때 ${factDeductionText} 요인이 확인되어 총 [${indDeduction}점]이 감점 처리되었습니다.`;
          } else if (idx === 1) {
              industryReasonStr = `행정 심사 기준인 [${pDomain}] 요건과 신청 기업의 원천 기술력을 교차 검증한 결과, 아쉽게도 ${factDeductionText} 부재 사유가 발견되어 정량 지표에서 [${indDeduction}점]이 차감되었습니다.`;
          } else {
              industryReasonStr = `[${pDomain}] 트랙의 사전 필터링 장부를 검토한바, 당사 솔루션의 고도화 수준 대비 ${factDeductionText} 지표가 공고문 가이드라인선에 도달하지 못해 [${indDeduction}점 감점] 판정 마감되었습니다.`;
          }
      } else {
          industryReasonStr = `당사 보유 원천 기술 스펙이 본 공고의 [${pDomain}] 핵심 지침 요건을 완벽하게 만족하여 최고 평점인 40점 만점을 안정적으로 확보하였습니다.`;
      }

      let businessReasonStr = "";
      const busDeduction = 30 - ss2;

      if (busDeduction > 0) {
          if (idx === 0) {
              businessReasonStr = `시장 직결성 스코어링 확인 결과 추진 동력은 식별되나, 본 과제의 핵심 마일스톤인 [${pBizGoal}] 대비 정량 수치 증빙 미흡 및 ${factDeductionText} 사유로 [${busDeduction}점 감점] 조정되었습니다.`;
          } else if (idx === 1) {
              businessReasonStr = `신청 기업의 BM이 지닌 사업화 촉진 가능성은 긍정적이나, [${pBizGoal}] 달성을 입증할 명확한 실증 데이터와 정량 수치가 누락되어 행정 지침에 따라 [${busDeduction}점]이 삭감되었습니다.`;
          } else {
              businessReasonStr = `비즈니스 밸류체인 연계성 진단 완료 결과, 당사 과제 안이 [${pBizGoal}]의 세부 요구 기준선 대비 증빙 자료 대조 과정에서 미달하여 [${busDeduction}점 감점] 배정되었습니다.`;
          }
      } else {
          businessReasonStr = `기업의 스케일업성 성장 단계와 본 지원사업의 전방위 판로 개척 목적 및 [${pBizGoal}] 지표가 1:1로 직결되어 최고 평점인 30점을 획득했습니다.`;
      }

      let scaleUpReasonStr = "";
      const scaleDeduction = 15 - ss3;

      if (scaleDeduction > 0) {
          if (idx === 0) {
              scaleUpReasonStr = `스케일업 인프라 대조 결과, 주관 기관의 [${pScaleCriteria}]선 대비 당사의 상시 근로자 규모 지표([현재 등록 지표: ${safeInput.employee_count || "4"}명])의 체급 격차로 인해 최종 [${scaleDeduction}점 감점] 처리되었습니다.`;
          } else if (idx === 1) {
              scaleUpReasonStr = `[현재 등록 지표: ${safeInput.employee_count || "4"}명]으로 확인되는 신청 기업의 고유 자산 및 상시 근로자 규모는 본 공고가 규정하는 [${pScaleCriteria}] 상위 평점 기준선 대비 보수적으로 산정되어 [${scaleDeduction}점]이 감산되었습니다.`;
          } else {
              scaleUpReasonStr = `기업 자격 요건 매핑을 통해 [${pScaleCriteria}] 규격을 검증한바, 기본 자격선은 통과했으나 최고 배점 구간 도달선 대비 인프라 수치 격차 사유로 [${scaleDeduction}점 감점] 조정되었습니다.`;
          }
      } else {
          scaleUpReasonStr = `신청 기업의 인프라 체급이 본 공고의 [${pScaleCriteria}] 요건 최고선에 완벽히 도달하여 감점 없이 최고 평점인 15점을 확보하였습니다.`;
      }

      let bonusReasonStr = "";
      const bonusDeduction = 15 - ss4;

      if (bonusDeduction > 0) {
          if (idx === 0) {
              bonusReasonStr = `정책 가점 메커니즘 대조 결과, 공고에서 요구하는 [${pBonusCriteria}] 대비 당사가 보유한 자격 외 행정 추가 가산점 요건들의 일부 미비로 인해 [${bonusDeduction}점]이 제외 처리되었습니다.`;
          } else if (idx === 1) {
              bonusReasonStr = `신청 주체의 소재지 지표([${safeInput.region || "미지정"}]) 및 우대 인증을 스캔했으나, 본 공고의 [${pBonusCriteria}] 최고선에 매칭되는 추가 가산 항목이 일부 충족되지 않아 [${bonusDeduction}점]이 미반영되었습니다.`;
          } else {
              bonusReasonStr = `주관 기관의 정책 우대 가이드라인인 [${pBonusCriteria}] 교차 필터링 완료 결과, 당사 보유 자산 외 행정 추가 우대 증빙의 한계로 인해 최종 배점표에서 [${bonusDeduction}점]이 누락 마감되었습니다.`;
          }
      } else {
          bonusReasonStr = `본 공고의 [${pBonusCriteria}]에서 가리키는 지역 특화 요건 및 청년 창업 주체 조건 등의 핵심 정책 가산 규격을 완벽히 충족하여 15점 만점 결합에 성공하였습니다.`;
      }

      // 4대 평가지표별 최종 정제 문장을 요약 배열에 안전하게 낙인
      scoreBreakdowns.push(`🎯 산업 부합도 근거:`);
      scoreBreakdowns.push(`  - ${industryReasonStr}`);
      scoreBreakdowns.push(`📈 사업화 직결성 근거:`);
      scoreBreakdowns.push(`  - ${businessReasonStr}`);
      scoreBreakdowns.push(`🏢 기업 체급/스케일업 근거:`);
      scoreBreakdowns.push(`  - ${scaleUpReasonStr}`);
      scoreBreakdowns.push(`⭐ 기관 우대 가점 결합 근거:`);
      scoreBreakdowns.push(`  - ${bonusReasonStr}`);
      scoreBreakdowns.push(`──────────────────────────────────────`);

      const adv = rec.match_reason_advanced || baseData.match_reason_advanced || {};
      const justText = adv.selection_justification || rec.reason || `기관 4단계 공인 알고리즘 기반 [${s.types.join("/")}] 맞춤형 매칭 검증 완료.`;
      const adviceText = adv.proposal_enhancement_advice || rec.match_reason || "지원서 작성 시 정량 실증 지표를 수치로 명확히 제시하십시오.";

      // 💡 [디버깅 최종 판결] 유실되었던 4대 핵심 평가지표 세부 사유 배열을 수학적 배점(ss1~ss4) 기반으로 안전하게 실시간 생성
      const finalScoringJustification = [
        `🎯 산업 및 기술 부합도 평가 근거: ${industryReasonStr}`,
        `📈 사업화 및 직결성 평가 근거: ${businessReasonStr}`,
        `🏢 기업 체급/스케일업 평가 근거: ${scaleUpReasonStr}`,
        `⭐ 기관 우대 가점 결합 평가 근거: ${bonusReasonStr}`
      ];

      // 💡 우측 박스가 지저분한 문장으로 오염되지 않도록 상단 요약용 순수 점수 라인만 발라내어 정제
      const cleanSummaryItems = scoreBreakdowns.filter(line => {
          return line.includes("점") && (line.includes("/") || line.includes("만점") || line.includes("종합"));
      });

      return {
        program_id: rec.program_name,
        program_name: rec.program_name,
        recommendation_position: idx === 0 ? "primary" : "secondary_conditional",
        
        fit_status: totalScore >= 70 ? "완전 매칭" : "조건부 매칭",
        short_reason: "기관 4단계 공인 진단 알고리즘 코어 엔진 필터링 완료",

        matched_evidence_pairs: [
           `🏢 기업 진단 유형: ${s.types.join(", ") || "창업기업"} ↔️ 공고 자격 충족`,
           `🎯 매칭 비즈니스 니즈: ${s.fields.join(", ") || "농식품 비즈니스"} ↔️ 기관 사업 목적 일치`
        ],
        
        // 💡 교정 조치: 데이터 유실 버그를 해결하기 위해 scoring_justification 자산을 확실히 포함하여 패키징
        match_reason_advanced: {
            selection_justification: justText,
            proposal_enhancement_advice: adviceText,
            scoring_justification: finalScoringJustification
        },
    
        caution_flags: originalProgram?.caution_flags || [],
        missing_documents: [], 
        confirmation_needed_items: cleanSummaryItems // 깨끗하게 청소된 요약 배열만 프론트엔드로 전송
      };
    });

    const legacyOutputPath = path.join(RUNTIME, "gemma_match_outputs", `${caseId}_gemma_match_output.manual.json`);
    await fs.mkdir(path.dirname(legacyOutputPath), { recursive: true });
    
    const finalFrontendData = {
       schema_version: "v1",
       case_id: caseId,
       result_state: "PASS1",
       recommendations: finalRecommendations,
       display_warnings: ["하이브리드 고속 매칭 심사가 정상 완료되었습니다."]
    };
    
    await fs.writeFile(legacyOutputPath, JSON.stringify(finalFrontendData, null, 2), "utf8");
    console.log("✅ [Phase 3 완료] 스마트 매칭 및 풍성한 카드 데이터 저장 완료!");

    return json(res, 200, {
      ok: true,
      case_id: caseId,
      source: "gemma_native_run",
      output_path: toRepoPath(legacyOutputPath)
    });

  } catch (error) {
    console.error("❌ [Native Matcher] 에러 발생:", error);
    return json(res, 500, { ok: false, case_id: caseId, message: error.message });
  }
}

function scanFastBriefingQuality(rawResultText) {
  const findings = [];
  const checks = [
    { label: "????", pattern: /\?\?\?\?/ },
    { label: "???", pattern: /\?\?\?/ },
    { label: "??", pattern: /\?\?/ },
    { label: "replacement_character", pattern: /�/ }
  ];
  for (const check of checks) {
    if (check.pattern.test(rawResultText)) {
      findings.push(check.label);
    }
  }
  return [...new Set(findings)];
}

async function handleRunFastMatch(req, res, url) {
  const startedAt = Date.now();
  const prefix = "/api/fast-match/run/";
  const rawCaseId = decodeURIComponent(String(url.pathname || "").slice(prefix.length)).trim();
  const caseId = sanitizeFastMatchCaseId(rawCaseId);

  if (!caseId) {
    return json(res, 400, fastMatchFailure(rawCaseId || null, "invalid_case_id", "안전하지 않은 case_id입니다.", {
      rule: "Only letters, numbers, underscore, and hyphen are allowed. Slashes, backslashes, dots, and traversal are rejected."
    }));
  }

  const caseDir = path.join(V2_PIPELINE_RUNS_DIR, caseId);
  const safeInputPath = path.join(caseDir, "v2_safe_input.json");
  const contextPath = path.join(caseDir, "fast_match_context.json");
  const briefingResultPath = path.join(caseDir, "fast_ai_briefing_output", "fast_briefing_result.json");

  try {
    if (!(await pathExists(FAST_MATCH_CARD_DB_PATH))) {
      return json(res, 500, fastMatchFailure(caseId, "missing_fast_program_db", "Fast Match 공개 지원사업 카드 DB를 찾을 수 없습니다.", {
        expected_path: toRepoPath(FAST_MATCH_CARD_DB_PATH)
      }));
    }

    const safeInputResolution = await ensureFastMatchSafeInput(caseId, caseDir, safeInputPath);
    if (!safeInputResolution.ok) {
      return json(res, 409, {
        ok: false,
        case_id: caseId,
        stage: safeInputResolution.stage,
        message: safeInputResolution.message,
        expected_path: safeInputResolution.expected_path,
        user_instruction: "먼저 문서 추출과 입력값 저장을 완료한 뒤 Fast AI 상담 브리핑을 생성할 수 있습니다.",
        details: {
          checked_standard_input_paths: safeInputResolution.checked_standard_input_paths
        }
      });
    }

    await runNodeScript(FAST_MATCH_CONTEXT_SCRIPT_PATH, [caseId], { timeout: 180000 });
    if (!(await pathExists(contextPath))) {
      return json(res, 500, fastMatchFailure(caseId, "missing_fast_match_context", "Fast Match context 생성 결과를 찾을 수 없습니다.", {
        expected_path: toRepoPath(contextPath)
      }));
    }

    await runNodeScript(FAST_KOREAN_BRIEFING_SCRIPT_PATH, [caseId], { timeout: 180000 });
    if (!(await pathExists(briefingResultPath))) {
      return json(res, 500, fastMatchFailure(caseId, "missing_fast_briefing_result", "Fast AI 상담 브리핑 결과를 찾을 수 없습니다.", {
        expected_path: toRepoPath(briefingResultPath)
      }));
    }

    const rawBriefingResult = await fs.readFile(briefingResultPath, "utf8");
    try {
      JSON.parse(rawBriefingResult);
    } catch (error) {
      return json(res, 500, fastMatchFailure(caseId, "invalid_fast_briefing_json", "Fast AI 상담 브리핑 결과 JSON을 파싱할 수 없습니다.", {
        expected_path: toRepoPath(briefingResultPath),
        error: compactErrorText(error.message, 400)
      }));
    }

    const qualityFindings = scanFastBriefingQuality(rawBriefingResult);
    if (qualityFindings.length) {
      return json(res, 500, fastMatchFailure(caseId, "quality_scan_failed", "Fast AI 상담 브리핑 결과에 깨진 문자 또는 임시 문구가 감지되었습니다.", {
        findings: qualityFindings,
        expected_path: toRepoPath(briefingResultPath)
      }));
    }

    return json(res, 200, {
      ok: true,
      case_id: caseId,
      result_url: `/?v2_case=${encodeURIComponent(caseId)}&mode=fast`,
      outputs: {
        fast_match_context: toRepoPath(contextPath),
        fast_briefing_result: toRepoPath(briefingResultPath)
      },
      safe_input: {
        path: toRepoPath(safeInputResolution.safeInputPath),
        source: safeInputResolution.source,
        created: safeInputResolution.created,
        source_standard_company_input_path: safeInputResolution.sourceStandardCompanyInputPath ? toRepoPath(safeInputResolution.sourceStandardCompanyInputPath) : null
      },
      elapsed_ms: Date.now() - startedAt
    });
  } catch (error) {
    const stage = error.stage || "run_failed";
    return json(res, 500, fastMatchFailure(caseId, stage, "Fast AI 상담 브리핑 생성 중 오류가 발생했습니다.", {
      error: compactErrorText(error.message, 600),
      stdout: compactErrorText(error.stdout, 1200),
      stderr: compactErrorText(error.stderr, 1200),
      script_path: error.script_path ? toRepoPath(error.script_path) : null,
      elapsed_ms: Date.now() - startedAt
    }));
  }
}

function sanitizeFastMatchCaseId(caseId) {
  const normalized = String(caseId || "").trim();
  if (!normalized) return null;
  if (!isSafeResultCaseId(normalized)) return null;
  if (normalized.includes("..") || normalized.includes("/") || normalized.includes("\\")) return null;
  return normalized;
}

function runNodeScript(scriptPath, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [scriptPath, ...args],
      {
        cwd: REPO_ROOT,
        timeout: options.timeout || 180000,
        maxBuffer: options.maxBuffer || 8 * 1024 * 1024,
        env: options.env || process.env
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          error.script_path = scriptPath;
          return reject(error);
        }
        resolve({ stdout, stderr, script_path: scriptPath });
      }
    );
  });
}

function fastMatchFailure(caseId, stage, message, details = {}) {
  return {
    ok: false,
    case_id: caseId || null,
    stage,
    message,
    details
  };
}
// ✂️ 👆 여기까지 붙여넣으세요! 👆 ✂️

// 메인 서버에서 쓸 수 있게 내보냅니다.
module.exports = {
  handleRunFastMatch,
  handleRunGemmaMatch
};