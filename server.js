/**
 * ==========================================================
 *  server_v1.0.4.js
 *  ✅ Kintone × OpenAI Assistant (Thread + VectorStore + HTML保存)
 * ==========================================================
 */
import express from "express";
import fetch from "node-fetch";
import OpenAI from "openai";
import { marked } from "marked";
import DOMPurify from "isomorphic-dompurify";

const app = express();
app.use(express.json({ limit: "20mb" }));

// ----------------------------------------------------------
// 共通関数：Kintone APIラッパー
// ----------------------------------------------------------
async function kGetRecords(appId, token, query) {
  const url = `https://${process.env.KINTONE_DOMAIN}/k/v1/records.json?app=${appId}&query=${encodeURIComponent(
    query
  )}`;
  const res = await fetch(url, {
    headers: { "X-Cybozu-API-Token": token }
  });
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

// ----------------------------------------------------------
// OpenAI初期化
// ----------------------------------------------------------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ----------------------------------------------------------
// 既存API: /summary, /site-summary, /project-chat
// （※省略：既存コードを残してOK）
// ----------------------------------------------------------

// ----------------------------------------------------------
// 新API: /assist/thread-chat
// ----------------------------------------------------------
app.post("/assist/thread-chat", async (req, res) => {
  try {
    const { chatRecordId, message, documentId } = req.body;
    if (!chatRecordId || (!message && !documentId)) {
      return res.status(400).json({ error: "Missing chatRecordId or message" });
    }

    // === 環境変数 ===
    const CHAT_APP_ID = process.env.KINTONE_CHAT_APP_ID;
    const CHAT_TOKEN = process.env.KINTONE_CHAT_TOKEN;
    const DOC_APP_ID = process.env.KINTONE_DOCUMENT_APP_ID;
    const DOC_TOKEN = process.env.KINTONE_DOCUMENT_TOKEN;

    // === チャットレコード取得 ===
    const chats = await kGetRecords(CHAT_APP_ID, CHAT_TOKEN, `$id = ${chatRecordId}`);
    if (chats.length === 0) throw new Error("Chat record not found");
    const chat = chats[0];

    // === ID類の取得または新規作成 ===
    let assistantId = chat.assistant_id?.value;
    let threadId = chat.thread_id?.value;
    let vectorStoreId = chat.vector_store_id?.value;
    const assistantConfig =
      chat.assistant_config?.value || "あなたは誠実で丁寧な日本語アシスタントです。";

    // === Assistant作成 ===
    if (!assistantId) {
      const a = await openai.beta.assistants.create({
        name: `Chat-${chatRecordId}`,
        instructions: assistantConfig,
        model: "gpt-4o",
        tools: [{ type: "file_search" }] // ✅ 最新仕様
      });
      assistantId = a.id;
      await kUpdateRecord(CHAT_APP_ID, CHAT_TOKEN, chat.$id.value, {
        assistant_id: { value: assistantId }
      });
      console.log(`✅ Assistant created: ${assistantId}`);
    }

    // === Thread作成 ===
    if (!threadId) {
      const t = await openai.beta.threads.create();
      threadId = t.id;
      await kUpdateRecord(CHAT_APP_ID, CHAT_TOKEN, chat.$id.value, {
        thread_id: { value: threadId }
      });
      console.log(`✅ Thread created: ${threadId}`);
    }

    // === Vector Store作成 ===
    if (!vectorStoreId) {
      const vs = await openai.beta.vectorStores.create({
        name: `vs-${chatRecordId}`
      });
      vectorStoreId = vs.id;
      await kUpdateRecord(CHAT_APP_ID, CHAT_TOKEN, chat.$id.value, {
        vector_store_id: { value: vectorStoreId }
      });
      console.log(`✅ Vector Store created: ${vectorStoreId}`);
    }

    // === 資料送信（documentId指定時） ===
    if (documentId) {
      const docs = await kGetRecords(
        DOC_APP_ID,
        DOC_TOKEN,
        `documentID = "${documentId}"`
      );
      if (docs.length === 0) throw new Error("Document not found");
      const doc = docs[0];
      const attach = doc.file_attach?.value?.[0];
      if (attach) {
        const buf = await kDownloadFile(attach.fileKey, DOC_TOKEN);
        const upload = await openai.files.create({
          file: new File([Buffer.from(buf)], attach.name, {
            type: "application/octet-stream"
          }),
          purpose: "assistants"
        });
        await openai.beta.vectorStores.fileBatches.uploadAndPoll(vectorStoreId, {
          file_ids: [upload.id]
        });
        console.log(
          `✅ Document "${documentId}" uploaded to Vector Store ${vectorStoreId}`
        );
      }
    }

    // === ユーザーメッセージ追加 ===
    if (message && message.trim()) {
      await openai.beta.threads.messages.create(threadId, {
        role: "user",
        content: message
      });
    }

    // === Run実行 ===
    const run = await openai.beta.threads.runs.create(threadId, {
      assistant_id: assistantId,
      tool_resources: { vector_store_ids: [vectorStoreId] },
      instructions: "日本語で論理的かつ構造的に回答してください。"
    });

    // === 完了待ち ===
    let status = run.status;
    while (["queued", "in_progress"].includes(status)) {
      await new Promise((r) => setTimeout(r, 1200));
      const check = await openai.beta.threads.runs.retrieve(threadId, run.id);
      status = check.status;
    }

    // === 最新メッセージ取得 ===
    const msgs = await openai.beta.threads.messages.list(threadId, {
      order: "desc",
      limit: 1
    });
    const reply = msgs.data[0]?.content?.[0]?.text?.value || "（返答なし）";

    // === Markdown→HTML変換 + サニタイズ ===
    const htmlReply = DOMPurify.sanitize(marked.parse(reply));

    // === Kintone履歴更新 ===
    const newRow = {
      value: {
        user_message: { value: message || `📎 資料送信: ${documentId}` },
        ai_reply: { value: htmlReply }
      }
    };
    const newLog = (chat.chat_log?.value || []).concat(newRow);
    await kUpdateRecord(CHAT_APP_ID, CHAT_TOKEN, chat.$id.value, {
      chat_log: { value: newLog }
    });

    res.json({ reply: htmlReply, threadId, assistantId, vectorStoreId });
  } catch (e) {
    console.error("❌ /assist/thread-chat Error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------
// サーバ起動
// ----------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
