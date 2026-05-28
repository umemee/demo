// aiHandlers.js
const fs = require("fs/promises");
const path = require("path");
const http = require("http");

const config = require("./config.js");
const utils = require("./utils.js");
const { toRepoPath, fromRepoPath, isPathInside, pathExists } = utils;

// 경로 확인을 위한 안전 도우미 함수들


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

// 빈 초안 생성 함수들
function blankDraftField(field, reason) {
  return {
    field,
    value: field === "top_needs_or_pain_points" ? [] : null,
    confidence: 0,
    source_type: "document_extracted",
    source_excerpt: "",
    status: "draft",
    needs_user_review: true,
    reason
  };
}

function draftField(field, value, confidence, sourceExcerpt, reason) {
  const safeValue = Array.isArray(value)
    ? value.map((item) => sanitizeDraftText(item, 120)).filter(Boolean)
    : sanitizeDraftText(value, field === "product_tech_summary" ? 420 : 160);
  return {
    field,
    value: Array.isArray(value) ? safeValue : safeValue || null,
    confidence: Math.max(0, Math.min(Number(confidence) || 0, 0.9)),
    source_type: "document_extracted",
    source_excerpt: sanitizeDraftText(sourceExcerpt, 220),
    status: "draft",
    needs_user_review: true,
    reason
  };
}

function buildEmptyExpandedV2SafeCandidateFields() {
  const fields = {};
  for (const field of config.AUTOFILL_EXPANDED_V2_SAFE_FIELDS) {
    fields[field] = blankDraftField(field, "No clear expanded V2-safe candidate signal found. Left blank.");
  }
  return fields;
}

function buildEmptyAutofillDraft(caseId, sourcePath, extractionManifestPath, now, status = "AUTOFILL_DRAFT_READY", note = "") {
  return {
    case_id: caseId,
    source_extracted_path: sourcePath || null,
    source_extraction_manifest_path: extractionManifestPath || null,
    created_at: now,
    status,
    notes: note || "Draft suggestions only. User must review/edit and click the existing 입력 저장 button to confirm.",
    allowed_fields: config.AUTOFILL_ALLOWED_FIELDS,
    blocked_fields: config.AUTOFILL_BLOCKED_FIELDS,
    draft_fields: {
      company_name_or_alias: blankDraftField("company_name_or_alias", "No clear company name found. Left blank."),
      region: blankDraftField("region", "No clear city/province/county-level company region found. Left blank."),
      industry_field: blankDraftField("industry_field", "No conservative broad company sector label found. Left blank."),
      product_tech_summary: blankDraftField("product_tech_summary", "No safe company-specific product or technology summary found. Left blank."),
      top_needs_or_pain_points: blankDraftField("top_needs_or_pain_points", "No clearly stated company needs found. Left blank.")
    },
    v2_safe_candidate_fields: buildEmptyExpandedV2SafeCandidateFields()
  };
}

