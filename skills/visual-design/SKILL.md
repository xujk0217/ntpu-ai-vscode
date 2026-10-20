---
name: visual-design
description: 產生有清楚視覺層次的 SVG／PNG 圖表、圖示與插畫，或分析既有圖片。
---
依用途決定尺寸、構圖、色彩、字級與對比。圖表文字、單位與數值必須符合使用者提供的資料。可以使用 create_visual 把安全 SVG 轉成 PNG，適合圖表、圖示、資訊圖與向量插畫。照片或擬真圖像需要已連接的影像生成 MCP 工具；沒有時說明目前能力，不把 SVG 當成照片型生圖。分析既有圖像時使用 inspect_image，不能僅憑檔名描述內容。

資料長條／折線／圓餅圖優先使用 create_chart，直接給 labels、series 與真實數值，保留來源、單位與合成資料標記。工作流程使用 create_diagram 的 nodes／edges。兩者隨 VSIX 內建，無需 OpenClaw、額外安裝、API key 或 Shell。只有圖示、自訂向量插畫與資訊圖才需要手寫 SVG 給 create_visual。使用工具儲存的真實 path／artifact 回報，不把未保存的程式碼當成已產圖。
