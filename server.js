import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

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
    // ⚠️ Kintoneのプリフライト要求はここで完結させる！
    return res.sendStatus(200);
  }
  next();
});




/* ==========================================================
 * ① ChatGPT：プロジェクトチャット用
 * ========================================================== */
app.post("/chat", async (req, res) => {
  try {
    const { project_id, messages } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "Invalid messages array" });
    }

    const completion = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-5",
        messages: [
          { role: "system", content: `あなたは製造業支援AI「ノア」です。ProjectID:${project_id}` },
          ...messages
        ]
      })
    });

    const result = await completion.json();
    res.json({ answer: result.choices[0].message.content });
  } catch (error) {
    console.error("Chat API Error:", error);
    res.status(500).json({ error: "Chat API failed" });
  }
});

/* ==========================================================
 * ② 議事録要約API
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
          { role: "system", content: "あなたは日本語の会議議事録を要約するアシスタントです。" },
          { role: "user", content: text }
        ]
      })
    });

    const result = await completion.json();
    res.json({ summary: result.choices[0].message.content });
  } catch (error) {
    console.error("Summary API Error:", error);
    res.status(500).json({ error: "Summary API failed" });
  }
});

/* ==========================================================
 * ③ Webサイト要約API（URL指定）
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
        model: "gpt-4o-mini", // ← 安定版（またはgpt-5でもOK）
        messages: [
          { role: "system", content: "あなたはWebサイトの内容を日本語で簡潔に要約するAIです。" },
          { role: "user", content: `次のサイトを要約してください：${url}` }
        ]
      })
    });

    console.log("✅ OpenAI API responded (status):", completion.status);
    const result = await completion.json();

    // 🧩 ここで messageContent を先に定義
    const messageContent = result?.choices?.[0]?.message?.content || "要約結果が取得できませんでした。";

    // 🧩 ここで出力
    console.log("🧩 Summary Text:", messageContent);

    // ✅ Kintoneへ返却
    res.json({ summary: messageContent });
  } catch (error) {
    console.error("❌ Site Summary Error:", error);
    res.status(500).json({ error: error.message });
  }
});



/* ==========================================================
 * ④ 開発環境専用の確認ルート（Render正常稼働確認用）
 * ========================================================== */
if (process.env.NODE_ENV !== "production") {
  app.get("/", (req, res) => res.send("✅ Pragma GPT Relay Server running (dev mode)"));
}

/* ==========================================================
 * ⑤ ポート設定
 * ========================================================== */
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`🚀 Server running on port ${port}`));
