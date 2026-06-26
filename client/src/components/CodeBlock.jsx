import React, { useState } from 'react';

export default function CodeBlock({ text, label }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <div className="codeblock">
      <div className="codeblock-bar">
        {label && <span className="codeblock-label">{label}</span>}
        <button className="copy-btn" onClick={copy}>
          {copied ? '✓ Copied' : '⧉ Copy'}
        </button>
      </div>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}
