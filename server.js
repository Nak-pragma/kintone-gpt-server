import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

// ✅ ChatGPT呼び出し用エンドポイント
app.post("/chat", async (req, res) => {
  try {
    const { project_id, messages } = req.body;

    const completion = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-5",
        messages: [
          { role: "system", content: `あなたは製造業R&D支援AIノア。Project:${project_id}` },
          ...messages
        ]
      }),
    });

    const result = await completion.json();
    res.json({ answer: result.choices[0].message.content });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ✅ Render確認用のテストエンドポイント（動作テスト）
app.get("/", (req, res) => {
  res.send("✅ ChatGPT relay server is running!");
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`🚀 Server running on port ${port}`));