// 핵심 1: Gemma AI 데이터 추출 엔진
async function generateAutofillDraftWithAI(text, caseId, sourcePath, extractionManifestPath, now) {
  const draft = buildEmptyAutofillDraft(caseId, sourcePath, extractionManifestPath, now);
  
  try {
    console.log(`\n🚀 [Speed Optimize] '${caseId}' 정밀 추출 중... (RAG 기반 하이브리드 최적화)`);
    
    const keywords = [
        "회사", "기업", "주식회사", "법인", "대표", "대표자", "CEO", "소재지", "주소", "설립", "창업", 
        "업종", "분야", "산업", "생산품", "서비스", "기술", "아이템", "제품", "단계", "상용화",
        "매출", "고용", "직원", "근로자", "인원", "수출", "인증", "벤처", "이노비즈", "메인비즈", "투자", "유치",
        "사업비", "자금", "지원", "국고", "비용", "애로사항", "필요성", "배경", "니즈", "추진", "전략", "목표", "시장", "계획", "마케팅", "부스", "전시", "확산",
        "MOU", "LoI", "업무협약", "계약서", "의향서", "파트너", "온실", "공장", "가공", "제조", "농장", "재배", "스마트팜", "푸드", "바이오",
        "청년", "나이", "기술이전", "실증", "검증", "해외", "글로벌"
    ];
    let condensedText = "";
    const lines = String(text || "").split(/\r?\n/);
    
    for (let i = 0; i < lines.length; i++) {
        if (keywords.some(kw => lines[i].includes(kw))) {
            const prev = lines[i-1] ? lines[i-1].trim() : "";
            const curr = lines[i].trim();
            const next = lines[i+1] ? lines[i+1].trim() : "";
            condensedText += `${prev}\n${curr}\n${next}\n---\n`;
        }
    }
    condensedText = condensedText.slice(0, 1500).trim();

    const finalPrompt = `당신은 최고 수준의 벤처캐피탈(VC) 및 데이터 엔지니어입니다. 
아래 [압축된 문서]를 정밀 분석하여, 백엔드 연산에 최적화된 엄격한 JSON 포맷으로 데이터를 누락 없이 추출하세요.

[🚨 데이터 구조화 절대 규칙]
1. 정량 데이터의 Integer 변환 (완벽 고정): 매출액(annual_revenue)과 누적 투자금(total_investment_amount)은 어떠한 텍스트도 포함하지 말고 오직 '원' 단위의 순수 숫자(Integer)로 계산하여 기입하세요. (예: "21억" -> 2100000000, "15억" -> 1500000000, "40억" -> 4000000000). 매출액 원본 문자열은 sales_amount 필드에 기재하세요.
2. 가치사슬 ENUM 태깅: 기업의 기술 작동 현장이 1차 생산(농장/재배)이면 "1_Production", 2차 가공(푸드테크/식품공장)이면 "2_Processing", 3차 유통/소비면 "3_Distribution", 모르면 "9_Unknown" 중 무조건 하나의 문자열만 출력하세요. agrifood_value_chain 필드에도 한글로 추출내용을 적어주세요.
3. Boolean 및 Confidence 제어: green_bio_or_smart_agri 항목은 "maybe" 같은 애매한 문자열이 아닌, 반드시 객체 { "is_matched": boolean, "confidence_score": float(0.0~1.0), "justification": "문자열" } 형태로 반환하세요.
4. 모든 필드 복구 필수: 누락된 필드가 없도록 아래 제시된 [출력 포맷 (JSON)]의 모든 키값을 채우십시오. 데이터가 없으면 빈 문자열("") 혹은 0으로 알맞게 채워야 합니다.

[추출 대상 필드 정의]
- company_name_or_alias: 회사명
- region: 소재지 주소 (예: "경기도 성남시")
- industry_field: 산업 분야 요약
- product_tech_summary: 상용화 대상 및 기술 요약 (1~2문장)
- current_stage: 현재 성장 단계 (예: "상용화 및 양산 단계")
- applicant_type: 신청 주체 유형 (예: "중소기업", "스타트업")
- venture_confirmation_status: 벤처기업 인증 여부 ("yes" 또는 "no")
- investment_status: 정성적 투자 유치 현황 (예: "시리즈 A 단계 투자 유치 완료")
- establishment_date: 설립년월일 (YYYY-MM-DD 형식 고수)
- sales_amount: 매출액 원본 텍스트 (예: "2,100백만 원" 또는 "21억 원")
- employee_count: 고용 인원 숫자 ("명" 제외 오직 Integer 숫자만)
- sme_status: 중소기업 여부 ("중소기업" 또는 "해당")
- top_needs_or_pain_points: 기업이 현재 가장 필요로 하는 지원 요약
- agrifood_value_chain: 가치사슬 단계 명칭 ("1차 생산", "2차 가공", "3차 유통/소비" 중 하나)
- has_overseas_partner_or_loi: 해외 파트너/MOU/LoI 증빙이 확인되면 "yes", 단순 목표치뿐이거나 없으면 "no"
- youth_founder_condition_status: 대표자 청년 요건 해당 여부 ("yes" 또는 "no")
- technology_transfer_status: 기술이전 여부 ("completed", "in_progress", "not_applicable")
- certification_or_test_need: 인증/테스트 필요성 요약
- sales_record_status: 매출 실적 유무 요약 
- export_intent: 해외 진출 의지 및 목표 단계 ("active", "planned", "none")
- target_country_or_market: 타겟 국가 또는 시장명
- green_bio_or_smart_agri_flag: 그린바이오/스마트농업 연관성 문자열 요약 ("yes", "maybe", "no")
- total_investment_amount: [절대규칙 1] 누적 투자유치 금액 (Integer, 원 단위 숫자)
- annual_revenue: [절대규칙 1] 연 매출액 (Integer, 원 단위 숫자)
- value_chain_tag: [절대규칙 2] 가치사슬 기계어 ENUM 코드
- green_bio_or_smart_agri: [절대규칙 3] 불리언 및 확신도 검증 객체
- has_own_factory: 자체 제조 인프라(공장) 보유 여부 ("yes" 또는 "no")
- government_awards_certificates: 정부/기관 주관 수상 및 인증 이력 (문자열)
- geographic_advantage: 지리적 가점 위치 또는 특정 클러스터 소재지 (문자열)

[압축된 문서]
${condensedText}

[출력 포맷 (JSON)]
반드시 아래 구조의 순수한 JSON 포맷으로만 응답해야 하며, 텍스트 값 내부에 큰따옴표(")를 중복 사용하지 마세요.
{
  "company_name_or_alias": "",
  "region": "",
  "industry_field": "",
  "product_tech_summary": "",
  "current_stage": "",
  "applicant_type": "",
  "venture_confirmation_status": "",
  "investment_status": "",
  "establishment_date": "",
  "sales_amount": "",
  "employee_count": 0,
  "sme_status": "",
  "top_needs_or_pain_points": "",
  "agrifood_value_chain": "",
  "has_overseas_partner_or_loi": "",
  "youth_founder_condition_status": "",
  "technology_transfer_status": "",
  "certification_or_test_need": "",
  "sales_record_status": "",
  "export_intent": "",
  "target_country_or_market": "",
  "green_bio_or_smart_agri_flag": "",
  "total_investment_amount": 0,
  "annual_revenue": 0,
  "value_chain_tag": "",
  "has_own_factory": "",
  "government_awards_certificates": "",
  "geographic_advantage": "",
  "green_bio_or_smart_agri": {
    "is_matched": false,
    "confidence_score": 0.0,
    "justification": ""
  }
}
규칙을 준수하여 온전한 JSON으로만 응답하세요.`;

    const reqData = JSON.stringify({
      model: "gemma4",
      prompt: finalPrompt,
      stream: false,
      format: "json",
      // 💡 초과열 상태인 4코어 8GB VM 환경을 위한 리스크 방어형 스펙 다운사이징
      options: { 
        temperature: 0.1, 
        seed: 42,
        num_thread: 3,   // 🎯 4에서 3으로 하향: 시스템 안정성 확보 및 다른 프로세스 먹통 방지
        num_ctx: 3072    // 🎯 4096에서 3072로 완화: 텍스트 유실을 최소화하면서 RAM 점유율을 80% 이하로 유도
      }
    });

    const aiData = await new Promise((resolve, reject) => {
      const options = { 
          hostname: 'localhost', port: 11434, path: '/api/generate', method: 'POST', 
          headers: { 
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(reqData)
          } 
      };
      const reqClient = http.request(options, (res) => {
        let body = '';
        res.on('data', (c) => body += c);
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
      });
      reqClient.on('error', reject);
      reqClient.write(reqData);
      reqClient.end();
    });

    let ai;
    try {
        const cleanResponse = (aiData.response || "{}").replace(/```json/g, '').replace(/```/g, '').trim();
        ai = JSON.parse(cleanResponse);
    } catch (parseErr) {
        console.error("⚠️ AI 응답 파싱 실패:", aiData.response);
        throw new Error("AI가 올바른 JSON을 반환하지 않았습니다.");
    }

    // 💡 기존의 안정적인 mapField 로직 유지 및 확장
    const mapField = (target, key, val) => {
      if (val !== undefined && val !== null && val !== "null") {
          target[key] = { field: key, value: val, confidence: 0.9, source_type: "ai", status: "draft" };
      } else {
          target[key] = { field: key, value: "", confidence: 0.0, source_type: "ai", status: "draft" };
      }
    };

    // 1. 기본 텍스트 정보 매핑 (draft_fields 영역)
    mapField(draft.draft_fields, "company_name_or_alias", ai.company_name_or_alias);
    mapField(draft.draft_fields, "region", ai.region);
    mapField(draft.draft_fields, "industry_field", ai.industry_field);
    mapField(draft.draft_fields, "product_tech_summary", ai.product_tech_summary);
    mapField(draft.draft_fields, "top_needs_or_pain_points", ai.top_needs_or_pain_points);

    // 2. 행정용 필수 팩트 필드 완벽 복구 매핑 (v2_safe_candidate_fields 영역)
    mapField(draft.v2_safe_candidate_fields, "establishment_date", ai.establishment_date);
    mapField(draft.v2_safe_candidate_fields, "current_stage", ai.current_stage);
    mapField(draft.v2_safe_candidate_fields, "applicant_type", ai.applicant_type);
    mapField(draft.v2_safe_candidate_fields, "venture_confirmation_status", ai.venture_confirmation_status);
    mapField(draft.v2_safe_candidate_fields, "investment_status", ai.investment_status);
    mapField(draft.v2_safe_candidate_fields, "sme_status", ai.sme_status);
    mapField(draft.v2_safe_candidate_fields, "sales_amount", ai.sales_amount);
    mapField(draft.v2_safe_candidate_fields, "employee_count", ai.employee_count);

    // 3. 기존 심층 매칭 요건 및 서사 필드 복구 매핑
    mapField(draft.v2_safe_candidate_fields, "agrifood_value_chain", ai.agrifood_value_chain);
    mapField(draft.v2_safe_candidate_fields, "has_overseas_partner_or_loi", ai.has_overseas_partner_or_loi);
    mapField(draft.v2_safe_candidate_fields, "youth_founder_condition_status", ai.youth_founder_condition_status);
    mapField(draft.v2_safe_candidate_fields, "technology_transfer_status", ai.technology_transfer_status);
    mapField(draft.v2_safe_candidate_fields, "certification_or_test_need", ai.certification_or_test_need);
    mapField(draft.v2_safe_candidate_fields, "sales_record_status", ai.sales_record_status);
    mapField(draft.v2_safe_candidate_fields, "export_intent", ai.export_intent);
    mapField(draft.v2_safe_candidate_fields, "target_country_or_market", ai.target_country_or_market);
    mapField(draft.v2_safe_candidate_fields, "green_bio_or_smart_agri_flag", ai.green_bio_or_smart_agri_flag);

    // 4. 신규 고도화 정량적 숫자 및 검증 구조 매핑
    mapField(draft.v2_safe_candidate_fields, "total_investment_amount", ai.total_investment_amount);
    mapField(draft.v2_safe_candidate_fields, "annual_revenue", ai.annual_revenue);
    mapField(draft.v2_safe_candidate_fields, "value_chain_tag", ai.value_chain_tag);
    mapField(draft.v2_safe_candidate_fields, "green_bio_or_smart_agri", ai.green_bio_or_smart_agri);
    
    // 💡 [신규 스키마] 제조 인프라, 수상 이력, 지리적 가점 메모리 바인딩
    mapField(draft.v2_safe_candidate_fields, "has_own_factory", ai.has_own_factory);
    mapField(draft.v2_safe_candidate_fields, "government_awards_certificates", ai.government_awards_certificates);
    mapField(draft.v2_safe_candidate_fields, "geographic_advantage", ai.geographic_advantage);

    draft.notes = "성공적으로 추출되었습니다.";
    console.log(`✅ [AI 정밀 추출 완료] 기존 필드 복구 및 고도화 정량 데이터 추출 완벽 성공!`);
  } catch (error) {
    console.error("❌ 추출 에러:", error);
    draft.notes = "추출 중 오류 발생";
  }
  return draft;
}

