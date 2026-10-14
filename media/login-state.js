'use strict';
function loginPresentation(connection = {}) {
  if (connection.loginComplete) return { hidden: false, required: false, title: '登入成功', text: '正在接續背景連線，可以關閉登入視窗。', action: '' };
  if (connection.ready) return { hidden: true, required: false, title: '', text: '', action: '' };
  if (connection.connecting) return { hidden: false, required: false, title: '正在確認 NTPU AI 連線', text: '正在檢查本機保存的登入狀態，請稍候。', action: '' };
  if (connection.loginWindow) return { hidden: false, required: true, title: '請完成學校登入', text: '登入視窗已開啟。完成登入後會自動轉為背景連線，你可以關閉視窗。', action: '返回登入視窗' };
  if (['required', 'signed_out'].includes(connection.authentication)) return { hidden: false, required: true, title: '尚未登入 NTPU AI', text: '登入後才能執行 AI 任務。請在學校登入視窗完成登入；完成後可關閉視窗，VS Code 會保持背景連線。', action: '登入 NTPU AI' };
  return { hidden: false, required: false, title: 'NTPU AI 尚未連線', text: '請重新連線以確認既有登入狀態。本機聊天紀錄會保留。', action: '重新連線' };
}
module.exports = { loginPresentation };
