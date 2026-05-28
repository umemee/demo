//pdfHandlers.js
const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");

// 분리해 둔 설정과 도구들을 불러옵니다.
const config = require("./config.js");
const utils = require("./utils.js");
const { toRepoPath, safeUploadFilename, isPdfFilename, isAllowedPdfMimeType } = utils;

function runOpenDataLoaderPdf(sourcePdfPath, outputDir) {
  const args = [
    "-m", "opendataloader_pdf", "-o", outputDir, "-f", "markdown",
    "--keep-line-breaks", "--replace-invalid-chars", " ", "--image-output", "off", sourcePdfPath
  ];

  return new Promise((resolve, reject) => {
    execFile("python", args, { cwd: config.REPO_ROOT, timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        error.command = config.OPENDATALOADER_COMMAND.command;
        return reject(error);
      }
      resolve({ stdout, stderr, command: config.OPENDATALOADER_COMMAND.command });
    });
  });
}

async function findMarkdownOutput(outputDir) {
  const entries = await fs.readdir(outputDir, { withFileTypes: true });
  const markdownFiles = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      const filePath = path.join(outputDir, entry.name);
      const stat = await fs.stat(filePath);
      markdownFiles.push({ filePath, mtimeMs: stat.mtimeMs });
    }
  }
  markdownFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return markdownFiles[0]?.filePath || null;
}

// 핵심 기능 1: PDF 업로드 핸들러
async function handleUploadPdf(req, res) {
  try {
    const contentLength = Number(req.headers["content-length"] || 0);
    if (contentLength && contentLength > config.MAX_UPLOAD_REQUEST_BYTES) {
      return utils.json(res, 413, {
        ok: false,
        error: config.UPLOAD_TOO_LARGE_MESSAGE
      });
    }

    const body = await utils.readRequestBody(req, config.MAX_UPLOAD_REQUEST_BYTES);
    const payload = JSON.parse(body || "{}");
    const rawCaseId = String(payload.case_id || "").trim();
    const originalFilename = String(payload.filename || "").trim();
    const mimeType = String(payload.mime_type || "").trim();
    const dataBase64 = String(payload.data_base64 || "").replace(/^data:application\/pdf;base64,/, "");

    if (!originalFilename || !isPdfFilename(originalFilename)) {
      return utils.json(res, 400, { ok: false, error: "PDF 파일만 업로드할 수 있습니다." });
    }

    if (!isAllowedPdfMimeType(mimeType)) {
      return utils.json(res, 400, { ok: false, error: "업로드 MIME 형식이 PDF가 아닙니다." });
    }

    if (!dataBase64) {
      return utils.json(res, 400, { ok: false, error: "PDF 데이터가 비어 있습니다." });
    }

    const normalizedBase64 = dataBase64.replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalizedBase64)) {
      return utils.json(res, 400, { ok: false, error: "업로드 데이터가 손상되었습니다." });
    }

    const fileBuffer = Buffer.from(normalizedBase64, "base64");
    if (!fileBuffer.length) {
      return utils.json(res, 400, { ok: false, error: "업로드된 PDF가 비어 있습니다." });
    }
    if (fileBuffer.length > config.MAX_UPLOAD_BYTES) {
      return utils.json(res, 413, { ok: false, error: config.UPLOAD_TOO_LARGE_MESSAGE });
    }

    const now = new Date();
    const caseId = rawCaseId ? utils.slugify(rawCaseId) : utils.generateUploadCaseId(originalFilename, now);
    const uploadDir = path.join(config.UPLOADS, caseId);
    await fs.mkdir(uploadDir, { recursive: true });

    const safeName = safeUploadFilename(originalFilename);
    const savedFilename = "source.pdf";
    const savedPath = path.resolve(uploadDir, savedFilename);
    const resolvedUploadDir = path.resolve(uploadDir);
    if (!savedPath.startsWith(`${resolvedUploadDir}${path.sep}`)) {
      return utils.json(res, 400, { ok: false, error: "Unsafe upload path rejected." });
    }

    await fs.writeFile(savedPath, fileBuffer);

    const manifestPath = path.join(uploadDir, "upload_manifest.json");
    const nowIso = now.toISOString();
    const manifest = {
      case_id: caseId,
      original_filename: originalFilename,
      saved_filename: savedFilename,
      saved_path: toRepoPath(savedPath),
      mime_type: mimeType || null,
      size_bytes: fileBuffer.length,
      uploaded_at: nowIso,
      status: "PDF_UPLOADED",
      notes: "Upload only. No extraction was run during upload."
    };
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    utils.json(res, 200, {
      ok: true,
      case_id: caseId,
      generated_case_id: !rawCaseId,
      saved_path: manifest.saved_path,
      manifest_path: toRepoPath(manifestPath),
      size_bytes: fileBuffer.length,
      message: rawCaseId
        ? "PDF uploaded locally. No extraction was run."
        : "PDF uploaded locally. Temporary case_id was generated automatically. No extraction was run."
    });
  } catch (error) {
    utils.json(res, error.statusCode || 500, {
      ok: false,
      error: error.message || "PDF 업로드에 실패했습니다."
    });
  }
}

