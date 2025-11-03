(function() {
  "use strict";

  const APP_ID_DOCUMENTS = 20;                // 資料管理アプリID
  const API_TOKEN = "8lplC1Ia2LAg7C22lEGrCZdYQqq2stE5YRR6SFMU"; // 資料管理アプリのAPIトークン
  const TARGET_FIELD_CODE = "lookup_doc";     // ルックアップ（チャット側）
  const SPACE_ID = "file_preview_space";      // スペース名
  const DOC_ID_FIELD = "documentID";          // 資料アプリ側のIDフィールドコード
  const FILE_FIELD_CODE = "file_attach";      // 資料アプリのファイル添付フィールドコード

  // 🔹 fileKeyを元にファイルのBlobをAPI経由で取得
  async function fetchFileBlob(fileKey) {
    const url = kintone.api.url('/k/v1/file', true) + '?fileKey=' + encodeURIComponent(fileKey);
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.responseType = 'blob';
      xhr.setRequestHeader('X-Cybozu-API-Token', API_TOKEN);
      xhr.onload = () => {
        if (xhr.status === 200) {
          resolve(xhr.response);
        } else {
          reject(new Error('HTTP ' + xhr.status));
        }
      };
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.send();
    });
  }

  kintone.events.on("app.record.detail.show", async (event) => {
    const record = event.record;
    const docId = record[TARGET_FIELD_CODE].value;
    const spaceEl = kintone.app.record.getSpaceElement(SPACE_ID);
    if (!spaceEl) {
      console.error("❌ スペース要素が見つかりません:", SPACE_ID);
      return event;
    }

    // 初期化
    spaceEl.innerHTML = "";

    if (!docId) {
      spaceEl.innerHTML = "<p style='color:gray'>ルックアップ未設定です。</p>";
      return event;
    }

    try {
      const query = `${DOC_ID_FIELD} = "${docId}"`;
      const res = await kintone.api(kintone.api.url("/k/v1/records", true), "GET", {
        app: APP_ID_DOCUMENTS,
        query,
        headers: { "X-Cybozu-API-Token": API_TOKEN }
      });

      if (res.records.length === 0) {
        spaceEl.innerHTML = "該当資料が見つかりません。";
        return event;
      }

      const fileField = res.records[0][FILE_FIELD_CODE];
      if (!fileField || fileField.value.length === 0) {
        spaceEl.innerHTML = "（ファイル未登録）";
        return event;
      }

      const fileInfo = fileField.value[0];
      const fileKey  = fileInfo.fileKey;
      const fileName = fileInfo.name;
      console.log("🔑 fileKey:", fileKey);

      // 🔹 fileKeyからBlobを取得
      const blob = await fetchFileBlob(fileKey);
      const objectUrl = URL.createObjectURL(blob);

      const isPdf = /\.pdf$/i.test(fileName);
      const html = `
        <a href="${objectUrl}" download="${fileName}" target="_blank" rel="noopener noreferrer">
          📎 ${fileName} を開く
        </a><br>
        ${isPdf ? `<iframe src="${objectUrl}" width="100%" height="400" style="border:none;"></iframe>` : ""}
        <p style="color:#888;font-size:12px;">※ fileKey経由で安全に表示中。</p>
      `;

      spaceEl.innerHTML = html;
      console.log("✅ プレビュー描画成功（Blob表示）");

      // メモリリーク防止
      window.addEventListener('beforeunload', () => URL.revokeObjectURL(objectUrl), { once: true });

    } catch (err) {
      console.error("❌ Blob取得エラー:", err);
      spaceEl.innerHTML = "ファイルの取得に失敗しました。APIトークンまたはfileKeyを確認してください。";
    }

    return event;
  });
})();
