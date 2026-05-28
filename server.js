// server.js
const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
// config.js에서 설정값들 한 번에 불러오기
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

// utils.js에서 공통 도우미 함수들 불러오기
const {
  send, json, slugify, slugifyCaseIdCandidate, formatUploadTimestamp, generateUploadCaseId, readRequestBody
} = require("./utils.js");

const hashHandlers = require("./hashHandlers.js");
const pdfHandlers = require("./pdfHandlers.js");
const aiHandlers = require("./aiHandlers.js");
const v2Handlers = require("./v2Handlers.js");
const matchHandlers = require("./matchHandlers.js");

// 누락되었던 핸들러 파일들을 메인 서버에 연결해 줍니다! 🚀
const resultHandlers = require("./resultHandlers.js");
const v2PipelineHandlers = require("./v2PipelineHandlers.js");

let cachedV2ProgramIndex = null;
let cachedV2ProgramIndexPath = null;



async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "GET" && url.pathname === "/") {
    const html = await fs.readFile(path.join(__dirname, "index.html"), "utf8");
    return send(res, 200, html, "text/html; charset=utf-8");
  }
  if (req.method === "GET" && url.pathname === "/demo.html") {
    const html = await fs.readFile(path.join(__dirname, "demo.html"), "utf8");
    return send(res, 200, html, "text/html; charset=utf-8");
  }
  // --- [수정 코드] demo_v2.html 경로 추가 ---
  if (req.method === "GET" && url.pathname === "/demo_v2.html") {
    const html = await fs.readFile(path.join(__dirname, "demo_v2.html"), "utf8");
    return send(res, 200, html, "text/html; charset=utf-8");
  }
// 1. 매칭 및 파이프라인 엔진 (v2Handlers, hashHandlers, pdfHandlers, aiHandlers)
  if (req.method === "POST" && url.pathname === "/api/save") return v2Handlers.handleSave(req, res);
  if (req.method === "POST" && url.pathname === "/api/generate-pass1-request") return v2Handlers.handleGeneratePass1Request(req, res);
  if (req.method === "POST" && url.pathname === "/api/check-duplicate-file") return hashHandlers.handleCheckDuplicateFile(req, res);
  if (req.method === "POST" && url.pathname === "/api/save-duplicate-hash") return hashHandlers.handleSaveDuplicateHash(req, res);
  if (req.method === "POST" && url.pathname === "/api/upload-pdf") return pdfHandlers.handleUploadPdf(req, res);
  if (req.method === "POST" && url.pathname === "/api/extract-uploaded-pdf") return pdfHandlers.handleExtractUploadedPdf(req, res);
  if (req.method === "POST" && url.pathname === "/api/generate-autofill-draft") return aiHandlers.handleGenerateAutofillDraft(req, res);
  if (req.method === "POST" && url.pathname === "/api/generate-v2-safe-input") return v2Handlers.handleGenerateV2SafeInput(req, res);
  if (req.method === "POST" && url.pathname === "/api/retrieve-v2-candidates") return v2PipelineHandlers.handleRetrieveV2Candidates(req, res);
  if (req.method === "POST" && url.pathname === "/api/build-v2-ai-matcher-package") return v2Handlers.handleBuildV2AiMatcherPackage(req, res);
  if (req.method === "POST" && url.pathname === "/api/prepare-v2-package-from-company-input") return v2Handlers.handlePrepareV2PackageFromCompanyInput(req, res);
  if (req.method === "POST" && url.pathname === "/api/run-v2-pipeline") return v2PipelineHandlers.handleRunV2Pipeline(req, res);
  if (req.method === "POST" && url.pathname === "/api/run-matcher") return v2Handlers.handleRunMatcher(req, res);

  // 2. V1 AI 매칭 엔진 실행 (matchHandlers) ✅
  if (req.method === "POST" && url.pathname.startsWith("/api/fast-match/run/")) return matchHandlers.handleRunFastMatch(req, res, url);
  if (req.method === "POST" && url.pathname.startsWith("/api/gemma-match/run/")) return matchHandlers.handleRunGemmaMatch(req, res, url);

  // 3. GET 요청 결과 조회 전용 (resultHandlers) ✅
  if (req.method === "GET" && url.pathname.startsWith("/api/gemma-match-result/")) return resultHandlers.handleLoadGemmaMatchResult(req, res, url);
  if (req.method === "GET" && url.pathname === "/api/load-pass1-result") return resultHandlers.handleLoadPass1Result(req, res, url);
  if (req.method === "GET" && url.pathname === "/api/load-followup-needed") return resultHandlers.handleLoadFollowupNeeded(req, res, url);
  if (req.method === "GET" && url.pathname === "/api/load-followup-answers") return resultHandlers.handleLoadFollowupAnswers(req, res, url);
  if (req.method === "GET" && url.pathname === "/api/load-refined-result") return resultHandlers.handleLoadRefinedResult(req, res, url);
  if (req.method === "GET" && url.pathname === "/api/load-redacted-preview") return resultHandlers.handleLoadRedactedPreview(req, res, url);
  if (req.method === "GET" && url.pathname.startsWith("/api/fast-match-result/")) return resultHandlers.handleLoadFastMatchResult(req, res, url);
  if (req.method === "GET" && url.pathname.startsWith("/api/v2-pipeline-result/")) return resultHandlers.handleLoadV2PipelineResultViewModel(req, res, url);
  if (req.method === "GET" && url.pathname.startsWith("/api/v2-result-view-model-sample/")) return resultHandlers.handleLoadV2ResultViewModelSample(req, res, url);
  if (req.method === "GET" && url.pathname === "/api/load-result-view-model") return resultHandlers.handleLoadResultViewModel(req, res, url);
  if (req.method === "GET" && url.pathname === "/api/load") return resultHandlers.handleLoad(req, res, url);
  
  if (req.method === "GET" && url.pathname === "/tailwind.js") {
    try {
      const scriptContent = await fs.readFile(path.join(__dirname, "tailwind.js"), "utf8");
      return send(res, 200, scriptContent, "application/javascript; charset=utf-8");
    } catch (err) {
      console.error("tailwind.js 파일을 찾을 수 없습니다:", err);
      // 파일이 없으면 그냥 아래의 404 에러로 넘어갑니다.
    }
  }
  return json(res, 404, { ok: false, error: "Not found" });
}

http.createServer(handleRequest).listen(PORT, () => {
  console.log(`🚀 워크스페이스가 준비되었습니다! 아래 주소를 Ctrl+클릭(또는 Cmd+클릭) 하세요:`);
  console.log(`👉 http://localhost:${PORT}/demo_v2.html`);
});
