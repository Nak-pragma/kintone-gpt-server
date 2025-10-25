/**
 * ==========================================================
 *  server_v1.0.9.js
 *  ✅ Kintone × OpenAI Assistant (Thread + VectorStore + HTML保存)
 *  ✅ GPTモデル選択対応（gpt-5含む）
 * ==========================================================
 */
import express from "express";
import fetch from "node-fetch";
import OpenAI from "openai";
import { marked } from "marked";
import DOMPurify from "isomorphic-dompurify";
import cors from "cors";
import fs from "fs";

const pkg = JSON.parse(fs.readFileSync("./node_modules/openai/package.json", "utf-8"));
console.log("✅ OpenAI SDK version:", pkg.version);

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(cors());

// ----------------------------------------------------------
// Kintone ヘルパー
// ----------------------------------------------------------
async function kGetRecords(appId, token, query) {
  const url = `https://${process.env.KINTONE_DOMAIN}/k/v1/records.json?app=${appId}&query=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { "X-Cybozu-API-Token": token } });
  const data = await res.json();
  return data.records || [];
}

async function kUpdateRecord(appId, token, id, recordObj) {
  const url = `https://${process.env.KINTONE_DOMAIN}/k/v1/record.json`;
  const body = { app: appId, id, record: recordObj };
  await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-Cybozu-API-Token": token },
    body: JSON.stringify(body)
  });
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

// beta / 非beta の差異を吸収
const A  = client.assistants ?? client.beta?.assistants;
const T  = client.threads    ?? client.beta?.threads;
const VS = client.beta?.vectorStores ?? client.vectorStores;

console.log("✅ 環境変数:", process.env.OPENAI_API_KEY ? "OK" : "MISSING");
console.log("✅ A (assistants):", !!A);
console.log("✅ T (threads):", !!T);
console.log("✅ VS (vectorStores):", !!VS);

