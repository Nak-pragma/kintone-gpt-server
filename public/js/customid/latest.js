(function() {
  "use strict";

  // レコード登録後（自動採番が確定したタイミング）に実行
  kintone.events.on('app.record.create.submit.success', async function(event) {
    const recordId = event.recordId;
    const appId = kintone.app.getId();

    // レコード番号と接頭語を取得
    const recordNumber = event.record.$id.value;
    const prefix = event.record.prefix.value || ""; // prefixが空なら空文字扱い

    // 接頭語 + ゼロ埋め4桁
    const customId = prefix + recordNumber.padStart(4, "0");

    // PUT APIで custom_id フィールドを更新
    const body = {
      app: appId,
      id: recordId,
      record: {
        custom_id: { value: customId }
      }
    };

    try {
      await kintone.api(kintone.api.url('/k/v1/record', true), 'PUT', body);
      console.log("✅ Custom ID 更新:", customId);
    } catch (err) {
      console.error("❌ Custom ID 更新失敗:", err);
    }

    return event;
  });
})();
