/**
 * ==========================================================
 *  server_v1.2.0.js
 *  ✅ Kintone × OpenAI Assistant (Thread + VectorStore + HTML保存)
 *  ✅ 人格管理アプリ連携（Webhookで自動反映）/ personas/*.json を動的読込
 *  ✅ Web ChatGPT 風自然応答スタイル + 「ノア」人格標準搭載
 *  ✅ GPTモデル選択対応（gpt-5含む）/ 温度・出力量ほかAPIパラメータ人格別適用
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
const DEFAULT_MODEL = "gpt-4o"; // 安定

// beta / 非beta の差異を吸収
const A  = client.assistants ?? client.beta?.assistants;
const T  = client.threads    ?? client.beta?.threads;
const VS = client.beta?.vectorStores ?? client.vectorStores;

console.log("✅ Env OPENAI_API_KEY:", process.env.OPENAI_API_KEY ? "OK" : "MISSING");
console.log("✅ A:", !!A, " T:", !!T, " VS:", !!VS);

// ----------------------------------------------------------
// ユーティリティ
// ----------------------------------------------------------
function readPersonaConfig(personaName = "Noa") {
  const fp = path.join(PERSONA_DIR, `${personaName}.json`);
  if (!fs.existsSync(fp)) return null;
  try {
    const obj = JSON.parse(fs.readFileSync(fp, "utf-8"));
    return obj;
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
  return {
    model: p.model || selectedModel || DEFAULT_MODEL,
    temperature: p.temperature ?? 0.7,
    top_p: p.top_p ?? 1.0,
    presence_penalty: p.presence_penalty ?? 0.3,
    frequency_penalty: p.frequency_penalty ?? 0.2,
    max_completion_tokens: p.max_completion_tokens ?? 1800,
    response_format: p.response_format || "normal",
    metadata: p.metadata || { persona: personaName }
  };
}

async function uploadToOpenAIFromBuffer(buf, filename) {
  // 一時ファイルに出力 → createReadStream でアップロード
  const tmp = path.join(os.tmpdir(), `${Date.now()}_${filename}`);
  await fs.promises.writeFile(tmp, Buffer.from(buf));
  try {
    const file = await client.files.create({
      file: fs.createReadStream(tmp),
      purpose: "assistants"
    });
    return file;
  } finally {
    // クリーンアップ（失敗しても致命的ではないのでtry-catch無し）
    fs.promises.unlink(tmp).catch(() => {});
  }
}

// ----------------------------------------------------------
// /persona/update : Kintone Webhook で人格を更新・永続化
// ----------------------------------------------------------
app.post("/persona/update", async (req, res) => {
  try {
    const p = req.body?.record;
    if (!p) throw new Error("Missing record payload");

    const persona = {
      name: p.persona_name?.value || "Noa",
      instructions: p.instructions?.value || defaultNoaInstructions(),
      params: {
        model: p.model?.value || "gpt-5",
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
    console.log(`✅ Persona updated: ${persona.name} -> ${out}`);

    res.json({ status: "ok", updated: persona.name });
  } catch (e) {
    console.error("❌ /persona/update Error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------
// /assist/thread-chat（人格読込＋Webスタイル模倣）
// ----------------------------------------------------------
app.post("/assist/thread-chat", async (req, res) => {
  try {
    const { chatRecordId, message, documentId, model } = req.body;
    if (!chatRecordId) return res.status(400).json({ error: "chatRecordId is required" });
    if (!message && !documentId) return res.status(400).json({ error: "Either message or documentId is required" });

    const CHAT_APP_ID = process.env.KINTONE_CHAT_APP_ID;
    const CHAT_TOKEN  = process.env.KINTONE_CHAT_TOKEN;
    const DOC_APP_ID  = process.env.KINTONE_DOCUMENT_APP_ID;
    const DOC_TOKEN   = process.env.KINTONE_DOCUMENT_TOKEN;

    const selectedModel = model || "gpt-4o-mini";
    console.log("💬 /assist/thread-chat:", { chatRecordId, selectedModel });

    // ---- Kintone チャットレコード取得 ----
    const chats = await kGetRecords(CHAT_APP_ID, CHAT_TOKEN, `$id = ${chatRecordId}`);
    if (chats.length === 0) throw new Error("Chat record not found");
    const chat = chats[0];

    let assistantId   = chat.assistant_id?.value;
    let threadId      = chat.thread_id?.value;
    let vectorStoreId = chat.vector_store_id?.value;

    // 人格名（Kintoneのフィールドがあれば採用、無ければNoa）
    const personaName = chat.persona_name?.value || "Noa";
    const assistantConfig = chat.assistant_config?.value; // 任意の追加instructions

    if (!A?.create)  throw new Error("assistants.create unavailable");
    if (!T?.create)  throw new Error("threads.create unavailable");
    if (!VS?.create) throw new Error("vectorStores.create unavailable");

    // ---- Assistant作成（初回）----
    if (!assistantId) {
      const a = await A.create({
        name: `Chat-${chatRecordId}`,
        instructions: assistantConfig || defaultNoaInstructions(),
        model: selectedModel,
        tools: [{ type: "file_search" }]
      });
      assistantId = a.id;
      await kUpdateRecord(CHAT_APP_ID, CHAT_TOKEN, chat.$id.value, { assistant_id: { value: assistantId } });
      console.log(`✅ Assistant created: ${assistantId}`);
    }

    // ---- Thread作成（初回）----
    if (!threadId) {
      const t = await T.create();
      threadId = t.id;
      await kUpdateRecord(CHAT_APP_ID, CHAT_TOKEN, chat.$id.value, { thread_id: { value: threadId } });
      console.log(`✅ Thread created: ${threadId}`);
    }

    // ---- VectorStore作成（初回）----
    if (!vectorStoreId) {
      const vs = await VS.create({ name: `vs-${chatRecordId}` });
      vectorStoreId = vs.id;
      await kUpdateRecord(CHAT_APP_ID, CHAT_TOKEN, chat.$id.value, { vector_store_id: { value: vectorStoreId } });
      console.log(`✅ Vector Store created: ${vectorStoreId}`);
    }

    // ---- 資料送信（任意）----
    if (documentId) {
      const docs = await kGetRecords(DOC_APP_ID, DOC_TOKEN, `documentID = "${documentId}"`);
      if (docs.length === 0) throw new Error("Document not found");
      const doc = docs[0];
      const attach = doc.file_attach?.value?.[0];
      if (attach) {
        const buf = await kDownloadFile(attach.fileKey, DOC_TOKEN);
        const upload = await uploadToOpenAIFromBuffer(buf, attach.name);
        await client.vectorStores.fileBatches.createAndPoll(vectorStoreId, { file_ids: [upload.id] });
        console.log(`✅ Document "${documentId}" uploaded to Vector Store ${vectorStoreId}`);
      }
    }

    // ---- メッセージ送信 ----
    if (message && String(message).trim()) {
      if (!T?.messages?.create) throw new Error("threads.messages.create unavailable");
      await T.messages.create(threadId, { role: "user", content: message });
    }

    // ---- 人格JSON読込＆パラメータ適用 ----
    const personaConfig = readPersonaConfig(personaName);
    if (personaConfig) {
      console.log(`🧩 Persona loaded: ${personaName}`);
    } else {
      console.warn(`⚠️ Persona file not found, using default: ${personaName}`);
    }

    const systemPrompt = personaConfig?.instructions || defaultNoaInstructions();
    const params = personaParamsFallback(personaConfig, selectedModel, personaName);

    console.log("🧠 Applied persona parameters:", JSON.stringify({
      name: personaName,
      model: params.model,
      temperature: params.temperature,
      max_completion_tokens: params.max_completion_tokens
    }, null, 2));

    // ---- Run実行（Webスタイル模倣＋人格パラメータ）----
    if (!T?.runs?.create) throw new Error("threads.runs.create unavailable");
    const run = await T.runs.create(threadId, {
      assistant_id: assistantId,
      model: params.model,
      tool_resources: { file_search: { vector_store_ids: [vectorStoreId] } },
      instructions: assistantConfig || systemPrompt,
      temperature: params.temperature,
      top_p: params.top_p,
     
      max_completion_tokens: params.max_completion_tokens,
      metadata: params.metadata
    });

    // ---- 完了待機 ----
    let status = run.status;
    while (["queued", "in_progress"].includes(status)) {
      await new Promise((r) => setTimeout(r, 1200));
      const check = await T.runs.retrieve(threadId, run.id);
      status = check.status;
    }

    if (status !== "completed") {
      const r = await T.runs.retrieve(threadId, run.id);
      console.warn("⚠️ Run not completed:", r.status, r.last_error);
    }

    // ---- 返答取得 ----
    const msgs = await T.messages.list(threadId, { order: "desc", limit: 1 });
    let reply = msgs.data[0]?.content?.[0]?.text?.value || "（返答なし）";

    // 提案的締めを自動付加（ノア・Web風）
    reply += "\n\n---\n_（ノア）もしよければ、次に関連するテーマや具体的な手順もご案内しますか？_";

    const htmlReply = DOMPurify.sanitize(marked.parse(reply));

    const newRow = {
      value: {
        user_message: { value: message || `📎 資料送信: ${documentId}` },
        ai_reply: { value: htmlReply },
        model_used: { value: params.model }
      }
    };
    const newLog = (chat.chat_log?.value || []).concat(newRow);
    await kUpdateRecord(CHAT_APP_ID, CHAT_TOKEN, chat.$id.value, { chat_log: { value: newLog } });

    res.json({ reply: htmlReply, model: params.model, threadId, assistantId, vectorStoreId });

  } catch (e) {
    console.error("❌ /assist/thread-chat Error:", e);
    if (e.response) {
      try {
        const text = await e.response.text();
        console.error("🧩 OpenAI API Response:", text);
      } catch {}
    }
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------
// 🔧 ヘルパー：テキスト分割と要約・タグ
// ----------------------------------------------------------
function chunkText(text, maxLength = 10000) {
  const chunks = [];
  for (let i = 0; i < text.length; i += maxLength) chunks.push(text.slice(i, i + maxLength));
  return chunks;
}

async function summarizeLongText(text, model = DEFAULT_MODEL) {
  const chunks = chunkText(text);
  const summaries = [];
  console.log(`🧩 ${chunks.length} チャンクに分割して要約します`);
  for (const chunk of chunks) {
    const res = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: `次のテキストを200字で要約してください。\n${chunk}` }],
      temperature: 0.3
    });
    summaries.push(res.choices[0].message.content);
  }
  const finalRes = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: `以下の要約を統合して300字でまとめてください:\n${summaries.join("\n")}` }],
    temperature: 0.3
  });
  return finalRes.choices[0].message.content.trim();
}

async function generateTags(text, model = DEFAULT_MODEL) {
  const prompt = `
以下の文章から関連する英語タグを3〜6個出してください。
出力形式は ["tag1","tag2"] のJSON配列のみ。
文章：
${text.slice(0, 8000)}
`;
  const res = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3
  });
  const m = res.choices[0].message.content.match(/\[.*\]/s);
  return m ? JSON.parse(m[0]) : [];
}

// ----------------------------------------------------------
// /document-summary : 長文要約＋タグ自動生成
// ----------------------------------------------------------
app.post("/document-summary", async (req, res) => {
  try {
    const { appId, recordId, text } = req.body;
    if (!text) return res.status(400).json({ error: "Missing text" });

    console.log("📘 /document-summary called:", { appId, recordId });

    const summary = await summarizeLongText(text);
    const tags = await generateTags(summary);

    if (appId && recordId) {
      await kUpdateRecord(appId, process.env.KINTONE_DOCUMENT_TOKEN, recordId, {
        summary: { value: summary },
        tags: { value: tags },
        status: { value: "完了" }
      });
      console.log(`✅ Record ${recordId} updated with AI summary`);
    }

    res.json({ summary, tags });
  } catch (e) {
    console.error("❌ /document-summary Error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------
// GitHub ファイル参照API（安全用簡易プロキシ）
// ----------------------------------------------------------
app.get("/github/file", async (req, res) => {
  try {
    const { path: ghPath } = req.query;
    if (!ghPath) return res.status(400).json({ error: "Missing ?path parameter" });

    const repo = "Nak-pragma/kintone-gpt-server"; // 固定
    const url = `https://api.github.com/repos/${repo}/contents/${ghPath}`;

    const resp = await fetch(url, {
      headers: {
        "Authorization": `token ${process.env.GITHUB_TOKEN}`,
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "pragma-server"
      }
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`GitHub API error ${resp.status}: ${text}`);
    }

    const data = await resp.json();
    if (!data.content) throw new Error("No content in response");

    const content = Buffer.from(data.content, "base64").toString("utf-8");
    res.json({ path: ghPath, content });

  } catch (e) {
    console.error("❌ /github/file Error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------
// 健康チェック
// ----------------------------------------------------------
app.get("/", (req, res) => res.send("✅ Server is alive (Persona Mode active)"));

// ----------------------------------------------------------
// サーバ起動
// ----------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
