// Stylesheet for the pay host, served at GET /pay.css. Plain CSS only: the pay CSP is
// `style-src 'self'`, so nothing may be inlined and nothing here may @import another origin.
export const payCss = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body {
  margin: 0;
  min-width: 320px;
  background: #101314;
  color: #edf1f2;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  font-size: 16px;
  line-height: 1.6;
}
a { color: inherit; }
a:focus-visible, button:focus-visible { outline: 2px solid #d5e7ec; outline-offset: 4px; }
.wordmark {
  font-weight: 700;
  letter-spacing: .2em;
  font-size: 14px;
  padding: 24px 20px 0;
}
main { max-width: 480px; margin: 0 auto; padding: 32px 20px 48px; }
h1 { font-size: 22px; margin: 0 0 16px; }
.description { color: #a1aaad; margin: 0 0 24px; }
table { width: 100%; border-collapse: collapse; margin: 0 0 24px; }
th, td { text-align: left; padding: 10px 0; border-bottom: 1px solid rgba(220,232,237,.16); font-size: 16px; }
th:last-child, td:last-child { text-align: right; }
.amount-due {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: 18px;
  padding: 16px 0;
  border-top: 1px solid rgba(220,232,237,.16);
  margin: 0 0 24px;
}
form { margin: 0 0 16px; }
button {
  display: block;
  width: 100%;
  padding: 16px;
  font-size: 16px;
  font-weight: 600;
  background: #edf1f2;
  color: #101314;
  border: none;
  cursor: pointer;
}
button:hover { background: #fff; }
button:active { background: #d5e7ec; }
.note { color: #a1aaad; font-size: 14px; text-align: center; margin: 0; }
.status { font-size: 16px; color: #a1aaad; margin: 0 0 8px; }
.footer { color: #a1aaad; font-size: 12px; text-align: center; padding: 24px 20px; }
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
`;
