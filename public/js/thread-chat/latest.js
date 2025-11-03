(function() {
  "use strict";

  const SPACE_ID = "chat_space";
  const RENDER_API = "https://kintone-gpt-server-qpwl.onrender.com/assist/thread-chat";

  const loadMarked = () =>
    new Promise((resolve, reject) => {
      if (window.marked) return resolve();
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/marked/marked.min.js";
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });

  kintone.events.on("app.record.detail.show", async (event) => {
    const record = event.record;
    const spaceEl = kintone.app.record.getSpaceElement(SPACE_ID);
    if (!spaceEl) return event;
    spaceEl.innerHTML = "";
    await loadMarked();

    const assistantConfig = record.assistant_config?.value?.trim();
    if (!assistantConfig) {
      console.log("⚠️ assistant_config 未設定。サーバ側でデフォルト人格を使用します。");
    }

    const title = document.createElement("h4");
    title.textContent = "🤖 ノアとのチャット（Markdown＋資料対応）";
    title.style.marginBottom = "8px";
    spaceEl.appendChild(title);

    const chatBox = document.createElement("div");
    chatBox.style.cssText = `border:1px solid #ccc;border-radius:8px;padding:8px;height:300px;overflow-y:auto;background:#fafafa;font-size:14px;`;
    spaceEl.appendChild(chatBox);

    const inputArea = document.createElement("textarea");
    inputArea.placeholder = "ノアに質問・相談を入力...";
    inputArea.style.cssText = `width:100%;height:60px;margin-top:8px;border-radius:6px;padding:6px;resize:vertical;`;
    spaceEl.appendChild(inputArea);

    const sendBtn = document.createElement("button");
    sendBtn.textContent = "送信";
    sendBtn.style.cssText = `margin-top:6px;padding:6px 12px;background:#4472C4;color:#fff;border:none;border-radius:4px;cursor:pointer;`;
    spaceEl.appendChild(sendBtn);

    const sendDocBtn = document.createElement("button");
    sendDocBtn.textContent = "📚 資料を送信";
    sendDocBtn.style.cssText = `margin-top:6px;margin-left:6px;padding:6px 12px;background:#5C9E5C;color:#fff;border:none;border-radius:4px;cursor:pointer;`;
    spaceEl.appendChild(sendDocBtn);

    let markdownLog = record.chat_log_text?.value || "";

    const appendMsg = (sender, msg, isMarkdown = false, save = false) => {
      const div = document.createElement("div");
      div.style.margin = "8px 0";
      const content = isMarkdown ? marked.parse(msg) : msg;
      div.innerHTML = `<b style=\"color:${sender === "ノア" ? "#4472C4" : "#333"}\">${sender}：</b> ${content}`;
      chatBox.appendChild(div);
      chatBox.scrollTop = chatBox.scrollHeight;

      if (save) {
        markdownLog += `\n\n**${sender}：**\n${msg}`;
        saveChatLog(markdownLog);
      }
    };

    const saveChatLog = async (text) => {
      try {
        await kintone.api(kintone.api.url("/k/v1/record", true), "PUT", {
          app: kintone.app.getId(),
          id: record.$id.value,
          record: { chat_log_text: { value: text } }
        });
      } catch (e) {
        console.error("❌ チャットログ保存エラー:", e);
      }
    };

    if (markdownLog) appendMsg("履歴", markdownLog, true);

    sendBtn.onclick = async () => {
      const userMsg = inputArea.value.trim();
      if (!userMsg) return;
      appendMsg("あなた", userMsg, false, true);
      inputArea.value = "";
      sendBtn.disabled = true;
      appendMsg("ノア", "<em>考えています...</em>");

      try {
        const res = await fetch(RENDER_API, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chatRecordId: kintone.app.record.getId(), message: userMsg })
        });
        const data = await res.json();
        const last = chatBox.querySelector("em");
        if (last) last.parentElement.remove();
        appendMsg("ノア", data.reply || "（返答なし）", true, true);
      } catch (e) {
        appendMsg("ノア", `⚠️ エラーが発生しました: ${e.message}`);
      } finally {
        sendBtn.disabled = false;
      }
    };

    sendDocBtn.onclick = async () => {
      const docNumber = record.lookup_doc?.value; // 例: DC-0001
      if (!docNumber) {
        alert("📎 資料が選択されていません。ルックアップで選択してください。");
        return;
      }
      appendMsg("あなた", `📎 資料「${docNumber}」をノアに送信`, false, true);
      appendMsg("ノア", "<em>資料を読み込んでいます...</em>");

      try {
        const docAppId = 20;
        const queryRes = await kintone.api(kintone.api.url("/k/v1/records", true), "GET", {
          app: docAppId,
          query: `documentID = \"${docNumber}\"`
        });

        if (queryRes.records.length === 0) {
          appendMsg("ノア", "⚠️ 資料が見つかりませんでした。", false, true);
          return;
        }

        const docRecordId = queryRes.records[0].$id.value;
        const docRes = await kintone.api(kintone.api.url("/k/v1/record", true), "GET", {
          app: docAppId,
          id: docRecordId
        });

        const fileInfo = docRes.record.file_attach?.value?.[0];
        if (!fileInfo) {
          appendMsg("ノア", "⚠️ 資料に添付ファイルが見つかりませんでした。", false, true);
          return;
        }

        const fileKey = fileInfo.fileKey;
        const fileName = fileInfo.name;

        const res = await fetch(RENDER_API, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chatRecordId: kintone.app.record.getId(),
            documentId: docRecordId,
            fileKey: fileKey,
            fileName: fileName,
            message: `この資料（${fileName}）を参照してください。`
          })
        });

        const data = await res.json();
        const last = chatBox.querySelector("em");
        if (last) last.parentElement.remove();
        appendMsg("ノア", data.reply || "（返答なし）", true, true);
      } catch (e) {
        appendMsg("ノア", `⚠️ 資料送信エラー: ${e.message}`);
      }
    };

    return event;
  });
})();