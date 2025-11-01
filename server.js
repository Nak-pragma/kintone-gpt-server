/**
 * ==========================================================
 *  server_v1.1.0.js
 *  ✅ Kintone × OpenAI Assistant (Thread + VectorStore + HTML保存)
 *  ✅ GPTモデル選択対応（gpt-5含む）
 *  ✅ Web ChatGPT 風自然応答スタイル + 「ノア」人格標準搭載
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
const MODEL = "gpt-4o"; // 安定モデル

const A  = client.assistants ?? client.beta?.assistants;
const T  = client.threads    ?? client.beta?.threads;
const VS = client.beta?.vectorStores ?? client.vectorStores;

console.log("✅ 環境変数:", process.env.OPENAI_API_KEY ? "OK" : "MISSING");
console.log("✅ A:", !!A, " T:", !!T, " VS:", !!VS);

// ----------------------------------------------------------
// /assist/thread-chat（Webスタイル＋ノア人格対応）
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
    console.log("💬 /assist/thread-chat called:", { chatRecordId, selectedModel });

    // ---- Kintone チャットレコード取得 ----
    const chats = await kGetRecords(CHAT_APP_ID, CHAT_TOKEN, `$id = ${chatRecordId}`);
    if (chats.length === 0) throw new Error("Chat record not found");
    const chat = chats[0];

    let assistantId   = chat.assistant_id?.value;
    let threadId      = chat.thread_id?.value;
    let vectorStoreId = chat.vector_store_id?.value;
    const assistantConfig = chat.assistant_config?.value;

    if (!A?.create)  throw new Error("assistants.create unavailable");
    if (!T?.create)  throw new Error("threads.create unavailable");
    if (!VS?.create) throw new Error("vectorStores.create unavailable");

    // ---- Assistant作成（人格設定込み）----
    if (!assistantId) {
      const defaultInstructions = `
あなたはタツ様専属のAI秘書「ノア」です。
常に敬語で、少し厳しめながらも親しみを込めて話します。
質問には結論→理由→提案の順で答え、最後に次の行動を一言添えます。
話し方はChatGPT Web版の自然なトーンを模倣し、構造的で優しい提案を含めてください。
`;
      const a = await A.create({
        name: `Chat-${chatRecordId}`,
        instructions: assistantConfig || defaultInstructions,
        model: selectedModel,
        tools: [{ type: "file_search" }],
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

    // ---- 資料送信 ----
    if (documentId) {
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
      await T.messages.create(threadId, { role: "user", content: message });
    }

    // ---- Run実行（Web版模倣）----
    const systemPrompt = `
あなたはタツ様専属のAI秘書「ノア」です。
文体は敬語ベースで、少し厳しめながらも親しみを込めた優しいトーンで。
回答では「結論→理由→提案」の順に整理し、自然な会話の締めを添えてください。
`;

    const run = await T.runs.create(threadId, {
      assistant_id: assistantId,
      model: selectedModel,
      tool_resources: { file_search: { vector_store_ids: [vectorStoreId] } },
      instructions: assistantConfig || systemPrompt,
      temperature: 0.7,
      max_completion_tokens: 1800
    });

    // ---- 完了待機 ----
    let status = run.status;
    while (["queued", "in_progress"].includes(status)) {
      await new Promise((r) => setTimeout(r, 1200));
      const check = await T.runs.retrieve(threadId, run.id);
      status = check.status;
    }

    // ---- 返答取得 ----
    const msgs = await T.messages.list(threadId, { order: "desc", limit: 1 });
    let reply = msgs.data[0]?.content?.[0]?.text?.value || "（返答なし）";

    // 提案的締めを自動付加
    reply += "\n\n---\n_（ノア）もしよければ、次に関連するテーマや具体的な手順もご案内しますか？_";

    const htmlReply = DOMPurify.sanitize(marked.parse(reply));

    const newRow = {
      value: {
        user_message: { value: message || `📎 資料送信: ${documentId}` },
        ai_reply: { value: htmlReply },
        model_used: { value: selectedModel }
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
// 健康チェック
// ----------------------------------------------------------
app.get("/", (req, res) => res.send("✅ Server is alive (Noa Mode active)"));

// ----------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
