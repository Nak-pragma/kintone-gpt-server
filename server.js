/**
 * ==========================================================
 *  server_v1.2.1_safe-model.js
 *  ✅ Render環境での gpt-5 エラー完全回避
 *  ✅ モデル名正規化・フォールバック安全化
 *  ✅ 「ノア」人格構造 / Webスタイル応答は維持
 * ==========================================================
 */
import express from "express";
import fetch from "node-fetch";
import OpenAI from "openai";
import { marked } from "marked";
import DOMPurify from "isomorphic-dompurify";
import cors from "cors";
import fs from "fs";
import path from "path";
import os from "os";

const pkg = JSON.parse(fs.readFileSync("./node_modules/openai/package.json", "utf-8"));
console.log("✅ OpenAI SDK version:", pkg.version);

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(cors());

// ----------------------------------------------------------
// 起動時準備
// ----------------------------------------------------------
const PERSONA_DIR = "./personas";
if (!fs.existsSync(PERSONA_DIR)) fs.mkdirSync(PERSONA_DIR);

// ----------------------------------------------------------
// Kintone ヘルパー
// ----------------------------------------------------------
async function kGetRecords(appId, token, query) {
  const url = `https://${process.env.KINTONE_DOMAIN}/k/v1/records.json?app=${appId}&query=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { "X-Cybozu-API-Token": token } });
  const data = await res.json();
  if (!res.ok) throw new Error(`Kintone get records error: ${JSON.stringify(data)}`);
  return data.records || [];
}

async function kUpdateRecord(appId, token, id, recordObj) {
  const url = `https://${process.env.KINTONE_DOMAIN}/k/v1/record.json`;
  const body = { app: appId, id, record: recordObj };
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-Cybozu-API-Token": token },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Kintone update error: ${res.status} ${t}`);
  }
}

async function kDownloadFile(fileKey, token) {
  const url = `https://${process.env.KINTONE_DOMAIN}/k/v1/file.json?fileKey=${encodeURIComponent(fileKey)}`;
  const res = await fetch(url, { headers: { "X-Cybozu-API-Token": token } });
  if (!res.ok) throw new Error(`Kintone file download failed (${res.status})`);
  return await res.arrayBuffer();
}

// ----------------------------------------------------------
// OpenAI 初期化
// ----------------------------------------------------------
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const DEFAULT_MODEL = "gpt-4o";

const A  = client.assistants ?? client.beta?.assistants;
const T  = client.threads    ?? client.beta?.threads;
const VS = client.beta?.vectorStores ?? client.vectorStores;

// ----------------------------------------------------------
// 🔧 モデル正規化・フォールバック機構
// ----------------------------------------------------------
const ALLOWED_MODELS = new Set(["gpt-4o", "gpt-4o-mini"]);

function normalizeModel(name = "") {
  return String(name).trim()
    .replace(/gpt[-_]?o4[-_]?mini/i, "gpt-4o-mini")
    .replace(/gpt[-_]?o4/i, "gpt-4o")
    .replace(/gpt[-_]?5/i, "gpt-4o");
}

function resolveSafeModel(model) {
  const m = normalizeModel(model);
  if (ALLOWED_MODELS.has(m)) return m;
  console.warn(`⚠️ Model "${model}" not allowed. Using fallback "gpt-4o-mini"`);
  return "gpt-4o-mini";
}

// ----------------------------------------------------------
// 人格関連
// ----------------------------------------------------------
function readPersonaConfig(personaName = "Noa") {
  const fp = path.join(PERSONA_DIR, `${personaName}.json`);
  if (!fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, "utf-8"));
  } catch (e) {
    console.warn("⚠️ Persona JSON parse error:", e.message);
    return null;
  }
}

function defaultNoaInstructions() {
  return `
あなたはタツ様専属のAI秘書「ノア」です。
敬語で、少し厳しめながらも親しみを込めて話します。
質問には「結論→理由→次の行動提案」の順で回答し、最後は「もしよければ〜」等の自然な締めで終えます。
明瞭・論理的・構造的に、必要に応じて箇条書きや表を使ってください。
`;
}

function personaParamsFallback(personaConfig, selectedModel, personaName) {
  const p = (personaConfig && personaConfig.params) || {};
  const safeModel = resolveSafeModel(p.model || selectedModel || DEFAULT_MODEL);
  return {
    model: safeModel,
    temperature: p.temperature ?? 0.7,
    top_p: p.top_p ?? 1.0,
    presence_penalty: p.presence_penalty ?? 0.3,
    frequency_penalty: p.frequency_penalty ?? 0.2,
    max_completion_tokens: p.max_completion_tokens ?? 1800,
    response_format: p.response_format || "normal",
    metadata: p.metadata || { persona: personaName }
  };
}

