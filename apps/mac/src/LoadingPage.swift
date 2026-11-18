import Foundation

/// 启动 / 失败时的本地加载页（纯内联 HTML + CSS，不加载任何外部资源）。
enum LoadingPage {
    static func html(status: String, detail: String) -> String {
        """
        <!doctype html>
        <html lang="zh-CN">
        <head>
        <meta charset="utf-8">
        <meta name="color-scheme" content="dark">
        <title>Super Work</title>
        <style>
          :root { color-scheme: dark; }
          html, body {
            margin: 0; height: 100%; background: #0a0b10; color: #e6e8f0;
            font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif;
            -webkit-user-select: none; user-select: none; overflow: hidden;
          }
          body {
            display: flex; align-items: center; justify-content: center;
            background:
              radial-gradient(900px 520px at 50% -12%, rgba(109, 94, 252, 0.20), transparent 62%),
              radial-gradient(700px 420px at 82% 108%, rgba(34, 211, 238, 0.10), transparent 60%),
              #0a0b10;
          }
          main { width: 420px; text-align: center; padding: 24px; }
          .mark {
            width: 84px; height: 84px; margin: 0 auto 22px;
            border-radius: 22px;
            background: linear-gradient(135deg, #8b5cf6 0%, #4d6bfe 55%, #22d3ee 100%);
            box-shadow: 0 18px 48px rgba(77, 107, 254, 0.35), inset 0 1px 0 rgba(255,255,255,0.35);
            display: flex; align-items: center; justify-content: center;
            font-size: 46px; font-weight: 700; color: #0a0b10;
            letter-spacing: -1px;
          }
          h1 { font-size: 19px; font-weight: 600; letter-spacing: 0.2px; margin: 0 0 10px; }
          .status { font-size: 13px; line-height: 1.7; color: #aab0c4; margin: 0 0 4px; min-height: 22px; }
          .detail { font-size: 12px; line-height: 1.7; color: #6b7288; margin: 0; min-height: 18px; word-break: break-word; }
          .bar {
            margin: 22px auto 14px; width: 220px; height: 3px; border-radius: 999px;
            background: rgba(255,255,255,0.07); overflow: hidden; position: relative;
          }
          .bar::after {
            content: ""; position: absolute; top: 0; left: -40%; height: 100%; width: 40%;
            border-radius: 999px; background: linear-gradient(90deg, transparent, #6d5efc, #22d3ee, transparent);
            animation: slide 1.5s ease-in-out infinite;
          }
          @keyframes slide { 0% { left: -40%; } 100% { left: 100%; } }
          .hint { font-size: 11px; color: #4c5266; margin-top: 26px; letter-spacing: 0.3px; }
        </style>
        </head>
        <body>
          <main>
            <div class="mark">S</div>
            <h1>Super Work</h1>
            <p class="status" id="status">\(escape(status))</p>
            <p class="detail" id="detail">\(escape(detail))</p>
            <div class="bar"></div>
            <p class="hint">本机多模型联合工作台 · 数据与凭证只留在本机</p>
          </main>
          <script>
            function setStatus(text) {
              var node = document.getElementById('status');
              if (node) node.textContent = text;
            }
            function setDetail(text) {
              var node = document.getElementById('detail');
              if (node) node.textContent = text;
            }
          </script>
        </body>
        </html>
        """
    }

    private static func escape(_ text: String) -> String {
        text
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }
}
