import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import OpenAI from "openai";
import { marked } from "marked";
import DOMPurify from "isomorphic-dompurify";

dotenv.config();

const app = express();

/* 1️⃣ JSONボディを最初に処理 */
app.use(express.json({ limit: "2mb" }));

/* ==========================================================
 * ✅ 1. CORS設定（プリフライト対応）
 * ========================================================== */
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

/* ==========================================================
 * ✅ 2. /project-chat : プロジェクト文脈＋資料でのAI議論API
 * ========================================================== */
app.post("/project-chat", async (req, res) => {
  try {
    const { projectId, documentId, message } = req.body;
    if (!projectId || !documentId || !message) {
      return res.status(400).json({ error: "Missing projectId, documentId, or message" });
    }

    // --- 環境変数 ---
    const KINTONE_DOMAIN = process.env.KINTONE_DOMAIN;
    const PROJECT_APP_ID = process.env.KINTONE_PROJECT_APP_ID;
    const DOCUMENT_APP_ID = process.env.KINTONE_DOCUMENT_APP_ID;
    const PROJECT_API_TOKEN = process.env.KINTONE_PROJECT_TOKEN;
    const DOCUMENT_API_TOKEN = process.env.KINTONE_DOCUMENT_TOKEN;

    // --- 共通関数：Kintoneレコード取得 ---
    const getKintoneRecord = async (appId, apiToken, query) => {
      const url = `https://${KINTONE_DOMAIN}/k/v1/records.json?app=${appId}&query=${encodeURIComponent(query)}`;
      const response = await fetch(url, {
        headers: { "X-Cybozu-API-Token": apiToken }
      });
      const data = await response.json();
      if (!data.records || data.records.length === 0) return null;
      return data.records[0];
    };

    // --- プロジェクト情報 ---
    const projectRecord = await getKintoneRecord(PROJECT_APP_ID, PROJECT_API_TOKEN, `projectID = "${projectId}"`);
    if (!projectRecord) return res.status(404).json({ error: "Project not found" });

    // --- 資料情報 ---
    const documentRecord = await getKintoneRecord(DOCUMENT_APP_ID, DOCUMENT_API_TOKEN, `documentID = "${documentId}"`);
    if (!documentRecord) return res.status(404).json({ error: "Document not found" });

    // --- GPTへ渡すプロンプト作成 ---
    const contextPrompt = `
あなたは製造業R&D支援のAIアシスタント「ノア」です。
次のプロジェクト情報と資料をもとに、ユーザーとの議論を継続してください。
出典データの引用は不要です。

【プロジェクト情報】
目的: ${projectRecord.目的?.value || "未設定"}
目標: ${projectRecord.目標?.value || "未設定"}
スコープ: ${projectRecord.スコープ?.value || "未設定"}

【資料情報】
タイトル: ${documentRecord.タイトル?.value || "未設定"}
概要: ${documentRecord.概要?.value || "未設定"}

ユーザーの質問やコメント:
${message}
`;

    // --- GPT呼び出し ---
    const completion = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-5", // 現行環境と合わせる
        messages: [
          { role: "system", content: "あなたは製造業R&Dプロジェクト支援AI「ノア」です。誠実に、簡潔に答えてください。" },
          { role: "user", content: contextPrompt }
        ]
      })
    });

    const result = await completion.json();
    const reply = result?.choices?.[0]?.message?.content || "（返答を生成できませんでした）";

    res.json({ reply });
  } catch (error) {
    console.error("❌ /project-chat Error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});


/* ==========================================================
 * ✅ 3️⃣ /assist/thread-chat : Assistant+Thread+Vector Store対応版
 * ========================================================== */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Kintone共通関数 ---
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
    headers: {
      "Content-Type": "application/json",
      "X-Cybozu-API-Token": token
    },
    body: JSON.stringify(body)
  });
}
async function kDownloadFile(fileKey, token) {
  const url = `https://${process.env.KINTONE_DOMAIN}/k/v1/file.json?fileKey=${encodeURIComponent(fileKey)}`;
  const res = await fetch(url, { headers: { "X-Cybozu-API-Token": token } });
  if (!res.ok) throw new Error(`Kintone file download failed (${res.status})`);
  return await res.arrayBuffer();
}

