/**
 * ==========================================================
 *  server_v1.0.8.js (patched)
 *  ✅ Kintone × OpenAI Assistant (Thread + VectorStore + HTML保存)
 *  ✅ OpenAI SDK v4.104.0 変動吸収（beta/非beta 両対応）
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

// beta / 非beta の差異を吸収（assistant/threads/vectorStores 作成系）
const A  = client.assistants ?? client.beta?.assistants;
const T  = client.threads    ?? client.beta?.threads;
const VS = client.beta?.vectorStores ?? client.vectorStores; // createはbeta寄り、fileBatchesは直下

console.log("✅ 環境変数:", process.env.OPENAI_API_KEY ? "OK" : "MISSING");
console.log("✅ client keys:", Object.keys(client));
console.log("✅ A (assistants) available:", !!A);
console.log("✅ T (threads) available:", !!T);
console.log("✅ VS (vectorStores) available:", !!VS);

// ----------------------------------------------------------
// /assist/thread-chat
// ----------------------------------------------------------
app.post("/assist/thread-chat", async (req, res) => {
  try {
    const { chatRecordId, message, documentId } = req.body;

    // 1) 入力バリデーション強化
    if (!chatRecordId) {
      return res.status(400).json({ error: "chatRecordId is required" });
    }
    if (!message && !documentId) {
      return res.status(400).json({ error: "Either message or documentId is required" });
    }

    console.log("💬 /assist/thread-chat called:", { chatRecordId, hasMessage: !!message, hasDocument: !!documentId });

    const CHAT_APP_ID = process.env.KINTONE_CHAT_APP_ID;
    const CHAT_TOKEN  = process.env.KINTONE_CHAT_TOKEN;
    const DOC_APP_ID  = process.env.KINTONE_DOCUMENT_APP_ID;
    const DOC_TOKEN   = process.env.KINTONE_DOCUMENT_TOKEN;

    if (!CHAT_APP_ID || !CHAT_TOKEN) {
      throw new Error("Kintone chat app env not set (KINTONE_CHAT_APP_ID / KINTONE_CHAT_TOKEN)");
    }

    // 2) チャットレコード取得
    const chats = await kGetRecords(CHAT_APP_ID, CHAT_TOKEN, `$id = ${chatRecordId}`);
    console.log("💬 chats.length:", chats.length);
    if (chats.length === 0) throw new Error("Chat record not found");
    const chat = chats[0];

    let assistantId   = chat.assistant_id?.value;
    let threadId      = chat.thread_id?.value;
    let vectorStoreId = chat.vector_store_id?.value;
    const assistantConfig =
      chat.assistant_config?.value || "あなたは誠実で丁寧な日本語アシスタントです。";

    console.log("💬 ids before:", { assistantId, threadId, vectorStoreId });
    console.log("assistantConfig:", assistantConfig);
    console.log("model:", "gpt-4o");

    // 3) API名の存在を実行前にチェック（新規レコード時の .create undefined を防止）
    if (!A?.create)  throw new Error("OpenAI assistants.create API not available (SDK namespace mismatch).");
    if (!T?.create)  throw new Error("OpenAI threads.create API not available (SDK namespace mismatch).");
    if (!VS?.create) throw new Error("OpenAI vectorStores.create API not available (SDK namespace mismatch).");

    // === Assistant 作成（新規レコードでだけ走る想定）===
    if (!assistantId) {
      const a = await A.create({
        name: `Chat-${chatRecordId}`,
        instructions: assistantConfig,
        model: "gpt-4o",
        tools: [{ type: "file_search" }]
      });
      assistantId = a.id;
      await kUpdateRecord(CHAT_APP_ID, CHAT_TOKEN, chat.$id.value, { assistant_id: { value: assistantId } });
      console.log(`✅ Assistant created: ${assistantId}`);
    }

    // === Thread 作成 ===
    if (!threadId) {
      const t = await T.create();
      threadId = t.id;
      await kUpdateRecord(CHAT_APP_ID, CHAT_TOKEN, chat.$id.value, { thread_id: { value: threadId } });
      console.log(`✅ Thread created: ${threadId}`);
    }

    // === Vector Store 作成 ===
    if (!vectorStoreId) {
      const vs = await VS.create({ name: `vs-${chatRecordId}` });
      vectorStoreId = vs.id;
      await kUpdateRecord(CHAT_APP_ID, CHAT_TOKEN, chat.$id.value, { vector_store_id: { value: vectorStoreId } });
      console.log(`✅ Vector Store created: ${vectorStoreId}`);
    }

    // === 資料送信（任意）===
    if (documentId) {
      if (!DOC_APP_ID || !DOC_TOKEN) throw new Error("Kintone document env not set (KINTONE_DOCUMENT_APP_ID / KINTONE_DOCUMENT_TOKEN)");
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
        // 4.104.0以降は createAndPoll（file_ids を登録）
        await client.vectorStores.fileBatches.createAndPoll(vectorStoreId, {
          file_ids: [upload.id],
        });
        console.log(`✅ Document "${documentId}" uploaded to Vector Store ${vectorStoreId}`);
      }
    }

    // === メッセージ追加 ===
    if (message && message.trim()) {
      // threads.messages は beta/非beta 両対応（T配下にぶら下がる想定）
      if (!T?.messages?.create) throw new Error("OpenAI threads.messages.create not available");
      await T.messages.create(threadId, { role: "user", content: message });
    }

    // === Run実行 ===
    if (!T?.runs?.create) throw new Error("OpenAI threads.runs.create not available");
    const run = await T.runs.create(threadId, {
      assistant_id: assistantId,
      tool_resources: { file_search: { vector_store_ids: [vectorStoreId] } },
      instructions: "日本語で論理的かつ構造的に回答してください。"
    });

    // === 完了待ち ===
    let status = run.status;
    while (["queued", "in_progress"].includes(status)) {
      await new Promise((r) => setTimeout(r, 1200));
      if (!T?.runs?.retrieve) throw new Error("OpenAI threads.runs.retrieve not available");
      const check = await T.runs.retrieve(threadId, run.id);
      status = check.status;
    }

    // === メッセージ取得 ===
    if (!T?.messages?.list) throw new Error("OpenAI threads.messages.list not available");
    const msgs = await T.messages.list(threadId, { order: "desc", limit: 1 });
    const reply = msgs.data[0]?.content?.[0]?.text?.value || "（返答なし）";

    const htmlReply = DOMPurify.sanitize(marked.parse(reply));

    const newRow = {
      value: {
        user_message: { value: message || `📎 資料送信: ${documentId}` },
        ai_reply: { value: htmlReply }
      }
    };
    const newLog = (chat.chat_log?.value || []).concat(newRow);
    await kUpdateRecord(CHAT_APP_ID, CHAT_TOKEN, chat.$id.value, { chat_log: { value: newLog } });

    console.log("💬 ids after:", { assistantId, threadId, vectorStoreId });
    res.json({ reply: htmlReply, threadId, assistantId, vectorStoreId });

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
// 健康チェック
// ----------------------------------------------------------
app.get("/", (req, res) => res.send("✅ Server is alive"));

// ----------------------------------------------------------
// サーバ起動
// ----------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