// ----------------------------------------------------------
// /assist/thread-chat （モデル選択対応版）
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

    const selectedModel = model || "gpt-4o-mini"; // ★ デフォルト

    console.log("💬 /assist/thread-chat called:", { chatRecordId, selectedModel });

    // ---- Kintone チャットレコード取得 ----
    const chats = await kGetRecords(CHAT_APP_ID, CHAT_TOKEN, `$id = ${chatRecordId}`);
    if (chats.length === 0) throw new Error("Chat record not found");
    const chat = chats[0];

    let assistantId   = chat.assistant_id?.value;
    let threadId      = chat.thread_id?.value;
    let vectorStoreId = chat.vector_store_id?.value;
    const assistantConfig =
      chat.assistant_config?.value || "あなたは誠実で丁寧な日本語アシスタントです。";

    console.log("💬 Existing IDs:", { assistantId, threadId, vectorStoreId });

    if (!A?.create)  throw new Error("assistants.create unavailable");
    if (!T?.create)  throw new Error("threads.create unavailable");
    if (!VS?.create) throw new Error("vectorStores.create unavailable");

    // ---- Assistant作成 ----
    if (!assistantId) {
      const a = await A.create({
        name: `Chat-${chatRecordId}`,
        instructions: assistantConfig,
        model: selectedModel,
        tools: [{ type: "file_search" }]
      });
      assistantId = a.id;
      await kUpdateRecord(CHAT_APP_ID, CHAT_TOKEN, chat.$id.value, { assistant_id: { value: assistantId } });
      console.log(`✅ Assistant created: ${assistantId}`);
    }

    // ---- Thread作成 ----
    if (!threadId) {
      const t = await T.create();
      threadId = t.id;
      await kUpdateRecord(CHAT_APP_ID, CHAT_TOKEN, chat.$id.value, { thread_id: { value: threadId } });
      console.log(`✅ Thread created: ${threadId}`);
    }

    // ---- VectorStore作成 ----
    if (!vectorStoreId) {
      const vs = await VS.create({ name: `vs-${chatRecordId}` });
      vectorStoreId = vs.id;
      await kUpdateRecord(CHAT_APP_ID, CHAT_TOKEN, chat.$id.value, { vector_store_id: { value: vectorStoreId } });
      console.log(`✅ Vector Store created: ${vectorStoreId}`);
    }

    // ---- 資料送信処理 ----
    if (documentId) {
      if (!DOC_APP_ID || !DOC_TOKEN) throw new Error("Kintone document env not set");
      const docs = await kGetRecords(DOC_APP_ID, DOC_TOKEN, `documentID = "${documentId}"`);
      if (docs.length === 0) throw new Error("Document not found");
      const doc = docs[0];
      const attach = doc.file_attach?.value?.[0];
      if (attach) {
        const buf = await kDownloadFile(attach.fileKey, DOC_TOKEN);
        const upload = await client.files.create({
          file: new File([Buffer.from(buf)], attach.name, { type: "application/octet-stream" }),
          purpose: "assistants"
        });
        await client.vectorStores.fileBatches.createAndPoll(vectorStoreId, { file_ids: [upload.id] });
        console.log(`✅ Document "${documentId}" uploaded to Vector Store ${vectorStoreId}`);
      }
    }

    // ---- メッセージ送信 ----
    if (message && message.trim()) {
      if (!T?.messages?.create) throw new Error("threads.messages.create unavailable");
      await T.messages.create(threadId, { role: "user", content: message });
    }

    // ---- Run実行（モデル指定版）----
    if (!T?.runs?.create) throw new Error("threads.runs.create unavailable");
    const run = await T.runs.create(threadId, {
      assistant_id: assistantId,
      model: selectedModel, // ★ ここでユーザー選択モデルを適用
      tool_resources: { file_search: { vector_store_ids: [vectorStoreId] } },
      instructions: "日本語で論理的かつ構造的に回答してください。"
    });

    // ---- 完了待ち ----
    let status = run.status;
    while (["queued", "in_progress"].includes(status)) {
      await new Promise((r) => setTimeout(r, 1200));
      const check = await T.runs.retrieve(threadId, run.id);
      status = check.status;
    }

    // ---- メッセージ取得 ----
    const msgs = await T.messages.list(threadId, { order: "desc", limit: 1 });
    const reply = msgs.data[0]?.content?.[0]?.text?.value || "（返答なし）";
    const htmlReply = DOMPurify.sanitize(marked.parse(reply));

    const newRow = {
      value: {
        user_message: { value: message || `📎 資料送信: ${documentId}` },
        ai_reply: { value: htmlReply },
        model_used: { value: selectedModel } // ★ 使用モデルを記録
      }
    };
    const newLog = (chat.chat_log?.value || []).concat(newRow);
    await kUpdateRecord(CHAT_APP_ID, CHAT_TOKEN, chat.$id.value, { chat_log: { value: newLog } });

    res.json({ reply: htmlReply, model: selectedModel, threadId, assistantId, vectorStoreId });

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
// /document-summary: 資料要約＋タグ自動生成
// ----------------------------------------------------------
app.post("/document-summary", async (req, res) => {
  try {
    const { appId, recordId, text } = req.body;
    if (!text) return res.status(400).json({ error: "Missing text" });

    console.log("📘 /document-summary called:", { appId, recordId });

    const prompt = `
あなたは製造業R&D・ナレッジマネジメント分野の専門AIです。
以下の文書を200〜300字で要約し、内容に適した英語タグを3〜6個出してください。
出力は純粋なJSONのみで返してください。

出力形式:
{
  "summary": "要約文",
  "tags": ["tag1", "tag2", "tag3"]
}

本文:
${text}
`;

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
    });

    const output = completion.choices[0].message.content || "{}";
    console.log("🧠 Raw Output:", output);

    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("JSON parse error");
    const parsed = JSON.parse(jsonMatch[0]);
    const summary = parsed.summary || "";
    const tags = parsed.tags || [];

    // ---- Kintone反映 ----
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
// GitHub ファイル参照API
// ----------------------------------------------------------
app.get("/github/file", async (req, res) => {
  try {
    const { path } = req.query;
    if (!path) return res.status(400).json({ error: "Missing ?path parameter" });

    // 固定で特定リポジトリのみ許可（安全性確保）
    const repo = "Nak-pragma/kintone-gpt-server";
    const url = `https://api.github.com/repos/${repo}/contents/${path}`;

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
    res.json({ path, content });

  } catch (e) {
    console.error("❌ /github/file Error:", e);
    res.status(500).json({ error: e.message });
  }
});


// ----------------------------------------------------------
// 健康チェック
// ----------------------------------------------------------
app.get("/", (req, res) => res.send("✅ Server is alive"));

// ----------------------------------------------------------
// サーバ起動
// ----------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