// --- /assist/thread-chat 実装 ---
app.post("/assist/thread-chat", async (req, res) => {
  try {
    const { chatRecordId, message, documentId } = req.body;
    if (!chatRecordId || (!message && !documentId)) {
      return res.status(400).json({ error: "Missing chatRecordId or message" });
    }

    // --- 環境変数 ---
    const CHAT_APP_ID = process.env.KINTONE_CHAT_APP_ID;
    const CHAT_TOKEN = process.env.KINTONE_CHAT_TOKEN;
    const DOC_APP_ID = process.env.KINTONE_DOCUMENT_APP_ID;
    const DOC_TOKEN = process.env.KINTONE_DOCUMENT_TOKEN;

    // --- チャットレコード取得 ---
    const chats = await kGetRecords(CHAT_APP_ID, CHAT_TOKEN, `$id = ${chatRecordId}`);
    if (chats.length === 0) throw new Error("Chat record not found");
    const chat = chats[0];

    // --- 既存ID取得または新規作成 ---
    let assistantId = chat.assistant_id?.value;
    let threadId = chat.thread_id?.value;
    let vectorStoreId = chat.vector_store_id?.value;
    const assistantConfig = chat.assistant_config?.value || "あなたは誠実なAIアシスタントです。";

    // Assistant生成
    if (!assistantId) {
      const a = await openai.beta.assistants.create({
        name: `Chat-${chatRecordId}`,
        instructions: assistantConfig,
        model: "gpt-4o",
        tools: [{ type: "retrieval" }]
      });
      assistantId = a.id;
      await kUpdateRecord(CHAT_APP_ID, CHAT_TOKEN, chat.$id.value, { assistant_id: { value: assistantId } });
    }

    // Thread生成
    if (!threadId) {
      const t = await openai.beta.threads.create();
      threadId = t.id;
      await kUpdateRecord(CHAT_APP_ID, CHAT_TOKEN, chat.$id.value, { thread_id: { value: threadId } });
    }

    // Vector Store生成
    if (!vectorStoreId) {
      const vs = await openai.beta.vectorStores.create({ name: `vs-${chatRecordId}` });
      vectorStoreId = vs.id;
      await kUpdateRecord(CHAT_APP_ID, CHAT_TOKEN, chat.$id.value, { vector_store_id: { value: vectorStoreId } });
    }

    // --- 資料送信が指定されている場合 ---
    if (documentId) {
      const docs = await kGetRecords(DOC_APP_ID, DOC_TOKEN, `documentID = "${documentId}"`);
      if (docs.length === 0) throw new Error("Document not found");
      const doc = docs[0];
      const attach = doc.file_attach?.value?.[0];
      if (attach) {
        const buf = await kDownloadFile(attach.fileKey, DOC_TOKEN);
        const upload = await openai.files.create({
          file: new File([Buffer.from(buf)], attach.name, { type: "application/octet-stream" }),
          purpose: "assistants"
        });
        await openai.beta.vectorStores.fileBatches.uploadAndPoll(vectorStoreId, { file_ids: [upload.id] });
        console.log(`✅ Document "${documentId}" uploaded to Vector Store ${vectorStoreId}`);
      }
    }

    // --- ユーザー発話をThreadに追加 ---
    if (message && message.trim()) {
      await openai.beta.threads.messages.create(threadId, { role: "user", content: message });
    }

    // --- Run実行（Vector Store参照） ---
    const run = await openai.beta.threads.runs.create(threadId, {
      assistant_id: assistantId,
      tool_resources: { vector_store_ids: [vectorStoreId] },
      instructions: "日本語で論理的かつ構造的に回答してください。"
    });

    // --- 実行完了待ち ---
    let status = run.status;
    while (["queued", "in_progress"].includes(status)) {
      await new Promise(r => setTimeout(r, 1200));
      const check = await openai.beta.threads.runs.retrieve(threadId, run.id);
      status = check.status;
    }

    // --- 最新メッセージ取得 ---
    const msgs = await openai.beta.threads.messages.list(threadId, { order: "desc", limit: 1 });
    const reply = msgs.data[0]?.content?.[0]?.text?.value || "（返答なし）";

    // --- Markdown→HTML変換＋サニタイズ ---
    const htmlReply = DOMPurify.sanitize(marked.parse(reply));

    // --- Kintone履歴更新（HTML保存） ---
    const newRow = {
      value: {
        user_message: { value: message || `📎 資料送信: ${documentId}` },
        ai_reply: { value: htmlReply }
      }
    };
    const newLog = (chat.chat_log?.value || []).concat(newRow);
    await kUpdateRecord(CHAT_APP_ID, CHAT_TOKEN, chat.$id.value, { chat_log: { value: newLog } });

    res.json({ reply: htmlReply, threadId, assistantId, vectorStoreId });
  } catch (e) {
    console.error("❌ /assist/thread-chat Error:", e);
    res.status(500).json({ error: e.message });
  }
});





/* ==========================================================
 * ② 議事録要約API（既存）
 * ========================================================== */
app.post("/summary", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: "Missing text field" });

    const completion = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-5",
        messages: [
          {
            role: "system",
            content:
              "あなたは日本語の会議議事録を要約するアシスタントです。重要論点・決定事項・次回対応の3区分で簡潔にまとめてください。"
          },
          { role: "user", content: text }
        ]
      })
    });

    const result = await completion.json();
    const summary = result?.choices?.[0]?.message?.content ?? "（要約を生成できませんでした）";
    res.json({ summary });
  } catch (error) {
    console.error("Summary API Error:", error);
    res.status(500).json({ error: "Summary API failed" });
  }
});

/* ==========================================================
 * ③ Webサイト要約API（既存）
 * ========================================================== */
app.post("/site-summary", async (req, res) => {
  console.log("📩 POST /site-summary reached");
  try {
    const { url } = req.body;
    console.log("URL received:", url);

    if (!url) return res.status(400).json({ error: "Missing url" });

    const completion = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "あなたはWebサイトの内容を日本語で簡潔に要約するAIです。" },
          { role: "user", content: `次のサイトを要約してください：${url}` }
        ]
      })
    });

    console.log("✅ OpenAI API responded (status):", completion.status);
    const result = await completion.json();

    const messageContent = result?.choices?.[0]?.message?.content || "要約結果が取得できませんでした。";
    console.log("🧩 Summary Text:", messageContent);
    res.json({ summary: messageContent });
  } catch (error) {
    console.error("❌ Site Summary Error:", error);
    res.status(500).json({ error: error.message });
  }
});

/* ==========================================================
 * ④ 動作確認ルート
 * ========================================================== */
if (process.env.NODE_ENV !== "production") {
  app.get("/", (req, res) => res.send("✅ Pragma GPT Relay Server running (dev mode)"));
}

/* ==========================================================
 * ⑤ ポート設定
 * ========================================================== */
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`🚀 Server running on port ${port}`));