// 핵심 2: 자동 완성(Autofill) API 핸들러
async function handleGenerateAutofillDraft(req, res) {
  const now = new Date().toISOString();
  let caseId = null;
  let draftPath = null;
  let extractionManifestRel = null;

  try {
    const contentType = String(req.headers["content-type"] || "");
    if (!contentType.includes("application/json")) {
      return utils.json(res, 415, { ok: false, error: "application/json request body is required." });
    }

    const body = await utils.readRequestBody(req);
    let payload;
    try {
      payload = JSON.parse(body || "{}");
    } catch {
      return utils.json(res, 400, { ok: false, error: "Invalid JSON request body." });
    }
    const extraKeys = Object.keys(payload).filter((key) => key !== "case_id");
    if (extraKeys.length) {
      return utils.json(res, 400, { ok: false, error: "Only case_id is accepted for auto-fill draft generation." });
    }

    const rawCaseId = String(payload.case_id || "").trim();

    if (!rawCaseId) {
      return utils.json(res, 400, { ok: false, error: "case_id is required before generating an auto-fill draft." });
    }

    // 🟢 [물리 경로 동형화 완벽 해결] 실제 언더바(_) 폴더 구조가 존재한다면 변환을 우회하여 경로 파괴를 원천 방어합니다.
    const underscoredDir = path.resolve(config.UPLOADS, rawCaseId);
    if (await pathExists(underscoredDir)) {
      caseId = rawCaseId;
    } else {
      caseId = utils.slugify(rawCaseId);
    }

    const uploadDir = path.resolve(config.UPLOADS, caseId);
    const extractionManifestPath = path.join(uploadDir, "extraction_manifest.json");
    const targetDraftPath = path.join(uploadDir, "autofill_draft.json");

    // 🟢 [캐시 이중 바인딩 안전 장치] 실제 AI 추출물 데이터 유무를 파악하여 프론트엔드 호환 규격으로 완벽하게 조립 반환합니다.
    try {
      if (await pathExists(targetDraftPath)) {
        const existingRaw = await fs.readFile(targetDraftPath, "utf8");
        const existing = JSON.parse(existingRaw);
        
        const hasRealAiData = existing && (
            (existing.draft_fields && Object.keys(existing.draft_fields).length > 0) || 
            (existing.v2_safe_candidate_fields && Object.keys(existing.v2_safe_candidate_fields).length > 0)
        );

        if (hasRealAiData) {
          console.log(`[Cache Hit] '${caseId}'의 최신 고도화 추출물이 정상 존재합니다. 캐시 데이터를 즉시 화면에 뿌려줍니다.`);
          return utils.json(res, 200, {
            ok: true,
            case_id: caseId,
            source_file: existing.source_extracted_path ? path.basename(existing.source_extracted_path) : "uploaded_file.pdf",
            draft: existing, // 프론트엔드 최신 UI 렌더링용 바인딩
            extraction_payload: existing // 레거시 프로토콜 백업 컴포넌트용 바인딩
          });
        }
      }
      throw new Error("Trigger AI extraction");
    } catch (err) {
      // 🔴 [오타 완벽 수정] 자바스크립트 문법에 맞게 console.log로 원복하여 500 Internal Error 크래시를 원천 제거합니다.
      console.log(`[Logic] 기존 추출물이 없거나 캐시 유효성을 검사할 수 없어 AI 정밀 파이프라인을 기동합니다.`);
    }

    draftPath = targetDraftPath;
    extractionManifestRel = toRepoPath(extractionManifestPath);

    if (!(await pathExists(extractionManifestPath))) {
      return writeBlockedDraft(404, "Successful Step 4 extraction is required before generating an auto-fill draft.");
    }

    const extractionManifest = JSON.parse(await fs.readFile(extractionManifestPath, "utf8"));
    
    // 🟢 언더바/하이픈 혼용으로 인한 억울한 ID 불일치 거부 버그 해결 (식별자 정규화 비교)
    const normalizeId = (id) => String(id || "").replace(/[-_]/g, "").trim().toLowerCase();
    if (normalizeId(extractionManifest.case_id) !== normalizeId(caseId)) {
    
      return writeBlockedDraft(400, "Extraction manifest case_id does not match.");
    }
    const sourceRelPath = extractionManifest.extracted_markdown_path || extractionManifest.extracted_text_path;
    const sourcePath = fromRepoPath(sourceRelPath);

    let extractedText;
    try {
      extractedText = await fs.readFile(sourcePath, "utf8");
    } catch {
      return writeBlockedDraft(500, "Extracted text file exists but could not be read.");
    }

    // 🟢 [스마트 본문 지문 매칭 - 동일 파일 재분석 방지 완벽 구원 패치]
    // 프론트엔드가 매번 새로운 case_id를 발급하더라도, 본문 텍스트가 일치하는 과거 기록이 있다면 AI 비용 없이 즉시 복원합니다.
    try {
      const hashMapPath = path.join(config.RUNTIME, "hash_map.json");
      if (await pathExists(hashMapPath)) {
        const hashMap = JSON.parse(await fs.readFile(hashMapPath, "utf8"));
        const TARGET_VERSION = "1.1"; // hashHandlers.js의 CURRENT_PIPELINE_VERSION과 동기화
        
        for (const [fileHash, entry] of Object.entries(hashMap)) {
          if (entry.case_id && entry.pipeline_version === TARGET_VERSION && entry.case_id !== caseId) {
            const oldDraftPath = path.join(config.UPLOADS, entry.case_id, "autofill_draft.json");
            const oldManifestPath = path.join(config.UPLOADS, entry.case_id, "extraction_manifest.json");
            
            if (await pathExists(oldDraftPath) && await pathExists(oldManifestPath)) {
              const oldManifest = JSON.parse(await fs.readFile(oldManifestPath, "utf8"));
              const oldSourceRelPath = oldManifest.extracted_markdown_path || oldManifest.extracted_text_path;
              const oldSourcePath = path.resolve(config.ROOT, "..", oldSourceRelPath);
              
              if (await pathExists(oldSourcePath)) {
                const oldText = await fs.readFile(oldSourcePath, "utf8");
                
                // 본문 내용이 토씨 하나 안 틀리고 완전히 같다면 동일 파일 캐시 히트!
                if (oldText === extractedText) {
                  console.log(`[Smart Text Match Hit] 기존 case_id('${entry.case_id}')와 본문이 100% 일치하는 캐시를 발견했습니다. AI 추출을 건너뜁니다.`);
                  const cachedDraft = JSON.parse(await fs.readFile(oldDraftPath, "utf8"));
                  
                  // 현재 발급된 새 case_id 규칙에 맞게 메타데이터만 갱신 후 하이브리드 복사 저장
                  cachedDraft.case_id = caseId;
                  cachedDraft.source_extracted_path = sourcePath;
                  cachedDraft.source_extraction_manifest_path = extractionManifestPath;
                  
                  await fs.writeFile(targetDraftPath, JSON.stringify(cachedDraft, null, 2), "utf8");
                  
                  return utils.json(res, 200, {
                    ok: true,
                    case_id: caseId,
                    autofill_draft_path: toRepoPath(targetDraftPath),
                    draft: cachedDraft,
                    message: "Auto-fill draft successfully restored from smart text identity cache."
                  });
                }
              }
            }
          }
        }
      }
    } catch (cacheErr) {
      console.warn("⚠️ 스마트 캐시 본문 대조 중 경미한 예외 발생 (안전을 위해 AI 신규 추출로 전환):", cacheErr.message);
    }

    console.time("⏱️ [측정] 2. AI 초안 추출 엔진 (Gemma4)");
    const draft = await generateAutofillDraftWithAI(extractedText, caseId, sourcePath, extractionManifestPath, now);
    console.timeEnd("⏱️ [측정] 2. AI 초안 추출 엔진 (Gemma4)");
    
    await fs.writeFile(draftPath, JSON.stringify(draft, null, 2), "utf8");

    return utils.json(res, 200, {
      ok: true,
      case_id: caseId,
      autofill_draft_path: toRepoPath(draftPath),
      draft,
      message: "Auto-fill draft generated."
    });
  } catch (error) {
    return utils.json(res, 500, {
      ok: false,
      case_id: caseId,
      autofill_draft_path: draftPath ? toRepoPath(draftPath) : null,
      message: "Auto-fill draft generation failed.",
      error: error.message
    });
  }
}

// 메인 서버에서 사용할 수 있게 내보냅니다.
module.exports = {
  handleGenerateAutofillDraft
};