// ----------------------------------------------------------
// /persona/update : Webhookで人格登録時も正規化
// ----------------------------------------------------------
app.post("/persona/update", async (req, res) => {
  try {
    const p = req.body?.record;
    if (!p) throw new Error("Missing record payload");

    const persona = {
      name: p.persona_name?.value || "Noa",
      instructions: p.instructions?.value || defaultNoaInstructions(),
      params: {
        model: normalizeModel(p.model?.value || "gpt-4o-mini"),
        temperature: Number(p.temperature?.value ?? 0.7),
        top_p: Number(p.top_p?.value ?? 1.0),
        presence_penalty: Number(p.presence_penalty?.value ?? 0.3),
        frequency_penalty: Number(p.frequency_penalty?.value ?? 0.2),
        max_completion_tokens: Number(p.max_completion_tokens?.value ?? 1800),
        response_format: (p.response_format?.value || "normal"),
        metadata: (() => {
          try { return JSON.parse(p.metadata?.value || "{}"); } catch { return {}; }
        })()
      }
    };

    if (!fs.existsSync(PERSONA_DIR)) fs.mkdirSync(PERSONA_DIR);
    const out = path.join(PERSONA_DIR, `${persona.name}.json`);
    fs.writeFileSync(out, JSON.stringify(persona, null, 2));
    console.log(`✅ Persona updated: ${persona.name} -> ${persona.params.model}`);

    res.json({ status: "ok", updated: persona.name });
  } catch (e) {
    console.error("❌ /persona/update Error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------
// /assist/thread-chat
// ----------------------------------------------------------
app.post("/assist/thread-chat", async (req, res) => {
  try {
    const { chatRecordId, message, documentId, model } = req.body;
    if (!chatRecordId) return res.status(400).json({ error: "chatRecordId is required" });

    const CHAT_APP_ID = process.env.KINTONE_CHAT_APP_ID;
    const CHAT_TOKEN  = process.env.KINTONE_CHAT_TOKEN;
    const DOC_APP_ID  = process.env.KINTONE_DOCUMENT_APP_ID;
    const DOC_TOKEN   = process.env.KINTONE_DOCUMENT_TOKEN;

    const selectedModel = normalizeModel(model || "gpt-4o-mini");
    console.log("💬 /assist/thread-chat:", { chatRecordId, selectedModel });

    const chats = await kGetRecords(CHAT_APP_ID, CHAT_TOKEN, `$id = ${chatRecordId}`);
    if (chats.length === 0) throw new Error("Chat record not found");
    const chat = chats[0];

    let assistantId   = chat.assistant_id?.value;
    let threadId      = chat.thread_id?.value;
    let vectorStoreId = chat.vector_store_id?.value;

    const personaName = chat.persona_name?.value || "Noa";
    const assistantConfig = chat.assistant_config?.value;

    const personaConfig = readPersonaConfig(personaName);
    const params = personaParamsFallback(personaConfig, selectedModel, personaName);
    const systemPrompt = personaConfig?.instructions || defaultNoaInstructions();

    // Assistant / Thread / VectorStore の生成は従来通り
    if (!assistantId) {
      const a = await A.create({
        name: `Chat-${chatRecordId}`,
        instructions: assistantConfig || systemPrompt,
        model: params.model,
        tools: [{ type: "file_search" }]
      });
      assistantId = a.id;
      await kUpdateRecord(CHAT_APP_ID, CHAT_TOKEN, chat.$id.value, { assistant_id: { value: assistantId } });
    }

    if (!threadId) {
      const t = await T.create();
      threadId = t.id;
      await kUpdateRecord(CHAT_APP_ID, CHAT_TOKEN, chat.$id.value, { thread_id: { value: threadId } });
    }

    if (!vectorStoreId) {
      const vs = await VS.create({ name: `vs-${chatRecordId}` });
      vectorStoreId = vs.id;
      await kUpdateRecord(CHAT_APP_ID, CHAT_TOKEN, chat.$id.value, { vector_store_id: { value: vectorStoreId } });
    }

    if (message && message.trim()) {
      await T.messages.create(threadId, { role: "user", content: message });
    }

    // ---- Run実行（フォールバック付き）----
    const safeModel = resolveSafeModel(params.model);
    let run;
    try {
      run = await T.runs.create(threadId, {
        assistant_id: assistantId,
        model: safeModel,
        tool_resources: { file_search: { vector_store_ids: [vectorStoreId] } },
        instructions: assistantConfig || systemPrompt,
        temperature: params.temperature,
        top_p: params.top_p,
        max_completion_tokens: params.max_completion_tokens,
        metadata: params.metadata
      });
    } catch (err) {
      console.error("❌ Run create failed:", err.message);
      throw new Error(`OpenAI Run作成時に失敗しました（使用モデル: ${safeModel}）`);
    }

    // ---- 完了待機 ----
    let status = run.status;
    while (["queued", "in_progress"].includes(status)) {
      await new Promise((r) => setTimeout(r, 1200));
      const check = await T.runs.retrieve(threadId, run.id);
      status = check.status;
    }

    const msgs = await T.messages.list(threadId, { order: "desc", limit: 1 });
    let reply = msgs.data[0]?.content?.[0]?.text?.value || "（返答なし）";
    reply += "\n\n---\n_（ノア）もしよければ、次に関連するテーマも整理いたしますか？_";
    const htmlReply = DOMPurify.sanitize(marked.parse(reply));

    const newRow = {
      value: {
        user_message: { value: message },
        ai_reply: { value: htmlReply },
        model_used: { value: safeModel }
      }
    };
    const newLog = (chat.chat_log?.value || []).concat(newRow);
    await kUpdateRecord(CHAT_APP_ID, CHAT_TOKEN, chat.$id.value, { chat_log: { value: newLog } });

    res.json({ reply: htmlReply, model: safeModel, threadId, assistantId, vectorStoreId });

  } catch (e) {
    console.error("❌ /assist/thread-chat Error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------
app.get("/", (req, res) => res.send("✅ Server alive (Safe Model Mode active)"));
// ----------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