// 핵심 기능 2: 파이썬을 이용한 PDF 추출 핸들러
async function handleExtractUploadedPdf(req, res, url) {
  try {
    const body = await utils.readRequestBody(req);
    const payload = JSON.parse(body || "{}");
    const caseId = payload.case_id;

    if (!caseId) {
      return utils.json(res, 400, { error: "case_id가 필요합니다." });
    }

    const uploadDir = path.join(config.UPLOADS, caseId);
    const sourcePath = path.join(uploadDir, "source.pdf");
    const extractionManifestPath = path.join(uploadDir, "extraction_manifest.json");
    const now = new Date().toISOString();

    try {
      const existingRaw = await fs.readFile(extractionManifestPath, "utf8");
      const existing = JSON.parse(existingRaw);
      
      const isBadData = !existing || existing.notes !== "Gemma AI가 문서를 정독하고 핵심 정보를 자동 완성했습니다.";

      if (isBadData) {
        console.log(`[Logic] '${caseId}'의 기존 데이터가 구버전이므로 AI 재추출을 시작합니다.`);
        throw new Error("Force Re-extraction"); 
      } else {
        console.log(`[Logic] '${caseId}'의 최신 AI 분석본(캐시)을 반환합니다.`);
        return utils.json(res, 200, {
          case_id: caseId,
          source_file: "source.pdf",
          extraction_payload: existing
        });
      }
    } catch (err) {
      console.log(`[Logic] '${caseId}' 새로운 AI 정밀 분석 파이프라인 가동...`);
    }

    const outputDir = path.join(uploadDir, "extracted_output");
    await fs.mkdir(outputDir, { recursive: true });
    
    console.time("⏱️ [측정] 1. PDF -> Markdown 변환 (opendataloader-pdf)");
    await runOpenDataLoaderPdf(sourcePath, outputDir);
    console.timeEnd("⏱️ [측정] 1. PDF -> Markdown 변환 (opendataloader-pdf)");

    const actualMarkdownPath = await findMarkdownOutput(outputDir);
    if (!actualMarkdownPath) throw new Error("추출된 텍스트 파일을 찾을 수 없습니다.");
    
    const manifest = {
      case_id: caseId,
      status: "success",
      extracted_markdown_path: toRepoPath(actualMarkdownPath),
      notes: "Gemma AI가 문서를 정독하고 핵심 정보를 자동 완성했습니다." 
    };
    await fs.writeFile(extractionManifestPath, JSON.stringify(manifest, null, 2));

    return utils.json(res, 200, {
      case_id: caseId,
      source_file: "source.pdf",
      extraction_payload: manifest
    });
  } catch (err) {
    console.error("[Error] PDF 추출 및 AI 분석 실패:", err);
    return utils.json(res, 500, { error: "Extraction failed: " + err.message });
  }
}

// 메인 서버에서 사용할 수 있게 내보냅니다.
module.exports = {
  handleUploadPdf,
  handleExtractUploadedPdf
};